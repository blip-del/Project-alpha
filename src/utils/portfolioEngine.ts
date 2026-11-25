/**
 * Chronological Real Entry Price & Two-Bucket Engine + Unified Ticker-Centric Aggregator
 *
 * Implements the quantitative sequential cost pool math:
 * - Bucket A: Linked to Basis (Shares, Net Dividends, Covered Calls, CSPs)
 * - Bucket B: Standalone Trades (Speculative Long Calls/Puts, Unlinked Trades)
 * - Proportional cost pool reduction on partial stock sales
 * - Multi-currency FX conversion into Base Reporting Currency (EUR / USD)
 * - Real Entry Price, Downside Cushion %, Yield on Cost %
 * - Unified Ticker-Centric Rollup (Open P&L + Realized P&L = Total Ticker Net P&L, 100% reconciled with Top KPIs)
 */

import {
  Transaction,
  StockPosition,
  OptionCampaign,
  ChronologicalStep,
  DividendRecord,
  PortfolioSummary,
  BucketType,
  StockQuote,
  StandaloneOptionPosition,
  PositionMark,
  UnifiedTickerSummary,
  CampaignComparisonItem,
} from '../types';

export interface ProcessedPortfolio {
  positions: StockPosition[]; // Active stock positions (currentShares > 0)
  closedPositions: StockPosition[]; // Closed stock positions (currentShares === 0, had STK or LINKED trades)
  standalonePositions: StandaloneOptionPosition[];
  unifiedTickers: UnifiedTickerSummary[]; // All tickers unified (Active + Closed + Options-Only)
  summary: PortfolioSummary;
  tickerQuotes: Record<string, StockQuote>;
}

/**
 * Convert an amount from `fromCurrency` to `baseCurrency` using live/imported FX rates
 */
export function getFxMultiplier(
  fromCurrency: string,
  baseCurrency: 'EUR' | 'USD',
  fxRates: Record<string, number> = {},
  fallbackTxRate?: number
): number {
  const from = (fromCurrency || 'USD').toUpperCase();
  if (from === baseCurrency) return 1;

  const direct = fxRates[`${from}->${baseCurrency}`];
  if (direct && direct > 0) return direct;

  const inverse = fxRates[`${baseCurrency}->${from}`];
  if (inverse && inverse > 0) return 1 / inverse;

  if (fallbackTxRate && fallbackTxRate > 0 && fallbackTxRate !== 1) {
    if (from === 'EUR' && baseCurrency === 'USD') {
      return fallbackTxRate < 1 ? 1 / fallbackTxRate : fallbackTxRate;
    }
    return fallbackTxRate;
  }

  if (from === 'USD' && baseCurrency === 'EUR') return 0.91;
  if (from === 'EUR' && baseCurrency === 'USD') return 1.099;
  return 1;
}

/**
 * Calculate Downside Cushion % cleanly across both in-profit and underwater positions:
 * - When Spot >= Real Entry (positive buffer): (Spot - Real Entry) / Spot * 100 (capped at 100% if Real Entry <= 0)
 * - When Spot < Real Entry (below breakeven): (Spot - Real Entry) / Real Entry * 100 (bounded in (-100%, 0%])
 */
export function calculateDownsideCushionPct(spotPrice: number, realEntryPrice: number): number {
  if (spotPrice <= 0) return 0;
  if (realEntryPrice <= 0) return 100;
  if (spotPrice >= realEntryPrice) {
    return ((spotPrice - realEntryPrice) / spotPrice) * 100;
  }
  return ((spotPrice - realEntryPrice) / realEntryPrice) * 100;
}

/**
 * Newton-Raphson XIRR with bracketed bisection fallback
 */
export function calculateXIRR(cashFlows: Array<{ date: string; amount: number }>): number {
  if (cashFlows.length < 2) return 0;

  const sorted = cashFlows
    .filter((cf) => Math.abs(cf.amount) > 0.0001 && cf.date)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  if (sorted.length < 2) return 0;

  const hasPositive = sorted.some((cf) => cf.amount > 0);
  const hasNegative = sorted.some((cf) => cf.amount < 0);
  if (!hasPositive || !hasNegative) return 0;

  const d0 = new Date(sorted[0].date).getTime();
  const yearFractions = sorted.map((cf) => {
    const dt = new Date(cf.date).getTime();
    return Math.max(0, (dt - d0) / (86400000 * 365));
  });

  // Guard zero time span
  if (Math.max(...yearFractions) < 1 / 365) return 0;

  const f = (r: number): number => {
    let sum = 0;
    for (let i = 0; i < sorted.length; i++) {
      const frac = yearFractions[i];
      const base = 1 + r;
      if (base <= 0) return 1e9;
      sum += sorted[i].amount / Math.pow(base, frac);
    }
    return sum;
  };

  const df = (r: number): number => {
    let sum = 0;
    for (let i = 0; i < sorted.length; i++) {
      const frac = yearFractions[i];
      const base = 1 + r;
      if (base <= 0) return -1e9;
      sum -= (frac * sorted[i].amount) / Math.pow(base, frac + 1);
    }
    return sum;
  };

  let r = 0.12;
  for (let iter = 0; iter < 60; iter++) {
    const y = f(r);
    const dy = df(r);
    if (Math.abs(dy) < 1e-12) break;
    const nextR = r - y / dy;
    if (isNaN(nextR) || !isFinite(nextR)) break;
    if (Math.abs(nextR - r) < 1e-6) {
      const clamped = Math.max(-0.999, Math.min(9.99, nextR));
      if (Math.abs(f(clamped)) < 1e-1) {
        return Number((clamped * 100).toFixed(2));
      }
      break;
    }
    r = Math.max(-0.99, Math.min(9.99, nextR));
  }

  // Fallback bisection on [-0.99, 9.99]
  let lo = -0.99;
  let hi = 9.99;
  let fLo = f(lo);
  let fHi = f(hi);
  if (fLo * fHi <= 0) {
    for (let iter = 0; iter < 50; iter++) {
      const mid = (lo + hi) / 2;
      const fMid = f(mid);
      if (Math.abs(fMid) < 1e-4 || hi - lo < 1e-6) {
        return Number((mid * 100).toFixed(2));
      }
      if (fLo * fMid <= 0) {
        hi = mid;
        fHi = fMid;
      } else {
        lo = mid;
        fLo = fMid;
      }
    }
    return Number((((lo + hi) / 2) * 100).toFixed(2));
  }

  return Number((r * 100).toFixed(2));
}

function computeSafeAnnualizedReturn(
  trades: Transaction[],
  terminalMarketValueBase: number,
  capitalDeployedBase: number,
  netPnlBase: number,
  isOpen: boolean,
  baseCurrency: 'EUR' | 'USD',
  fxRates: Record<string, number>,
  fallbackFxToBase: number
): { annualizedReturnPct: number | null; holdingDays: number; isShortDuration: boolean } {
  const dated = trades
    .map((t) => ({
      date: t.date || t.dateTime.slice(0, 10),
      ms: new Date(t.date || t.dateTime.slice(0, 10)).getTime(),
      amountBase: t.netCashFlow * getFxMultiplier(t.currency, baseCurrency, fxRates, t.fxRateToBase || fallbackFxToBase),
    }))
    .filter((d) => !isNaN(d.ms) && d.date.length >= 10)
    .sort((a, b) => a.ms - b.ms);

  if (dated.length === 0) {
    return { annualizedReturnPct: null, holdingDays: 0, isShortDuration: false };
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const endDateStr = isOpen ? (todayStr >= dated[dated.length - 1].date ? todayStr : dated[dated.length - 1].date) : dated[dated.length - 1].date;
  const endMs = new Date(endDateStr).getTime();
  const startMs = dated[0].ms;
  const holdingDays = Math.max(0, Math.round((endMs - startMs) / 86400000));
  const isShortDuration = holdingDays < 30;

  if (holdingDays === 0) {
    return { annualizedReturnPct: null, holdingDays: 0, isShortDuration: true };
  }

  // For >= 30 days on debit-opened positions (initial outflow < 0), compute money-weighted XIRR
  const isCreditOpened = dated[0].amountBase > 0.01;
  if (holdingDays >= 30 && !isCreditOpened) {
    const cfs = dated.map((d) => ({ date: d.date, amount: d.amountBase }));
    if (isOpen && Math.abs(terminalMarketValueBase) > 0.01) {
      cfs.push({ date: endDateStr, amount: terminalMarketValueBase });
    }
    const hasNeg = cfs.some((c) => c.amount < -0.01);
    const hasPos = cfs.some((c) => c.amount > 0.01);
    if (hasNeg && hasPos) {
      const xirr = calculateXIRR(cfs);
      const signMismatch =
        (netPnlBase < -0.01 && xirr > 0.01) || (netPnlBase > 0.01 && xirr < -0.01);
      if (isFinite(xirr) && !signMismatch) {
        return {
          annualizedReturnPct: Math.max(-99.9, Math.min(999, xirr)),
          holdingDays,
          isShortDuration: false,
        };
      }
    }
  }

  // For short-duration (< 30 days), credit-opened options/strategies, or sign-divergent XIRR:
  // annualize Return on Capital/Collateral over a 30-day minimum floor
  if (capitalDeployedBase > 0.01) {
    const roi = netPnlBase / capitalDeployedBase;
    const effectiveDays = Math.max(30, holdingDays);
    const ann = roi * (365 / effectiveDays) * 100;
    return {
      annualizedReturnPct: Number(Math.max(-99.9, Math.min(999, ann)).toFixed(1)),
      holdingDays,
      isShortDuration,
    };
  }

  return { annualizedReturnPct: null, holdingDays, isShortDuration };
}

/**
 * Main calculation engine processing all transactions into chronological portfolio state
 */
export function calculatePortfolioState(
  transactions: Transaction[],
  bucketOverrides: Record<string, BucketType> = {},
  liveQuotes: Record<string, StockQuote> = {},
  baseCurrency: 'EUR' | 'USD' = 'EUR',
  fxRates: Record<string, number> = {},
  positionMarks: Record<string, PositionMark> = {}
): ProcessedPortfolio {
  const effectiveTransactions = transactions.map((tx) => ({
    ...tx,
    bucket: bucketOverrides[tx.id] || tx.bucket || tx.defaultBucket || 'LINKED',
  }));

  const tickerMap = new Map<string, Transaction[]>();
  const standaloneOptionMap = new Map<string, Transaction[]>();

  for (const tx of effectiveTransactions) {
    const underlying = tx.underlying || tx.symbol;
    if (!tickerMap.has(underlying)) {
      tickerMap.set(underlying, []);
    }
    tickerMap.get(underlying)!.push(tx);

    if (tx.assetCategory === 'OPT' && tx.bucket === 'STANDALONE') {
      const optKey = tx.symbol;
      if (!standaloneOptionMap.has(optKey)) {
        standaloneOptionMap.set(optKey, []);
      }
      standaloneOptionMap.get(optKey)!.push(tx);
    }
  }

  const positions: StockPosition[] = [];
  const closedPositions: StockPosition[] = [];
  const unifiedTickers: UnifiedTickerSummary[] = [];

  let totalStockMarketValue = 0;
  let totalOpenLinkedOptionsValue = 0;
  let totalRawCostBasis = 0;
  let totalAdjustedCostBasis = 0;
  let totalRealizedStockPnl = 0;
  let totalNetDividends = 0;
  let totalLinkedOptionPremiums = 0;
  let totalActiveOpenPnlBase = 0;
  let totalRealizedAllPnlBase = 0;
  let shortPutCollateralBase = 0;

  const now = new Date();

  // Process each underlying ticker chronologically
  for (const [ticker, txList] of tickerMap.entries()) {
    const sorted = [...txList].sort((a, b) => {
      const tA = new Date(a.dateTime).getTime() || 0;
      const tB = new Date(b.dateTime).getTime() || 0;
      if (tA !== tB) return tA - tB;
      const rank: Record<string, number> = { STK: 1, CORP_ACTION: 2, OPT: 3, DIV: 4, TAX: 5, CASH: 6 };
      return (rank[a.assetCategory] || 9) - (rank[b.assetCategory] || 9);
    });

    const stkTrades = sorted.filter((t) => t.assetCategory === 'STK');
    const primaryCurrency = stkTrades[0]?.currency || positionMarks[ticker]?.currency || sorted[0]?.currency || 'USD';
    const curSym = primaryCurrency === 'EUR' ? '€' : '$';
    const tickerFxToBase = getFxMultiplier(primaryCurrency, baseCurrency, fxRates, stkTrades[0]?.fxRateToBase || sorted[0]?.fxRateToBase);

    let currentShares = 0;
    let runningRawCostPool = 0;
    let runningAdjustedCostPool = 0;
    let tickerRealizedStockPnl = 0;
    let tickerRealizedStockPnlBase = 0;
    let totalStockGrossBuyNative = 0;
    let peakStockCostNative = 0;
    let tickerGrossDividends = 0;
    let tickerWithholdingTax = 0;
    let tickerNetDividendsBase = 0;
    let tickerLinkedPremiums = 0;

    const timeline: ChronologicalStep[] = [];
    const dividendsMap = new Map<string, DividendRecord>();
    const optionCampaignsMap = new Map<string, Transaction[]>();

    for (const tx of sorted) {
      const isLinked = tx.bucket === 'LINKED';
      const txFxToBase = getFxMultiplier(tx.currency, baseCurrency, fxRates, tx.fxRateToBase);
      const txToStockFx = tx.currency === primaryCurrency ? 1 : txFxToBase / tickerFxToBase;

      // 1. STOCK BUY / SELL / SPLIT
      if (tx.assetCategory === 'STK') {
        const qty = tx.quantity;
        const price = tx.price;
        const comm = Math.abs(tx.commission || 0);

        if (qty > 0) {
          const buyCost = tx.netCashFlow < 0 ? Math.abs(tx.netCashFlow) : qty * price + comm;
          const rawBefore = runningRawCostPool;
          const adjBefore = runningAdjustedCostPool;
          const sharesBefore = currentShares;

          runningRawCostPool += buyCost;
          runningAdjustedCostPool += buyCost;
          currentShares += qty;
          totalStockGrossBuyNative += buyCost;
          if (runningRawCostPool > peakStockCostNative) peakStockCostNative = runningRawCostPool;

          timeline.push({
            date: tx.date,
            tradeId: tx.tradeId,
            actionDesc: `BUY +${qty} shares @ ${curSym}${price.toFixed(2)}`,
            impactType: 'BUY',
            sharesBefore,
            sharesAfter: currentShares,
            rawPoolBefore: rawBefore,
            rawPoolAfter: runningRawCostPool,
            adjustedPoolBefore: adjBefore,
            adjustedPoolAfter: runningAdjustedCostPool,
            rawAvgCostAfter: currentShares > 0 ? runningRawCostPool / currentShares : 0,
            realEntryPriceAfter: currentShares > 0 ? runningAdjustedCostPool / currentShares : 0,
            impactAmount: buyCost,
            notes: tx.notes || `Cost: ${curSym}${buyCost.toFixed(2)} (incl ${curSym}${comm.toFixed(2)} comm)`,
          });
        } else if (qty < 0) {
          const soldQty = Math.abs(qty);
          const proceeds = tx.netCashFlow > 0 ? tx.netCashFlow : soldQty * price - comm;
          const sharesBefore = currentShares;
          const rawBefore = runningRawCostPool;
          const adjBefore = runningAdjustedCostPool;

          if (sharesBefore > 0) {
            const ratio = Math.min(1.0, soldQty / sharesBefore);
            const rawCostOfSharesSold = rawBefore * ratio;
            const realizedTradePnl = proceeds - rawCostOfSharesSold;
            tickerRealizedStockPnl += realizedTradePnl;
            tickerRealizedStockPnlBase += realizedTradePnl * tickerFxToBase;

            runningRawCostPool = Math.max(0, runningRawCostPool * (1 - ratio));
            runningAdjustedCostPool = Math.max(0, runningAdjustedCostPool * (1 - ratio));
            currentShares = Math.max(0, currentShares - soldQty);

            timeline.push({
              date: tx.date,
              tradeId: tx.tradeId,
              actionDesc: `SELL -${soldQty} shares @ ${curSym}${price.toFixed(2)}`,
              impactType: 'SELL',
              sharesBefore,
              sharesAfter: currentShares,
              rawPoolBefore: rawBefore,
              rawPoolAfter: runningRawCostPool,
              adjustedPoolBefore: adjBefore,
              adjustedPoolAfter: runningAdjustedCostPool,
              rawAvgCostAfter: currentShares > 0 ? runningRawCostPool / currentShares : 0,
              realEntryPriceAfter: currentShares > 0 ? runningAdjustedCostPool / currentShares : 0,
              impactAmount: proceeds,
              notes: `Realized P&L: ${realizedTradePnl >= 0 ? '+' : ''}${curSym}${realizedTradePnl.toFixed(2)} (${(ratio * 100).toFixed(1)}% trimmed)`,
            });
          }
        }
      }

      // 2. CORPORATE ACTIONS (Splits)
      else if (tx.assetCategory === 'CORP_ACTION' && tx.action === 'SPLIT') {
        const ratio = tx.corporateAction?.ratio || tx.quantity || 1;
        if (ratio > 0 && currentShares > 0) {
          const sharesBefore = currentShares;
          currentShares = currentShares * ratio;

          timeline.push({
            date: tx.date,
            tradeId: tx.tradeId,
            actionDesc: `FORWARD SPLIT ${ratio}:1 (${sharesBefore} -> ${currentShares} shares)`,
            impactType: 'SPLIT',
            sharesBefore,
            sharesAfter: currentShares,
            rawPoolBefore: runningRawCostPool,
            rawPoolAfter: runningRawCostPool,
            adjustedPoolBefore: runningAdjustedCostPool,
            adjustedPoolAfter: runningAdjustedCostPool,
            rawAvgCostAfter: runningRawCostPool / currentShares,
            realEntryPriceAfter: runningAdjustedCostPool / currentShares,
            impactAmount: 0,
            notes: `Share count multiplied by ${ratio}. Cost basis per share adjusted accordingly.`,
          });
        }
      }

      // 3. DIVIDENDS & WITHHOLDING TAXES
      else if (tx.assetCategory === 'DIV' || tx.assetCategory === 'TAX') {
        const isTax = tx.assetCategory === 'TAX' || tx.action === 'TAX';
        const amtNative = Math.abs(tx.price || tx.proceeds || 0);
        const amtInStockCur = amtNative * txToStockFx;
        const signedBase = (isTax ? -amtNative : amtNative) * txFxToBase;

        tickerNetDividendsBase += signedBase;
        if (!isTax) {
          tickerGrossDividends += amtInStockCur;
        } else {
          tickerWithholdingTax += amtInStockCur;
        }

        const divKey = `${tx.date}_${tx.underlying}`;
        const existing = dividendsMap.get(divKey) || {
          id: divKey,
          date: tx.date,
          grossAmount: 0,
          withholdingTax: 0,
          netAmount: 0,
          currency: tx.currency,
          fxRateToBase: tx.fxRateToBase || 1,
          description: tx.notes || `Dividend ${tx.underlying}`,
        };

        if (!isTax) {
          existing.grossAmount += amtNative;
        } else {
          existing.withholdingTax += amtNative;
        }
        existing.netAmount = Math.max(0, existing.grossAmount - existing.withholdingTax);
        dividendsMap.set(divKey, existing);

        if (isLinked) {
          const netCredit = !isTax ? amtInStockCur : -amtInStockCur;
          const adjBefore = runningAdjustedCostPool;
          runningAdjustedCostPool -= netCredit;

          timeline.push({
            date: tx.date,
            tradeId: tx.tradeId,
            actionDesc: !isTax
              ? `DIVIDEND Received +${curSym}${amtInStockCur.toFixed(2)}`
              : `TAX Withheld -${curSym}${amtInStockCur.toFixed(2)}`,
            impactType: 'DIVIDEND',
            sharesBefore: currentShares,
            sharesAfter: currentShares,
            rawPoolBefore: runningRawCostPool,
            rawPoolAfter: runningRawCostPool,
            adjustedPoolBefore: adjBefore,
            adjustedPoolAfter: runningAdjustedCostPool,
            rawAvgCostAfter: currentShares > 0 ? runningRawCostPool / currentShares : 0,
            realEntryPriceAfter: currentShares > 0 ? runningAdjustedCostPool / currentShares : 0,
            impactAmount: netCredit,
            notes: tx.notes || (!isTax ? `Gross Dividend: +${curSym}${amtInStockCur.toFixed(2)}` : `Tax Withholding: -${curSym}${amtInStockCur.toFixed(2)}`),
          });
        }
      }

      // 4. OPTIONS (Bucket A Linked vs Bucket B Standalone)
      else if (tx.assetCategory === 'OPT') {
        const campaignKey = tx.symbol;
        if (!optionCampaignsMap.has(campaignKey)) {
          optionCampaignsMap.set(campaignKey, []);
        }
        optionCampaignsMap.get(campaignKey)!.push(tx);

        const netCashInStockCur = tx.netCashFlow * txToStockFx;

        if (isLinked) {
          const adjBefore = runningAdjustedCostPool;
          runningAdjustedCostPool -= netCashInStockCur;
          tickerLinkedPremiums += netCashInStockCur;

          const isCredit = netCashInStockCur >= 0;
          timeline.push({
            date: tx.date,
            tradeId: tx.tradeId,
            actionDesc: `${tx.action} ${tx.symbol} (${isCredit ? '+' : ''}${curSym}${netCashInStockCur.toFixed(2)})`,
            impactType: isCredit ? 'OPTION_PREMIUM' : 'OPTION_DEBIT',
            sharesBefore: currentShares,
            sharesAfter: currentShares,
            rawPoolBefore: runningRawCostPool,
            rawPoolAfter: runningRawCostPool,
            adjustedPoolBefore: adjBefore,
            adjustedPoolAfter: runningAdjustedCostPool,
            rawAvgCostAfter: currentShares > 0 ? runningRawCostPool / currentShares : 0,
            realEntryPriceAfter: currentShares > 0 ? runningAdjustedCostPool / currentShares : 0,
            impactAmount: netCashInStockCur,
            notes: `[🔗 Linked to Basis] ${tx.notes || (isCredit ? 'Premium Credit Inflow' : 'Closing Debit Paid')}`,
          });
        }
      }
    }

    // Resolve Spot Price early so campaigns can compute strike cushion accurately
    const mark = positionMarks[ticker];
    const yahooQuote = liveQuotes[ticker];
    const fallbackSpot =
      mark?.markPrice ||
      (currentShares > 0 && runningRawCostPool > 0
        ? runningRawCostPool / currentShares
        : stkTrades.length > 0
        ? stkTrades[stkTrades.length - 1].price
        : 0);

    const canUseYahoo =
      yahooQuote &&
      yahooQuote.regularMarketPrice > 0 &&
      (primaryCurrency === 'USD' || Boolean(mark?.listingExchange && yahooQuote.exchange));

    const spotPrice = canUseYahoo ? yahooQuote.regularMarketPrice : fallbackSpot;
    const spotChange = canUseYahoo ? yahooQuote.regularMarketChange || 0 : 0;
    const spotChangePct = canUseYahoo ? yahooQuote.regularMarketChangePercent || 0 : 0;

    // Process Option Campaigns for this ticker
    const linkedCampaigns: OptionCampaign[] = [];
    const standaloneCampaigns: OptionCampaign[] = [];
    const comparisonItems: CampaignComparisonItem[] = [];

    let openOptionsMvInStockCur = 0;
    let openOptionsMvBase = 0;
    let openOptionsUnrealizedInStockCur = 0;
    let openOptionsUnrealizedBase = 0;
    let realizedOptionsInStockCur = 0;
    let realizedOptionsBase = 0;
    let openOptionsCapitalAtRiskInStockCur = 0;
    let openOptionsCapitalAtRiskBase = 0;
    let closedOptionsPeakOutlayBase = 0;
    let openOptionCountForTicker = 0;

    for (const [contractSymbol, allSymbolTrades] of optionCampaignsMap.entries()) {
      // Split option trades on the same contract into flat-to-flat cycles so re-entering a contract
      // creates a clean new cycle and toggling Linked <-> Standalone never alters the campaign ID.
      const optionCycles: Transaction[][] = [];
      let activeCycleTrades: Transaction[] = [];
      let runningCycleNet = 0;
      for (const tr of allSymbolTrades) {
        activeCycleTrades.push(tr);
        runningCycleNet += tr.quantity;
        if (Math.abs(runningCycleNet) < 1e-6) {
          runningCycleNet = 0;
          optionCycles.push(activeCycleTrades);
          activeCycleTrades = [];
        }
      }
      if (activeCycleTrades.length > 0) {
        optionCycles.push(activeCycleTrades);
      }

      const optDateCounts = new Map<string, number>();

      for (let cycleIdx = 0; cycleIdx < optionCycles.length; cycleIdx++) {
        const trades = optionCycles[cycleIdx];
        const cycleStartDate = trades[0]?.date || trades[0]?.dateTime?.slice(0, 10) || 'unknown';
        const seq = (optDateCounts.get(cycleStartDate) || 0) + 1;
        optDateCounts.set(cycleStartDate, seq);
        const stableCampaignId =
          seq > 1 ? `opt::${contractSymbol}::${cycleStartDate}::${seq}` : `opt::${contractSymbol}::${cycleStartDate}`;
        const legacyIds =
          cycleIdx === 0
            ? [`camp-${contractSymbol}-LINKED`, `camp-${contractSymbol}-STANDALONE`, `standalone-${contractSymbol}`]
            : undefined;

        let netContracts = 0;
        let totalCredits = 0;
        let totalDebits = 0;
        let netCashFlow = 0;
        let ibkrRealizedSum = 0;
        let hasIbkrRealized = false;
        let optType: 'CALL' | 'PUT' = 'CALL';
        let strike = 0;
        let expiry = '';
        let linkedCount = 0;
        let standaloneCount = 0;
        const multiplier = trades[0]?.multiplier || 100;
        const optCurrency = trades[0]?.currency || primaryCurrency;
        const optFxToBase = getFxMultiplier(optCurrency, baseCurrency, fxRates, trades[0]?.fxRateToBase);
        const optToStockFx = optCurrency === primaryCurrency ? 1 : optFxToBase / tickerFxToBase;

        for (const tr of trades) {
          if (tr.bucket === 'LINKED') linkedCount++;
          else standaloneCount++;
          netContracts += tr.quantity;
          if (tr.netCashFlow > 0) totalCredits += tr.netCashFlow;
          else totalDebits += Math.abs(tr.netCashFlow);
          netCashFlow += tr.netCashFlow;
          if (tr.realizedPnl !== undefined && tr.realizedPnl !== 0) {
            ibkrRealizedSum += tr.realizedPnl;
            hasIbkrRealized = true;
          }

          if (tr.optionDetails) {
            optType = tr.optionDetails.type;
            strike = tr.optionDetails.strike;
            expiry = tr.optionDetails.expiry;
          }
        }

        const bucket: BucketType =
          linkedCount > 0 && standaloneCount === 0
            ? 'LINKED'
            : standaloneCount > 0 && linkedCount === 0
            ? 'STANDALONE'
            : trades[0]?.bucket || 'LINKED';

        if (Math.abs(netContracts) < 1e-6) netContracts = 0;
        const isClosed = netContracts === 0;

        // Closed option realized P&L is always exact cumulative cash inflow minus outflow (handles IBKR expired options where fifoPnlRealized=0)
        const realizedPnl = isClosed ? netCashFlow : hasIbkrRealized ? ibkrRealizedSum : 0;

        const optMark = !isClosed ? positionMarks[contractSymbol] : undefined;
        // Open cost basis (signed: positive for Long debit, negative for Short credit)
        const openCostBasis = isClosed
          ? 0
          : optMark && optMark.costBasisMoney !== 0
          ? optMark.costBasisMoney
          : -(netCashFlow - realizedPnl);

        const avgEntryPerShare =
          !isClosed && Math.abs(netContracts) > 0
            ? Math.abs(openCostBasis) / (Math.abs(netContracts) * multiplier)
            : 0;

        const currentMarkPrice = isClosed ? 0 : optMark?.markPrice ?? avgEntryPerShare;
        const marketValue = isClosed ? 0 : netContracts * currentMarkPrice * multiplier;
        const unrealizedPnl = isClosed
          ? 0
          : optMark
          ? optMark.fifoPnlUnrealized
          : marketValue - openCostBasis;

        const status: 'OPEN' | 'CLOSED' | 'EXPIRED' | 'ASSIGNED' = isClosed ? 'CLOSED' : 'OPEN';

        if (!isClosed) {
          openOptionCountForTicker += 1;
          openOptionsMvInStockCur += marketValue * optToStockFx;
          openOptionsMvBase += marketValue * optFxToBase;
          openOptionsUnrealizedInStockCur += unrealizedPnl * optToStockFx;
          openOptionsUnrealizedBase += unrealizedPnl * optFxToBase;

          if (bucket === 'LINKED') {
            totalOpenLinkedOptionsValue += marketValue * optFxToBase;
          }

          // Collateral for Short Puts
          if (optType === 'PUT' && netContracts < 0) {
            shortPutCollateralBase += strike * multiplier * Math.abs(netContracts) * optFxToBase;
          }
        }

        realizedOptionsInStockCur += realizedPnl * optToStockFx;
        realizedOptionsBase += realizedPnl * optFxToBase;

        const campaign: OptionCampaign = {
          id: stableCampaignId,
          underlying: ticker,
          contractSymbol,
          type: optType,
          strike,
          expiry,
          multiplier,
          currency: optCurrency,
          bucket,
          trades,
          netContracts,
          totalCredits,
          totalDebits,
          netCashFlow,
          realizedPnl,
          openCostBasis,
          currentMarkPrice: isClosed ? undefined : currentMarkPrice,
          marketValue,
          unrealizedPnl,
          status,
          isCurrentCoveredCall: netContracts < 0 && optType === 'CALL',
        };

        if (bucket === 'LINKED') {
          linkedCampaigns.push(campaign);
        } else {
          standaloneCampaigns.push(campaign);
        }

      // Build CampaignComparisonItem
      const openingAction = trades[0]?.action || (netContracts < 0 ? 'SELL' : 'BUY');
      const isShort = netContracts < 0 || (isClosed && openingAction === 'SELL');
      const strategyType = isShort
        ? optType === 'CALL'
          ? currentShares > 0 || bucket === 'LINKED'
            ? 'Covered Call'
            : 'Short Call'
          : 'Cash-Secured Put'
        : optType === 'CALL'
        ? 'Long Call'
        : 'Long Put';

      // Capital deployed for campaign ROI & exposure:
      // Long options -> total debit outlay (or open cost basis)
      // Short Put -> strike collateral (strike * mult * abs(contracts))
      // Short Call -> covered by stock (if shares > 0 use strike/basis ref, else strike * mult)
      const contractCountForCap = isClosed
        ? Math.max(
            1,
            trades.filter((t) => (openingAction === 'SELL' ? t.quantity < 0 : t.quantity > 0)).reduce((s, t) => s + Math.abs(t.quantity), 0)
          )
        : Math.abs(netContracts);
      const campaignCapNative =
        openingAction === 'BUY' && !isShort
          ? Math.max(totalDebits, Math.abs(openCostBasis))
          : optType === 'PUT'
          ? strike * multiplier * contractCountForCap
          : strike > 0
          ? Math.max(totalCredits, Math.min(strike * multiplier * contractCountForCap, (spotPrice > 0 ? spotPrice : strike) * multiplier * contractCountForCap))
          : Math.max(totalCredits, totalDebits);

      if (!isClosed) {
        const atRiskNative = netContracts > 0 ? Math.max(0, openCostBasis) : optType === 'PUT' ? strike * multiplier * Math.abs(netContracts) : 0;
        openOptionsCapitalAtRiskInStockCur += atRiskNative * optToStockFx;
        openOptionsCapitalAtRiskBase += atRiskNative * optFxToBase;
      } else {
        closedOptionsPeakOutlayBase += campaignCapNative * optFxToBase;
      }

      const campTotalNetNative = realizedPnl + unrealizedPnl;
      const campTotalNetBase = campTotalNetNative * optFxToBase;
      const campCapBase = campaignCapNative * optFxToBase;
      const campRoiPct = campCapBase > 0 ? (campTotalNetBase / campCapBase) * 100 : 0;

      let dte: number | undefined;
      if (!isClosed && expiry) {
        const expMs = new Date(expiry).getTime();
        if (!isNaN(expMs)) {
          dte = Math.max(0, Math.round((expMs - now.getTime()) / 86400000));
        }
      }

      let strikeCushionPct: number | undefined;
      if (!isClosed && spotPrice > 0 && strike > 0) {
        if (isShort) {
          strikeCushionPct = optType === 'CALL' ? ((strike - spotPrice) / spotPrice) * 100 : ((spotPrice - strike) / spotPrice) * 100;
        } else {
          strikeCushionPct = optType === 'CALL' ? ((spotPrice - strike) / spotPrice) * 100 : ((strike - spotPrice) / spotPrice) * 100;
        }
      }

      const campRet = computeSafeAnnualizedReturn(
        trades,
        marketValue * optFxToBase,
        campCapBase,
        campTotalNetBase,
        !isClosed,
        baseCurrency,
        fxRates,
        optFxToBase
      );

        comparisonItems.push({
          id: campaign.id,
          kind: 'OPTION_CAMPAIGN',
          contractSymbol,
          title: `${expiry ? expiry.slice(2).replace(/-/g, '') : ''} ${optCurrency === 'EUR' ? '€' : '$'}${strike} ${optType === 'CALL' ? 'C' : 'P'}`.trim(),
          strategyType,
          bucket,
          canToggleBucket: true,
          transactionIds: trades.map((t) => t.id),
          status: isClosed ? 'CLOSED' : 'OPEN',
          dte,
          expiry,
          strike,
          optionType: optType,
          netContracts,
          strikeCushionPct: strikeCushionPct !== undefined ? Number(strikeCushionPct.toFixed(1)) : undefined,
          currency: optCurrency,
          capitalDeployedNative: campaignCapNative,
          capitalDeployedBase: campCapBase,
          netCashNative: netCashFlow,
          realizedPnlNative: realizedPnl,
          unrealizedPnlNative: unrealizedPnl,
          netPnlNative: campTotalNetNative,
          netPnlBase: campTotalNetBase,
          tradeRoiPct: Number(campRoiPct.toFixed(1)),
          annualizedReturnPct: campRet.annualizedReturnPct,
          holdingDays: campRet.holdingDays,
          trades,
          legacyIds,
        });
      }
    }

    // Equity calculations
    const rawAvgEntry = currentShares > 0 ? runningRawCostPool / currentShares : 0;
    const realEntryPrice = currentShares > 0 ? runningAdjustedCostPool / currentShares : 0;
    const marketValue = currentShares * spotPrice;

    const unrealizedPnlRaw = marketValue - runningRawCostPool;
    const unrealizedPnlReal = marketValue - runningAdjustedCostPool;
    const unrealizedPnlRealPct = runningAdjustedCostPool > 0 ? (unrealizedPnlReal / runningAdjustedCostPool) * 100 : 0;

    const downsideCushionDollar = spotPrice - realEntryPrice;
    const downsideCushionPct =
      spotPrice > 0 && currentShares > 0
        ? calculateDownsideCushionPct(spotPrice, realEntryPrice)
        : 0;

    const basisReductionDollar = rawAvgEntry - realEntryPrice;
    const basisReductionPct = rawAvgEntry > 0 ? ((rawAvgEntry - realEntryPrice) / rawAvgEntry) * 100 : 0;

    const netDividends = Math.max(0, tickerGrossDividends - tickerWithholdingTax);
    const annualizedIncome = netDividends + tickerLinkedPremiums;
    const yieldOnCostPct = runningRawCostPool > 0 ? (annualizedIncome / runningRawCostPool) * 100 : 0;

    const companyName =
      (canUseYahoo ? yahooQuote.shortName : undefined) ||
      stkTrades[0]?.notes ||
      sorted.find((t) => t.notes && !t.notes.includes(' C') && !t.notes.includes(' P'))?.notes ||
      `${ticker}`;

    const position: StockPosition = {
      ticker,
      companyName,
      currency: primaryCurrency,
      listingExchange: mark?.listingExchange || stkTrades[0]?.listingExchange,
      currentShares,
      rawCostPool: runningRawCostPool,
      adjustedCostPool: runningAdjustedCostPool,
      rawAvgEntry,
      realEntryPrice,
      spotPrice,
      spotChange,
      spotChangePct,
      marketValue,
      unrealizedPnlRaw,
      unrealizedPnlReal,
      unrealizedPnlRealPct,
      downsideCushionDollar,
      downsideCushionPct,
      basisReductionDollar,
      basisReductionPct,
      totalDividendsGross: tickerGrossDividends,
      totalWithholdingTax: tickerWithholdingTax,
      totalDividendsNet: netDividends,
      totalLinkedPremiums: tickerLinkedPremiums,
      totalRealizedStockPnl: tickerRealizedStockPnl,
      yieldOnCostPct,
      transactions: sorted,
      timeline,
      linkedOptionCampaigns: linkedCampaigns,
      standaloneOptionCampaigns: standaloneCampaigns,
      activeCoveredCalls: linkedCampaigns.filter((c) => c.isCurrentCoveredCall && c.status === 'OPEN'),
      dividends: Array.from(dividendsMap.values()).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    };

    totalRealizedStockPnl += tickerRealizedStockPnlBase;
    totalNetDividends += tickerNetDividendsBase;
    totalLinkedOptionPremiums += tickerLinkedPremiums * tickerFxToBase;

    if (currentShares > 0) {
      positions.push(position);
      totalStockMarketValue += marketValue * tickerFxToBase;
      totalRawCostBasis += runningRawCostPool * tickerFxToBase;
      totalAdjustedCostBasis += runningAdjustedCostPool * tickerFxToBase;
    } else if (stkTrades.length > 0 || linkedCampaigns.length > 0) {
      closedPositions.push(position);
    }

    // Add Stock Lots (split into flat-to-flat cycles with stable stk::TICKER::entryDate IDs) into CampaignComparisonItem list
    if (stkTrades.length > 0) {
      interface RawStockCycle {
        startDate: string;
        trades: Transaction[];
        shares: number;
        rawPool: number;
        peakCost: number;
        grossBuy: number;
        realizedPnl: number;
        realizedPnlBase: number;
        isOpen: boolean;
      }

      const stockCycles: RawStockCycle[] = [];
      let activeCycle: RawStockCycle | null = null;
      const stkAndSplitTxs = sorted.filter(
        (t) => t.assetCategory === 'STK' || (t.assetCategory === 'CORP_ACTION' && t.action === 'SPLIT')
      );

      for (const tx of stkAndSplitTxs) {
        if (tx.assetCategory === 'CORP_ACTION' && tx.action === 'SPLIT') {
          const ratio = tx.corporateAction?.ratio || tx.quantity || 1;
          if (activeCycle && ratio > 0 && activeCycle.shares > 0) {
            activeCycle.shares *= ratio;
            activeCycle.trades.push(tx);
          }
          continue;
        }

        const qty = tx.quantity;
        const price = tx.price;
        const comm = Math.abs(tx.commission || 0);

        if (qty > 0) {
          if (!activeCycle) {
            activeCycle = {
              startDate: tx.date || tx.dateTime?.slice(0, 10) || 'unknown',
              trades: [],
              shares: 0,
              rawPool: 0,
              peakCost: 0,
              grossBuy: 0,
              realizedPnl: 0,
              realizedPnlBase: 0,
              isOpen: true,
            };
          }
          const buyCost = tx.netCashFlow < 0 ? Math.abs(tx.netCashFlow) : qty * price + comm;
          activeCycle.rawPool += buyCost;
          activeCycle.shares += qty;
          activeCycle.grossBuy += buyCost;
          if (activeCycle.rawPool > activeCycle.peakCost) activeCycle.peakCost = activeCycle.rawPool;
          activeCycle.trades.push(tx);
        } else if (qty < 0) {
          if (!activeCycle) {
            // Standalone sell without prior buy record in history
            activeCycle = {
              startDate: tx.date || tx.dateTime?.slice(0, 10) || 'unknown',
              trades: [tx],
              shares: 0,
              rawPool: 0,
              peakCost: 0,
              grossBuy: 0,
              realizedPnl: tx.realizedPnl || 0,
              realizedPnlBase: (tx.realizedPnl || 0) * tickerFxToBase,
              isOpen: false,
            };
            stockCycles.push(activeCycle);
            activeCycle = null;
            continue;
          }
          const soldQty = Math.abs(qty);
          const proceeds = tx.netCashFlow > 0 ? tx.netCashFlow : soldQty * price - comm;
          activeCycle.trades.push(tx);
          if (activeCycle.shares > 0) {
            const ratio = Math.min(1.0, soldQty / activeCycle.shares);
            const rawCostOfSold = activeCycle.rawPool * ratio;
            const realizedTradePnl = proceeds - rawCostOfSold;
            activeCycle.realizedPnl += realizedTradePnl;
            activeCycle.realizedPnlBase += realizedTradePnl * tickerFxToBase;
            activeCycle.rawPool = Math.max(0, activeCycle.rawPool * (1 - ratio));
            activeCycle.shares = Math.max(0, activeCycle.shares - soldQty);
          }
          if (activeCycle.shares <= 1e-6) {
            activeCycle.shares = 0;
            activeCycle.rawPool = 0;
            activeCycle.isOpen = false;
            stockCycles.push(activeCycle);
            activeCycle = null;
          }
        }
      }

      if (activeCycle) {
        activeCycle.isOpen = activeCycle.shares > 1e-6;
        stockCycles.push(activeCycle);
      }

      const stkDateCounts = new Map<string, number>();
      const stockComparisonRows: CampaignComparisonItem[] = [];

      stockCycles.forEach((cyc, idx) => {
        const seq = (stkDateCounts.get(cyc.startDate) || 0) + 1;
        stkDateCounts.set(cyc.startDate, seq);
        const stableId =
          seq > 1 ? `stk::${ticker}::${cyc.startDate}::${seq}` : `stk::${ticker}::${cyc.startDate}`;
        const legacyIds = idx === 0 ? [`camp-stk-${ticker}`] : undefined;

        const cycCapNative = cyc.isOpen ? cyc.rawPool : cyc.peakCost || cyc.grossBuy;
        const cycCapBase = cycCapNative * tickerFxToBase;
        const cycMvNative = cyc.isOpen ? cyc.shares * spotPrice : 0;
        const cycOpenPnlNative = cyc.isOpen ? cycMvNative - cyc.rawPool : 0;
        const cycTotalNetNative = cycOpenPnlNative + cyc.realizedPnl;
        const cycTotalNetBase = cycOpenPnlNative * tickerFxToBase + cyc.realizedPnlBase;
        const cycRoiPct = cycCapBase > 0 ? (cycTotalNetBase / cycCapBase) * 100 : 0;
        const cycRet = computeSafeAnnualizedReturn(
          cyc.trades,
          cycMvNative * tickerFxToBase,
          cycCapBase,
          cycTotalNetBase,
          cyc.isOpen,
          baseCurrency,
          fxRates,
          tickerFxToBase
        );

        const title =
          stockCycles.length === 1
            ? cyc.isOpen
              ? `${cyc.shares.toLocaleString()} Shares Held`
              : `Closed Equity Lots`
            : cyc.isOpen
            ? `Cycle #${idx + 1} • ${cyc.shares.toLocaleString()} Shs`
            : `Cycle #${idx + 1} • Closed (${cyc.startDate})`;

        stockComparisonRows.push({
          id: stableId,
          kind: 'STOCK_LOT',
          contractSymbol: `${ticker} EQUITY`,
          title,
          strategyType: 'Equity Core',
          bucket: 'LINKED',
          canToggleBucket: false,
          transactionIds: cyc.trades.map((t) => t.id),
          status: cyc.isOpen ? 'OPEN' : 'CLOSED',
          currency: primaryCurrency,
          capitalDeployedNative: cycCapNative,
          capitalDeployedBase: cycCapBase,
          netCashNative: cyc.trades.reduce((s, t) => s + t.netCashFlow, 0),
          realizedPnlNative: cyc.realizedPnl,
          unrealizedPnlNative: cycOpenPnlNative,
          netPnlNative: cycTotalNetNative,
          netPnlBase: cycTotalNetBase,
          tradeRoiPct: Number(cycRoiPct.toFixed(1)),
          annualizedReturnPct: cycRet.annualizedReturnPct,
          holdingDays: cycRet.holdingDays,
          trades: cyc.trades,
          legacyIds,
        });
      });

      // Put open stock cycles first, then closed cycles newest-first, prepended before option campaigns
      stockComparisonRows.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'OPEN' ? -1 : 1;
        return b.id.localeCompare(a.id);
      });
      comparisonItems.unshift(...stockComparisonRows);
    }

    const divTxs = sorted.filter((t) => t.assetCategory === 'DIV' || t.assetCategory === 'TAX');
    if (divTxs.length > 0) {
      const divCapBase = (currentShares > 0 ? runningRawCostPool : peakStockCostNative) * tickerFxToBase;
      comparisonItems.push({
        id: `camp-div-${ticker}`,
        kind: 'DIVIDENDS',
        contractSymbol: `${ticker} DIVIDENDS`,
        title: `${position.dividends.length} Net Payouts`,
        strategyType: 'Net Dividends',
        bucket: 'LINKED',
        canToggleBucket: false,
        transactionIds: divTxs.map((t) => t.id),
        status: 'CLOSED',
        currency: primaryCurrency,
        capitalDeployedNative: currentShares > 0 ? runningRawCostPool : peakStockCostNative,
        capitalDeployedBase: divCapBase,
        netCashNative: netDividends,
        realizedPnlNative: netDividends,
        unrealizedPnlNative: 0,
        netPnlNative: netDividends,
        netPnlBase: tickerNetDividendsBase,
        tradeRoiPct: divCapBase > 0 ? Number(((tickerNetDividendsBase / divCapBase) * 100).toFixed(1)) : 0,
        annualizedReturnPct: null,
        holdingDays: 0,
        trades: divTxs,
      });
    }

    // Unified Ticker Totals (100% reconciled: Open P&L + Realized P&L === Total Net P&L)
    const isActive = currentShares > 0 || openOptionCountForTicker > 0;
    const stockMvBase = marketValue * tickerFxToBase;
    const stockOpenUnrealizedBase = currentShares > 0 ? unrealizedPnlRaw * tickerFxToBase : 0;

    const activeOpenPnlNative = (currentShares > 0 ? unrealizedPnlRaw : 0) + openOptionsUnrealizedInStockCur;
    const activeOpenPnlBase = stockOpenUnrealizedBase + openOptionsUnrealizedBase;

    const realizedPnlNative = tickerRealizedStockPnl + netDividends + realizedOptionsInStockCur;
    const realizedPnlBase = tickerRealizedStockPnlBase + tickerNetDividendsBase + realizedOptionsBase;

    const totalNetPnlNative = activeOpenPnlNative + realizedPnlNative;
    const totalNetPnlBase = activeOpenPnlBase + realizedPnlBase;

    const activeCapitalDeployedBase =
      (currentShares > 0 ? runningRawCostPool * tickerFxToBase : 0) + openOptionsCapitalAtRiskBase;
    const activeOpenPnlPct =
      activeCapitalDeployedBase > 0 ? (activeOpenPnlBase / activeCapitalDeployedBase) * 100 : 0;

    const totalCapitalDeployedBase = Math.max(
      activeCapitalDeployedBase,
      peakStockCostNative * tickerFxToBase + openOptionsCapitalAtRiskBase + (closedOptionsPeakOutlayBase > 0 && currentShares === 0 ? closedOptionsPeakOutlayBase : 0),
      Math.abs(totalNetPnlBase) > 0 ? 1 : 0
    );

    const tickerTerminalMvBase = stockMvBase + openOptionsMvBase;
    const tickerRet = computeSafeAnnualizedReturn(
      sorted,
      tickerTerminalMvBase,
      totalCapitalDeployedBase,
      totalNetPnlBase,
      isActive,
      baseCurrency,
      fxRates,
      tickerFxToBase
    );

    totalActiveOpenPnlBase += activeOpenPnlBase;
    totalRealizedAllPnlBase += realizedPnlBase;

    unifiedTickers.push({
      ticker,
      companyName,
      currency: primaryCurrency,
      isActive,
      hasStockPosition: currentShares > 0,
      hasOpenOptions: openOptionCountForTicker > 0,
      spotPrice,
      spotChange,
      spotChangePct,
      currentShares,
      openOptionCount: openOptionCountForTicker,
      totalCampaignCount: comparisonItems.length,
      rawAvgEntry,
      realEntryPrice,
      basisReductionPct,
      cushionPct: Number(downsideCushionPct.toFixed(1)),
      stockMarketValueNative: marketValue,
      stockMarketValueBase: stockMvBase,
      openOptionsMarketValueNative: openOptionsMvInStockCur,
      openOptionsMarketValueBase: openOptionsMvBase,
      totalExposureBase: stockMvBase + openOptionsMvBase,
      capitalAtRiskNative: (currentShares > 0 ? runningRawCostPool : 0) + openOptionsCapitalAtRiskInStockCur,
      capitalAtRiskBase: activeCapitalDeployedBase,
      activeOpenPnlNative,
      activeOpenPnlBase,
      activeOpenPnlPct: Number(activeOpenPnlPct.toFixed(1)),
      realizedPnlNative,
      realizedPnlBase,
      totalNetPnlNative,
      totalNetPnlBase,
      annualizedReturnPct: tickerRet.annualizedReturnPct,
      isShortDuration: tickerRet.isShortDuration,
      holdingDays: tickerRet.holdingDays,
      stockPosition: position,
      campaigns: comparisonItems,
    });
  }

  // Standalone Option Positions (Bucket B)
  const standalonePositions: StandaloneOptionPosition[] = [];
  let totalStandaloneOptionsPnl = 0;
  let totalStandaloneOptionsValue = 0;
  let totalStandaloneUnrealizedPnl = 0;

  for (const [symbol, trades] of standaloneOptionMap.entries()) {
    const sortedTrades = [...trades].sort(
      (a, b) => (new Date(a.dateTime).getTime() || 0) - (new Date(b.dateTime).getTime() || 0)
    );
    let netContracts = 0;
    let totalOutlay = 0;
    let totalReceived = 0;
    let ibkrRealizedSum = 0;
    let hasIbkrRealized = false;

    const first = sortedTrades[0];
    const underlying = first?.underlying || 'OPT';
    const optType: 'CALL' | 'PUT' = first?.optionDetails?.type || 'CALL';
    const strike = first?.optionDetails?.strike || 0;
    const expiry = first?.optionDetails?.expiry || '';
    const multiplier = first?.multiplier || 100;
    const optCurrency = first?.currency || 'USD';
    const fxToBase = getFxMultiplier(optCurrency, baseCurrency, fxRates, first?.fxRateToBase);

    for (const t of sortedTrades) {
      netContracts += t.quantity;
      if (t.netCashFlow < 0) totalOutlay += Math.abs(t.netCashFlow);
      else totalReceived += t.netCashFlow;
      if (t.realizedPnl !== undefined && t.realizedPnl !== 0) {
        ibkrRealizedSum += t.realizedPnl;
        hasIbkrRealized = true;
      }
    }

    if (Math.abs(netContracts) < 1e-6) netContracts = 0;

    const mark = positionMarks[symbol];
    const isClosed = netContracts === 0;
    const realizedPnl = isClosed ? totalReceived - totalOutlay : hasIbkrRealized ? ibkrRealizedSum : 0;

    const openCostBasis = isClosed
      ? 0
      : mark && mark.costBasisMoney !== 0
      ? mark.costBasisMoney
      : totalOutlay - totalReceived + realizedPnl;

    const avgEntryPrice =
      !isClosed && Math.abs(netContracts) > 0
        ? Math.abs(openCostBasis) / (Math.abs(netContracts) * multiplier)
        : totalOutlay > 0
        ? totalOutlay / (Math.max(1, sortedTrades.filter((t) => t.quantity > 0).reduce((s, t) => s + t.quantity, 0)) * multiplier)
        : 0;

    const currentMarkPrice = isClosed ? 0 : mark?.markPrice ?? avgEntryPrice;
    const marketValue = isClosed ? 0 : netContracts * currentMarkPrice * multiplier;
    const unrealizedPnl = isClosed
      ? 0
      : mark
      ? mark.fifoPnlUnrealized
      : marketValue - openCostBasis;

    totalStandaloneOptionsPnl += realizedPnl * fxToBase;
    if (!isClosed) {
      totalStandaloneOptionsValue += marketValue * fxToBase;
      totalStandaloneUnrealizedPnl += unrealizedPnl * fxToBase;
    }

    standalonePositions.push({
      id: `standalone-${symbol}`,
      underlying,
      contractSymbol: symbol,
      type: optType,
      strike,
      expiry,
      multiplier,
      currency: optCurrency,
      netContracts,
      avgEntryPrice,
      currentMarkPrice,
      openCostBasis,
      marketValue,
      unrealizedPnl,
      totalOutlay,
      totalReceived,
      realizedPnl,
      status: isClosed ? 'CLOSED' : 'OPEN',
      trades: sortedTrades,
    });
  }

  // Sort active stock positions by base-currency Market Value descending
  positions.sort((a, b) => {
    const mvA = a.marketValue * getFxMultiplier(a.currency, baseCurrency, fxRates);
    const mvB = b.marketValue * getFxMultiplier(b.currency, baseCurrency, fxRates);
    return mvB - mvA;
  });

  // Sort unified tickers: Active first (by exposure/capital at risk descending), then Closed (by abs(totalNetPnlBase) descending)
  unifiedTickers.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.isActive) {
      const expA = Math.max(a.totalExposureBase, a.capitalAtRiskBase);
      const expB = Math.max(b.totalExposureBase, b.capitalAtRiskBase);
      return expB - expA;
    }
    return Math.abs(b.totalNetPnlBase) - Math.abs(a.totalNetPnlBase);
  });

  standalonePositions.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'OPEN' ? -1 : 1;
    if (a.status === 'OPEN') return Math.abs(b.marketValue) - Math.abs(a.marketValue);
    return Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl);
  });

  const totalOpenOptionsValue = totalStandaloneOptionsValue + totalOpenLinkedOptionsValue;
  const totalMarketValue = totalStockMarketValue + totalOpenOptionsValue;

  const totalUnrealizedPnlRaw = totalStockMarketValue - totalRawCostBasis;
  const totalUnrealizedPnlReal = totalStockMarketValue - totalAdjustedCostBasis;
  const totalUnrealizedPnlRealPct = totalAdjustedCostBasis > 0 ? (totalUnrealizedPnlReal / totalAdjustedCostBasis) * 100 : 0;
  const totalNetBasisReduction = totalRawCostBasis - totalAdjustedCostBasis;

  const weightedDownsideCushionPct =
    totalStockMarketValue > 0
      ? positions.reduce((acc, p) => {
          const mvBase = p.marketValue * getFxMultiplier(p.currency, baseCurrency, fxRates);
          return acc + p.downsideCushionPct * (mvBase / totalStockMarketValue);
        }, 0)
      : 0;

  const overallYoCPct =
    totalRawCostBasis > 0 ? ((totalNetDividends + totalLinkedOptionPremiums) / totalRawCostBasis) * 100 : 0;

  const openLinkedCount =
    positions.reduce((acc, p) => acc + p.linkedOptionCampaigns.filter((c) => c.status === 'OPEN').length, 0) +
    closedPositions.reduce((acc, p) => acc + p.linkedOptionCampaigns.filter((c) => c.status === 'OPEN').length, 0);
  const openStandaloneCount = standalonePositions.filter((s) => s.status === 'OPEN').length;

  const summary: PortfolioSummary = {
    totalMarketValue,
    totalStockMarketValue,
    totalOpenOptionsValue,
    totalRawCostBasis,
    totalAdjustedCostBasis,
    totalUnrealizedPnlRaw,
    totalUnrealizedPnlReal,
    totalUnrealizedPnlRealPct,
    totalRealizedStockPnl,
    totalNetDividends,
    totalLinkedOptionPremiums,
    totalStandaloneOptionsPnl,
    totalStandaloneUnrealizedPnl,
    totalNetBasisReduction,
    weightedDownsideCushionPct,
    overallYoCPct,
    totalActiveOpenPnlBase,
    totalRealizedAllPnlBase,
    totalNetAllPnlBase: totalActiveOpenPnlBase + totalRealizedAllPnlBase,
    shortPutCollateralBase,
    baseCurrency,
    openStockCount: positions.length,
    openOptionCount: openLinkedCount + openStandaloneCount,
    totalTransactionCount: transactions.length,
  };

  return {
    positions,
    closedPositions,
    standalonePositions,
    unifiedTickers,
    summary,
    tickerQuotes: liveQuotes,
  };
}
