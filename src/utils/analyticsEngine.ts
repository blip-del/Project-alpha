/**
 * Quantitative Analytics & Interactive Charting Engine
 *
 * Implements:
 * 1. Newton-Raphson XIRR (Money-weighted internal rate of return)
 * 2. Chronological Step-Down data generator per ticker
 * 3. Monthly cashflow aggregation (Dividends, Linked Premiums, Standalone Realized P&L) in Base Currency
 * 4. Active options matrix (DTE, Strike vs Spot Cushion, % Profit Captured, Extrinsic Remaining, APR)
 * 5. Capital allocation & EUR vs USD FX exposure
 * 6. Advanced quantitative KPIs (RoM, Theta decay, Annualized velocity)
 */

import {
  Transaction,
  StockPosition,
  StandaloneOptionPosition,
  StockQuote,
  MonthlyCashflowRecord,
  ActiveOptionMetric,
  CapitalAllocation,
  AdvancedKPIs,
  PositionMark,
} from '../types';
import { getFxMultiplier, calculateDownsideCushionPct, calculateXIRR } from './portfolioEngine';

export { calculateXIRR };

export interface StepDownPoint {
  date: string;
  timestamp: number;
  spotPrice: number;
  rawAvgCost: number;
  realEntryPrice: number;
  eventDesc: string;
  impactType: string;
  shares: number;
  cushionPct: number;
  rawSavingPerShare: number;
}

export function computeStepDownData(
  position: StockPosition,
  quotes: Record<string, StockQuote> = {}
): StepDownPoint[] {
  if (!position || position.timeline.length === 0) return [];

  const points: StepDownPoint[] = [];
  const curSym = position.currency === 'EUR' ? '€' : '$';
  const liveSpot = position.spotPrice || quotes[position.ticker]?.regularMarketPrice || position.rawAvgEntry || 10;

  position.timeline.forEach((step, idx) => {
    const stepProgress = idx / Math.max(1, position.timeline.length - 1);
    const baseSpot = step.rawAvgCostAfter + (liveSpot - position.rawAvgEntry) * stepProgress;

    const savingPerShare = Math.max(0, step.rawAvgCostAfter - step.realEntryPriceAfter);
    const currentCushion = calculateDownsideCushionPct(baseSpot, step.realEntryPriceAfter);

    const fmtPrice = (v: number) => (v > 0 && v < 2 ? v.toFixed(3) : v.toFixed(2));
    let eventSummary = step.actionDesc;
    if (step.impactType === 'OPTION_PREMIUM') {
      eventSummary = `${step.date}: Premium Harvest -> Real Entry dropped to ${curSym}${fmtPrice(step.realEntryPriceAfter)}`;
    } else if (step.impactType === 'DIVIDEND') {
      eventSummary = `${step.date}: Net Dividend Credit -> Real Entry dropped to ${curSym}${fmtPrice(step.realEntryPriceAfter)}`;
    } else if (step.impactType === 'BUY') {
      eventSummary = `${step.date}: Share Purchase -> Raw Avg: ${curSym}${fmtPrice(step.rawAvgCostAfter)}, Real Entry: ${curSym}${fmtPrice(step.realEntryPriceAfter)}`;
    } else if (step.impactType === 'SELL') {
      eventSummary = `${step.date}: Partial Sale -> Preserved Real Entry ${curSym}${fmtPrice(step.realEntryPriceAfter)}`;
    } else if (step.impactType === 'SPLIT') {
      eventSummary = `${step.date}: Stock Split -> Basis adjusted to ${curSym}${fmtPrice(step.realEntryPriceAfter)}/sh`;
    }

    points.push({
      date: step.date,
      timestamp: new Date(step.date).getTime() || idx,
      spotPrice: Number(Math.max(0.001, baseSpot).toFixed(4)),
      rawAvgCost: Number(step.rawAvgCostAfter.toFixed(4)),
      realEntryPrice: Number(step.realEntryPriceAfter.toFixed(4)),
      eventDesc: eventSummary,
      impactType: step.impactType,
      shares: step.sharesAfter,
      cushionPct: Number(currentCushion.toFixed(1)),
      rawSavingPerShare: Number(savingPerShare.toFixed(4)),
    });
  });

  if (points.length > 0) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const fmtPrice = (v: number) => (v > 0 && v < 2 ? v.toFixed(3) : v.toFixed(2));
    points.push({
      date: todayStr,
      timestamp: Date.now(),
      spotPrice: Number(liveSpot.toFixed(4)),
      rawAvgCost: Number(position.rawAvgEntry.toFixed(4)),
      realEntryPrice: Number(position.realEntryPrice.toFixed(4)),
      eventDesc: `Today (Live): Spot ${curSym}${fmtPrice(liveSpot)} | Real Entry ${curSym}${fmtPrice(position.realEntryPrice)} (${position.downsideCushionPct >= 0 ? '+' : ''}${position.downsideCushionPct.toFixed(1)}% Cushion)`,
      impactType: 'LIVE',
      shares: position.currentShares,
      cushionPct: Number(position.downsideCushionPct.toFixed(1)),
      rawSavingPerShare: Number(position.basisReductionDollar.toFixed(4)),
    });
  }

  return points;
}

/**
 * Monthly cashflow aggregation (Dividends, Linked Premiums, Standalone Realized P&L) in baseCurrency
 */
export function computeMonthlyCashflows(
  transactions: Transaction[],
  baseCurrency: 'EUR' | 'USD' = 'EUR',
  fxRates: Record<string, number> = {}
): {
  monthlyRecords: MonthlyCashflowRecord[];
  averageMonthlyInflow: number;
  totalCashflow: number;
  topMonthLabel: string;
  topMonthAmount: number;
} {
  const map = new Map<string, { divs: number; premiums: number; standalone: number }>();

  transactions.forEach((tx) => {
    const monthKey = (tx.date || tx.dateTime || '').slice(0, 7);
    if (!monthKey || monthKey.length !== 7 || !/^\d{4}-\d{2}$/.test(monthKey)) return;

    if (!map.has(monthKey)) {
      map.set(monthKey, { divs: 0, premiums: 0, standalone: 0 });
    }
    const cur = map.get(monthKey)!;
    const fx = getFxMultiplier(tx.currency, baseCurrency, fxRates, tx.fxRateToBase);

    if (tx.assetCategory === 'DIV' || tx.assetCategory === 'TAX') {
      const net = tx.assetCategory === 'DIV' ? Math.abs(tx.price || tx.proceeds) : -Math.abs(tx.price || tx.proceeds);
      cur.divs += net * fx;
    } else if (tx.assetCategory === 'OPT') {
      if (tx.bucket === 'LINKED') {
        cur.premiums += tx.netCashFlow * fx;
      } else {
        if (tx.realizedPnl !== undefined && tx.realizedPnl !== 0) {
          cur.standalone += tx.realizedPnl * fx;
        }
      }
    }
  });

  const sortedKeys = Array.from(map.keys()).sort();
  const monthlyRecords: MonthlyCashflowRecord[] = [];
  let totalCashflow = 0;
  let topMonthLabel = 'N/A';
  let topMonthAmount = -Infinity;

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  sortedKeys.forEach((key) => {
    const val = map.get(key)!;
    const parts = key.split('-');
    const year = parts[0]?.slice(2);
    const monthIdx = parseInt(parts[1], 10) - 1;
    const label = `${monthNames[monthIdx] || parts[1]} '${year}`;

    const netDivs = Math.max(0, Math.round(val.divs));
    const netPrems = Math.round(val.premiums);
    const standalonePnl = Math.round(val.standalone);
    const total = netDivs + netPrems + standalonePnl;

    totalCashflow += total;
    if (total > topMonthAmount) {
      topMonthAmount = total;
      topMonthLabel = label;
    }

    monthlyRecords.push({
      month: key,
      label,
      netDividends: netDivs,
      linkedPremiums: netPrems,
      standalonePnl,
      totalInflow: total,
    });
  });

  if (topMonthAmount === -Infinity) topMonthAmount = 0;

  const averageMonthlyInflow = monthlyRecords.length > 0
    ? Math.round(totalCashflow / monthlyRecords.length)
    : 0;

  return {
    monthlyRecords,
    averageMonthlyInflow,
    totalCashflow,
    topMonthLabel,
    topMonthAmount,
  };
}

/**
 * Extract Active Open Options metrics (DTE, Strike Cushion %, % Profit Captured, Extrinsic Value, APR, Unrealized P&L)
 * Accurate OTM/ITM math for both Short & Long Calls/Puts — deep-OTM short calls are never mislabeled TESTED.
 */
export function computeActiveOptions(
  positions: StockPosition[],
  standalonePositions: StandaloneOptionPosition[],
  quotes: Record<string, StockQuote> = {},
  positionMarks: Record<string, PositionMark> = {},
  baseCurrency: 'EUR' | 'USD' = 'EUR',
  fxRates: Record<string, number> = {},
  closedPositions: StockPosition[] = []
): ActiveOptionMetric[] {
  const activeMetrics: ActiveOptionMetric[] = [];
  const now = new Date();
  const allStockContainers = [...positions, ...closedPositions];

  const getSpotForUnderlying = (underlying: string, fallbackStrike: number): number => {
    const pos = allStockContainers.find((p) => p.ticker === underlying && p.spotPrice > 0);
    if (pos && pos.spotPrice > 0) return pos.spotPrice;
    if (positionMarks[underlying]?.markPrice) return positionMarks[underlying].markPrice;
    const q = quotes[underlying];
    if (q && q.regularMarketPrice > 0) return q.regularMarketPrice;
    return fallbackStrike;
  };

  // 1. Linked Covered Calls and Short/Linked Options (across active & zero-share underlyings)
  allStockContainers.forEach((p) => {
    const spot = p.spotPrice || getSpotForUnderlying(p.ticker, 0);

    p.linkedOptionCampaigns.forEach((camp) => {
      if (camp.status !== 'OPEN' || camp.netContracts === 0) return;

      const expiryDate = new Date(camp.expiry);
      const diffMs = expiryDate.getTime() - now.getTime();
      const dte = Math.max(1, Math.round(diffMs / 86400000));
      const isShort = camp.netContracts < 0;
      const numContracts = Math.abs(camp.netContracts) || 1;
      const mult = camp.multiplier || 100;
      const fx = getFxMultiplier(camp.currency, baseCurrency, fxRates);

      let cushionPct = 0;
      if (spot > 0 && camp.strike > 0) {
        if (isShort) {
          cushionPct =
            camp.type === 'CALL'
              ? ((camp.strike - spot) / spot) * 100
              : ((spot - camp.strike) / spot) * 100;
        } else {
          cushionPct =
            camp.type === 'CALL'
              ? ((spot - camp.strike) / spot) * 100
              : ((camp.strike - spot) / spot) * 100;
        }
      }

      const mark = positionMarks[camp.contractSymbol];
      const openCostBasis =
        camp.openCostBasis !== undefined && camp.openCostBasis !== 0
          ? Math.abs(camp.openCostBasis)
          : mark && mark.costBasisMoney !== 0
          ? Math.abs(mark.costBasisMoney)
          : camp.totalCredits;

      const avgEntryPrice =
        openCostBasis > 0
          ? openCostBasis / numContracts / mult
          : camp.totalCredits > 0
          ? camp.totalCredits /
            Math.max(1, camp.trades.filter((t) => t.quantity < 0).reduce((s, t) => s + Math.abs(t.quantity), 0)) /
            mult
          : 0;

      const markPriceVal =
        camp.currentMarkPrice ??
        mark?.markPrice ??
        Number((avgEntryPrice * Math.min(1, Math.max(0.1, dte / 60))).toFixed(2));

      const profitCapturedPct =
        avgEntryPrice > 0
          ? isShort
            ? Math.max(-300, Math.min(100, Math.round(((avgEntryPrice - markPriceVal) / avgEntryPrice) * 100)))
            : Math.max(-100, Math.min(500, Math.round(((markPriceVal - avgEntryPrice) / avgEntryPrice) * 100)))
          : 0;

      const unrealizedPnlNative =
        camp.unrealizedPnl !== undefined
          ? camp.unrealizedPnl
          : isShort
          ? (avgEntryPrice - markPriceVal) * numContracts * mult
          : (markPriceVal - avgEntryPrice) * numContracts * mult;
      const unrealizedPnlBase = unrealizedPnlNative * fx;

      const intrinsicPerShare =
        camp.type === 'CALL' ? Math.max(0, spot - camp.strike) : Math.max(0, camp.strike - spot);
      const extrinsicPerShare = Math.max(0, markPriceVal - intrinsicPerShare);
      const extrinsicRemaining = Number((extrinsicPerShare * numContracts * mult * fx).toFixed(2));
      const thetaPerDay = dte > 0 ? Number((extrinsicRemaining / dte).toFixed(2)) : 0;

      const openCreditDollars = avgEntryPrice * numContracts * mult;
      const collateral = (p.currentShares > 0 && p.realEntryPrice > 0 ? p.realEntryPrice : camp.strike) * numContracts * mult;
      const annualizedApr =
        collateral > 0 && dte > 0 && isShort
          ? Number((((openCreditDollars / collateral) * 365) / dte * 100).toFixed(1))
          : 0;

      let statusTag: ActiveOptionMetric['statusTag'] = 'ACTIVE';
      let statusLabel = `${dte}d to expiry`;

      if (isShort && cushionPct < 5) {
        statusTag = 'TESTED';
        statusLabel = cushionPct < 0 ? `ITM / Tested (${cushionPct.toFixed(1)}%)` : `Near Strike (+${cushionPct.toFixed(1)}%)`;
      } else if (isShort && profitCapturedPct >= 70) {
        statusTag = 'ROLL_CANDIDATE';
        statusLabel = `Roll Candidate (${profitCapturedPct}% captured)`;
      } else if (dte < 14) {
        statusTag = 'EXPIRING_SOON';
        statusLabel = `Expiring Soon (${dte}d left)`;
      } else if (dte >= 14 && dte <= 45) {
        statusTag = 'SWEET_SPOT';
        statusLabel = `Optimal Decay (${dte}d)`;
      } else if (isShort && profitCapturedPct < 0 && cushionPct >= 5) {
        statusTag = 'ACTIVE';
        statusLabel = `OTM (+${cushionPct.toFixed(0)}%) • Mark Up`;
      }

      activeMetrics.push({
        id: camp.id,
        underlying: p.ticker,
        contractSymbol: camp.contractSymbol,
        type: camp.type,
        action: isShort ? 'SHORT' : 'LONG',
        strike: camp.strike,
        spotPrice: spot,
        expiry: camp.expiry,
        dte,
        contracts: numContracts,
        entryPrice: Number(avgEntryPrice.toFixed(2)),
        currentPrice: Number(markPriceVal.toFixed(2)),
        unrealizedPnlNative,
        unrealizedPnlBase,
        strikeCushionPct: Number(cushionPct.toFixed(1)),
        profitCapturedPct,
        extrinsicRemaining,
        annualizedApr,
        thetaPerDay,
        statusTag,
        statusLabel,
        bucket: camp.bucket,
        currency: camp.currency,
      });
    });
  });

  // 2. Open Standalone Options (Bucket B)
  standalonePositions.forEach((sp) => {
    if (sp.status === 'OPEN' && sp.netContracts !== 0) {
      const spot = getSpotForUnderlying(sp.underlying, sp.strike);
      const expiryDate = new Date(sp.expiry);
      const diffMs = expiryDate.getTime() - now.getTime();
      const dte = Math.max(1, Math.round(diffMs / 86400000));
      const numContracts = Math.abs(sp.netContracts) || 1;
      const mult = sp.multiplier || 100;
      const fx = getFxMultiplier(sp.currency, baseCurrency, fxRates);

      const isLong = sp.netContracts > 0;
      const currentMark = sp.currentMarkPrice;
      const pnlPct =
        sp.avgEntryPrice > 0
          ? isLong
            ? Math.round(((currentMark - sp.avgEntryPrice) / sp.avgEntryPrice) * 100)
            : Math.round(((sp.avgEntryPrice - currentMark) / sp.avgEntryPrice) * 100)
          : 0;

      const intrinsicPerShare =
        sp.type === 'CALL' ? Math.max(0, spot - sp.strike) : Math.max(0, sp.strike - spot);
      const extrinsicPerShare = Math.max(0, currentMark - intrinsicPerShare);
      const extrinsicVal = Number((extrinsicPerShare * numContracts * mult * fx).toFixed(2));

      let cushionPct = 0;
      if (spot > 0 && sp.strike > 0) {
        if (isLong) {
          cushionPct =
            sp.type === 'CALL'
              ? ((spot - sp.strike) / spot) * 100
              : ((sp.strike - spot) / spot) * 100;
        } else {
          cushionPct =
            sp.type === 'CALL'
              ? ((sp.strike - spot) / spot) * 100
              : ((spot - sp.strike) / spot) * 100;
        }
      }

      let statusTag: ActiveOptionMetric['statusTag'] = 'ACTIVE';
      let statusLabel = `${isLong ? 'Long' : 'Short'} ${sp.type} (${dte}d)`;
      if (!isLong && cushionPct < 5) {
        statusTag = 'TESTED';
        statusLabel = cushionPct < 0 ? `ITM / Tested (${cushionPct.toFixed(1)}%)` : `Near Strike (+${cushionPct.toFixed(1)}%)`;
      } else if (dte < 14) {
        statusTag = 'EXPIRING_SOON';
        statusLabel = `Expiring Soon (${dte}d left)`;
      } else if (!isLong && pnlPct >= 70) {
        statusTag = 'ROLL_CANDIDATE';
        statusLabel = `Roll Candidate (${pnlPct}% captured)`;
      }

      activeMetrics.push({
        id: sp.id,
        underlying: sp.underlying,
        contractSymbol: sp.contractSymbol,
        type: sp.type,
        action: isLong ? 'LONG' : 'SHORT',
        strike: sp.strike,
        spotPrice: spot,
        expiry: sp.expiry,
        dte,
        contracts: numContracts,
        entryPrice: Number(sp.avgEntryPrice.toFixed(2)),
        currentPrice: Number(currentMark.toFixed(2)),
        unrealizedPnlNative: sp.unrealizedPnl,
        unrealizedPnlBase: sp.unrealizedPnl * fx,
        strikeCushionPct: Number(cushionPct.toFixed(1)),
        profitCapturedPct: pnlPct,
        extrinsicRemaining: extrinsicVal,
        annualizedApr: 0,
        thetaPerDay: dte > 0 ? Number((extrinsicVal / dte).toFixed(2)) : 0,
        statusTag,
        statusLabel,
        bucket: 'STANDALONE',
        currency: sp.currency,
      });
    }
  });

  activeMetrics.sort((a, b) => a.dte - b.dte);
  return activeMetrics;
}

/**
 * Reconciled Capital Allocation & Currency Buckets (FX Exposure)
 * Decomposes 100% of Net Liq Value (Equities MV + Open Options Net MV + Available Cash by Currency)
 * into USD Bucket vs EUR Bucket in Base Reporting Currency.
 */
export function computeCapitalAllocation(
  positions: StockPosition[],
  standalonePositions: StandaloneOptionPosition[],
  _transactions: Transaction[],
  baseCurrency: 'EUR' | 'USD' = 'EUR',
  fxRates: Record<string, number> = {},
  endingCashBase?: number,
  cashByCurrency?: Record<string, number>,
  closedPositions: StockPosition[] = []
): CapitalAllocation {
  let usdAmount = 0;
  let eurAmount = 0;
  let equityValue = 0;
  let cashCollateral = 0;
  let openOptionsNetValue = 0;

  // 1. Active Equities Market Value
  positions.forEach((p) => {
    const fx = getFxMultiplier(p.currency, baseCurrency, fxRates);
    const valBase = p.marketValue * fx;
    equityValue += valBase;
    if (p.currency === 'EUR') eurAmount += valBase;
    else usdAmount += valBase;
  });

  // 2. Open Linked Options Net Market Value & Short Put Collateral
  [...positions, ...closedPositions].forEach((p) => {
    p.linkedOptionCampaigns.forEach((camp) => {
      if (camp.status === 'OPEN' && camp.netContracts !== 0) {
        const fx = getFxMultiplier(camp.currency, baseCurrency, fxRates);
        const mvBase = (camp.marketValue || 0) * fx;
        openOptionsNetValue += mvBase;
        if (camp.currency === 'EUR') eurAmount += mvBase;
        else usdAmount += mvBase;

        if (camp.type === 'PUT' && camp.netContracts < 0) {
          cashCollateral += camp.strike * (camp.multiplier || 100) * Math.abs(camp.netContracts) * fx;
        }
      }
    });
  });

  // 3. Open Standalone Options Net Market Value
  let standaloneOptionsValue = 0;
  standalonePositions.forEach((sp) => {
    if (sp.status === 'OPEN' && sp.netContracts !== 0) {
      const fx = getFxMultiplier(sp.currency, baseCurrency, fxRates);
      const mvBase = sp.marketValue * fx;
      standaloneOptionsValue += mvBase;
      openOptionsNetValue += mvBase;
      if (sp.currency === 'EUR') eurAmount += mvBase;
      else usdAmount += mvBase;

      if (sp.type === 'PUT' && sp.netContracts < 0) {
        cashCollateral += sp.strike * (sp.multiplier || 100) * Math.abs(sp.netContracts) * fx;
      }
    }
  });

  // 4. Cash Buffer broken down by currency bucket
  let freeCashBuffer = 0;
  const hasPerCurrencyCash = cashByCurrency && Object.keys(cashByCurrency).length > 0;
  if (hasPerCurrencyCash) {
    let cashSumBase = 0;
    for (const [cur, amt] of Object.entries(cashByCurrency!)) {
      const amtBase = amt * getFxMultiplier(cur, baseCurrency, fxRates);
      cashSumBase += amtBase;
      if (cur.toUpperCase() === 'EUR') eurAmount += amtBase;
      else usdAmount += amtBase;
    }
    freeCashBuffer = cashSumBase;
  } else if (endingCashBase !== undefined) {
    freeCashBuffer = endingCashBase;
    if (baseCurrency === 'EUR') eurAmount += freeCashBuffer;
    else usdAmount += freeCashBuffer;
  }

  const totalCapital = equityValue + openOptionsNetValue + freeCashBuffer;
  const totalCur = usdAmount + eurAmount;
  const usdPercent = totalCur > 0 ? Number(((usdAmount / totalCur) * 100).toFixed(1)) : 0;
  const eurPercent = totalCur > 0 ? Number((100 - usdPercent).toFixed(1)) : 0;
  const usdToEurRate = getFxMultiplier('USD', 'EUR', fxRates);

  return {
    equityValue,
    cashCollateral,
    standaloneOptionsValue,
    freeCashBuffer,
    totalCapital,
    usdAmount,
    eurAmount,
    usdPercent,
    eurPercent,
    usdToEurRate,
  };
}

/**
 * Advanced Quantitative KPIs (XIRR, Return on Margin, Annualized APR, Theta Decay)
 */
export function computeAdvancedKPIs(
  transactions: Transaction[],
  totalMarketValue: number,
  totalRawCostBasis: number,
  activeOptions: ActiveOptionMetric[],
  baseCurrency: 'EUR' | 'USD' = 'EUR',
  fxRates: Record<string, number> = {}
): AdvancedKPIs {
  const cashFlows: Array<{ date: string; amount: number }> = [];
  let totalDeposits = 0;

  transactions.forEach((tx) => {
    const fx = getFxMultiplier(tx.currency, baseCurrency, fxRates, tx.fxRateToBase);
    const netBase = tx.netCashFlow * fx;
    cashFlows.push({
      date: tx.date || tx.dateTime.slice(0, 10),
      amount: netBase,
    });
    if (netBase < 0) {
      totalDeposits += Math.abs(netBase);
    }
  });

  cashFlows.push({
    date: new Date().toISOString().slice(0, 10),
    amount: totalMarketValue,
  });

  const xirrPct = calculateXIRR(cashFlows);

  const totalCredits = transactions
    .filter((tx) => tx.assetCategory === 'OPT' && tx.netCashFlow > 0 && tx.bucket === 'LINKED')
    .reduce((sum, tx) => sum + tx.netCashFlow * getFxMultiplier(tx.currency, baseCurrency, fxRates, tx.fxRateToBase), 0);

  const returnOnMarginPct =
    totalRawCostBasis > 0 ? Number(((totalCredits / totalRawCostBasis) * 100).toFixed(1)) : 0;

  const shortOptions = activeOptions.filter((o) => o.action === 'SHORT' && o.annualizedApr > 0);
  const annualizedAprPct =
    shortOptions.length > 0
      ? Number((shortOptions.reduce((acc, opt) => acc + opt.annualizedApr, 0) / shortOptions.length).toFixed(1))
      : 0;

  const dailyThetaDollars = Math.round(
    activeOptions.filter((o) => o.action === 'SHORT').reduce((acc, opt) => acc + opt.thetaPerDay, 0)
  );

  const netGainDollars = totalMarketValue - totalRawCostBasis;

  return {
    xirrPct,
    returnOnMarginPct,
    annualizedAprPct,
    dailyThetaDollars,
    totalDeposits,
    netGainDollars,
  };
}

