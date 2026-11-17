/**
 * Chronological Real Entry Price & Two-Bucket Engine
 *
 * Implements the quantitative sequential cost pool math:
 * - Bucket A: Linked to Basis (Shares, Net Dividends, Covered Calls, CSPs)
 * - Bucket B: Standalone Trades (Speculative Long Calls/Puts, Unlinked Trades)
 * - Proportional cost pool reduction on partial stock sales
 * - Multi-currency FX conversion into Base Reporting Currency (EUR / USD)
 * - Real Entry Price, Downside Cushion %, and Yield on Cost %
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
} from '../types';

export interface ProcessedPortfolio {
  positions: StockPosition[]; // Active stock positions (currentShares > 0)
  closedPositions: StockPosition[]; // Closed stock positions (currentShares === 0, had STK or LINKED trades)
  standalonePositions: StandaloneOptionPosition[];
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
    // If fallbackTxRate was recorded when EUR was base (USD->EUR ~0.91) and user switched to USD
    if (from === 'EUR' && baseCurrency === 'USD') {
      return fallbackTxRate < 1 ? 1 / fallbackTxRate : fallbackTxRate;
    }
    return fallbackTxRate;
  }

  // Reasonable defaults if no FX table was imported
  if (from === 'USD' && baseCurrency === 'EUR') return 0.91;
  if (from === 'EUR' && baseCurrency === 'USD') return 1.099;
  return 1;
}

/**
 * Calculate Downside Cushion % cleanly across both in-profit and underwater positions:
 * - When Spot >= Real Entry (positive buffer): (Spot - Real Entry) / Spot * 100 (max drop % before loss, capped at 100% if Real Entry <= 0)
 * - When Spot < Real Entry (below breakeven): (Spot - Real Entry) / Real Entry * 100 (bounded in (-100%, 0%], never blows up past -100%)
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
  // Apply bucket overrides
  const effectiveTransactions = transactions.map((tx) => ({
    ...tx,
    bucket: bucketOverrides[tx.id] || tx.bucket || tx.defaultBucket || 'LINKED',
  }));

  // Group by underlying ticker
  const tickerMap = new Map<string, Transaction[]>();
  const standaloneOptionMap = new Map<string, Transaction[]>();

  for (const tx of effectiveTransactions) {
    const underlying = tx.underlying || tx.symbol;
    if (!tickerMap.has(underlying)) {
      tickerMap.set(underlying, []);
    }
    tickerMap.get(underlying)!.push(tx);

    // If standalone option, also collect into standalone map
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

  let totalStockMarketValue = 0;
  let totalOpenLinkedOptionsValue = 0;
  let totalRawCostBasis = 0;
  let totalAdjustedCostBasis = 0;
  let totalRealizedStockPnl = 0;
  let totalNetDividends = 0;
  let totalLinkedOptionPremiums = 0;

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
    const tickerFxToBase = getFxMultiplier(primaryCurrency, baseCurrency, fxRates, stkTrades[0]?.fxRateToBase);

    let currentShares = 0;
    let runningRawCostPool = 0;
    let runningAdjustedCostPool = 0;
    let tickerRealizedStockPnl = 0;
    let tickerGrossDividends = 0;
    let tickerWithholdingTax = 0;
    let tickerLinkedPremiums = 0;

    const timeline: ChronologicalStep[] = [];
    const dividendsMap = new Map<string, DividendRecord>();
    const optionCampaignsMap = new Map<string, Transaction[]>();

    for (const tx of sorted) {
      const isLinked = tx.bucket === 'LINKED';
      // Convert cross-currency linked option/dividend cashflows into the stock's primary currency if needed
      const txToStockFx =
        tx.currency === primaryCurrency
          ? 1
          : getFxMultiplier(tx.currency, baseCurrency, fxRates, tx.fxRateToBase) / tickerFxToBase;

      // -------------------------------------------------------
      // 1. STOCK BUY / SELL / SPLIT
      // -------------------------------------------------------
      if (tx.assetCategory === 'STK') {
        const qty = tx.quantity;
        const price = tx.price;
        const comm = Math.abs(tx.commission || 0);

        if (qty > 0) {
          // Stock BUY: use exact netCashFlow cost if available
          const buyCost = tx.netCashFlow < 0 ? Math.abs(tx.netCashFlow) : qty * price + comm;
          const rawBefore = runningRawCostPool;
          const adjBefore = runningAdjustedCostPool;
          const sharesBefore = currentShares;

          runningRawCostPool += buyCost;
          runningAdjustedCostPool += buyCost;
          currentShares += qty;

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
          // Stock SELL (Partial or Full)
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

            // Reduce BOTH pools proportionally
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

      // -------------------------------------------------------
      // 2. CORPORATE ACTIONS (Splits)
      // -------------------------------------------------------
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

      // -------------------------------------------------------
      // 3. DIVIDENDS & WITHHOLDING TAXES
      // -------------------------------------------------------
      else if (tx.assetCategory === 'DIV' || tx.assetCategory === 'TAX') {
        const isTax = tx.assetCategory === 'TAX' || tx.action === 'TAX';
        const amtNative = Math.abs(tx.price || tx.proceeds || 0);
        const amtInStockCur = amtNative * txToStockFx;

        if (!isTax) {
          tickerGrossDividends += amtInStockCur;
        } else {
          tickerWithholdingTax += amtInStockCur;
        }

        // Group into daily dividend record
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

      // -------------------------------------------------------
      // 4. OPTIONS (Bucket A Linked vs Bucket B Standalone)
      // -------------------------------------------------------
      else if (tx.assetCategory === 'OPT') {
        const campaignKey = `${tx.symbol}|${tx.bucket}`;
        if (!optionCampaignsMap.has(campaignKey)) {
          optionCampaignsMap.set(campaignKey, []);
        }
        optionCampaignsMap.get(campaignKey)!.push(tx);

        const netCashInStockCur = tx.netCashFlow * txToStockFx;

        if (isLinked) {
          // Bucket A: Reduces Adjusted Cost Pool
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

    // Process Option Campaigns for this ticker
    const linkedCampaigns: OptionCampaign[] = [];
    const standaloneCampaigns: OptionCampaign[] = [];

    for (const [campaignKey, trades] of optionCampaignsMap.entries()) {
      const contractSymbol = trades[0]?.symbol || campaignKey.split('|')[0];
      let netContracts = 0;
      let totalCredits = 0;
      let totalDebits = 0;
      let netCashFlow = 0;
      let realizedPnl = 0;
      let optType: 'CALL' | 'PUT' = 'CALL';
      let strike = 0;
      let expiry = '';
      let bucket: BucketType = trades[0]?.bucket || 'LINKED';
      const multiplier = trades[0]?.multiplier || 100;
      const optCurrency = trades[0]?.currency || primaryCurrency;

      for (const tr of trades) {
        bucket = tr.bucket;
        netContracts += tr.quantity;
        if (tr.netCashFlow > 0) totalCredits += tr.netCashFlow;
        else totalDebits += Math.abs(tr.netCashFlow);
        netCashFlow += tr.netCashFlow;
        realizedPnl += tr.realizedPnl || 0;

        if (tr.optionDetails) {
          optType = tr.optionDetails.type;
          strike = tr.optionDetails.strike;
          expiry = tr.optionDetails.expiry;
        }
      }

      if (Math.abs(netContracts) < 1e-6) netContracts = 0;
      if (netContracts === 0 && realizedPnl === 0) {
        realizedPnl = netCashFlow;
      }

      const mark = positionMarks[contractSymbol];
      const currentMarkPrice = mark?.markPrice;
      const marketValue =
        netContracts !== 0 && currentMarkPrice !== undefined
          ? netContracts * currentMarkPrice * multiplier
          : 0;
      const unrealizedPnl = mark?.fifoPnlUnrealized;

      if (bucket === 'LINKED' && netContracts !== 0 && currentMarkPrice !== undefined) {
        const optFxToBase = getFxMultiplier(optCurrency, baseCurrency, fxRates, trades[0]?.fxRateToBase);
        totalOpenLinkedOptionsValue += marketValue * optFxToBase;
      }

      const status: 'OPEN' | 'CLOSED' | 'EXPIRED' | 'ASSIGNED' =
        netContracts === 0 ? 'CLOSED' : 'OPEN';

      const campaign: OptionCampaign = {
        id: `camp-${contractSymbol}-${bucket}`,
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
        currentMarkPrice,
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
    }

    // Live Quote & Mark Price Resolution (protect against European/US ticker collisions like SAN EUR vs SAN USD)
    const mark = positionMarks[ticker];
    const yahooQuote = liveQuotes[ticker];
    const fallbackSpot =
      mark?.markPrice ||
      (currentShares > 0 && runningRawCostPool > 0
        ? runningRawCostPool / currentShares
        : stkTrades.length > 0
        ? stkTrades[stkTrades.length - 1].price
        : 0);

    // Prefer Yahoo live quote for USD equities or explicitly exchange-suffixed European quotes, otherwise use IBKR markPrice
    const canUseYahoo =
      yahooQuote &&
      yahooQuote.regularMarketPrice > 0 &&
      (primaryCurrency === 'USD' || Boolean(mark?.listingExchange && yahooQuote.exchange));

    const spotPrice = canUseYahoo ? yahooQuote.regularMarketPrice : fallbackSpot;
    const spotChange = canUseYahoo ? yahooQuote.regularMarketChange || 0 : 0;
    const spotChangePct = canUseYahoo ? yahooQuote.regularMarketChangePercent || 0 : 0;

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

    const position: StockPosition = {
      ticker,
      companyName: (canUseYahoo ? yahooQuote.shortName : undefined) || stkTrades[0]?.notes || `${ticker} Equity`,
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

    // Always aggregate realized stock P&L, net dividends, and linked premiums (converted to baseCurrency)
    totalRealizedStockPnl += tickerRealizedStockPnl * tickerFxToBase;
    totalNetDividends += netDividends * tickerFxToBase;
    totalLinkedOptionPremiums += tickerLinkedPremiums * tickerFxToBase;

    if (currentShares > 0) {
      positions.push(position);
      totalStockMarketValue += marketValue * tickerFxToBase;
      totalRawCostBasis += runningRawCostPool * tickerFxToBase;
      totalAdjustedCostBasis += runningAdjustedCostPool * tickerFxToBase;
    } else if (stkTrades.length > 0 || linkedCampaigns.length > 0) {
      closedPositions.push(position);
    }
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

    // Open cost basis: remaining cash tied up in open contracts
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

  // Sort standalone positions: OPEN first, then by abs(marketValue) or abs(realizedPnl)
  standalonePositions.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'OPEN' ? -1 : 1;
    if (a.status === 'OPEN') return Math.abs(b.marketValue) - Math.abs(a.marketValue);
    return Math.abs(b.realizedPnl) - Math.abs(a.realizedPnl);
  });

  const totalOpenOptionsValue = totalStandaloneOptionsValue + totalOpenLinkedOptionsValue;
  const totalMarketValue = totalStockMarketValue + totalOpenOptionsValue;

  // Stock unrealized P&L (apples-to-apples against stock Raw/Adjusted basis)
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
    baseCurrency,
    openStockCount: positions.length,
    openOptionCount: openLinkedCount + openStandaloneCount,
    totalTransactionCount: transactions.length,
  };

  return {
    positions,
    closedPositions,
    standalonePositions,
    summary,
    tickerQuotes: liveQuotes,
  };
}
