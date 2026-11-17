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
import { getFxMultiplier, calculateDownsideCushionPct } from './portfolioEngine';

/**
 * Newton-Raphson XIRR implementation
 * cashFlows: { date: 'YYYY-MM-DD', amount: negative for outflows/buys, positive for inflows/sales/dividends/terminal value }
 */
export function calculateXIRR(cashFlows: Array<{ date: string; amount: number }>): number {
  if (cashFlows.length < 2) return 0;

  const sorted = cashFlows
    .filter((cf) => Math.abs(cf.amount) > 0.0001)
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
  const maxIterations = 60;
  const tolerance = 1e-6;

  for (let iter = 0; iter < maxIterations; iter++) {
    const y = f(r);
    const dy = df(r);
    if (Math.abs(dy) < 1e-12) break;

    const nextR = r - y / dy;
    if (isNaN(nextR) || !isFinite(nextR)) break;

    if (Math.abs(nextR - r) < tolerance) {
      return Number((nextR * 100).toFixed(2));
    }
    r = Math.max(-0.99, Math.min(10.0, nextR));
  }

  return Number((r * 100).toFixed(2));
}

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
    const estimatedSpot = Number(Math.max(0.01, baseSpot).toFixed(2));

    const savingPerShare = Math.max(0, step.rawAvgCostAfter - step.realEntryPriceAfter);
    const currentCushion = calculateDownsideCushionPct(estimatedSpot, step.realEntryPriceAfter);

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

  // Track closed standalone cashflows properly
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
        // Only count realized P&L on standalone options (avoids counting open LEAP buys as losses)
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
      standalonePnl: standalonePnl,
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
 * Extract Active Open Options metrics (DTE, Cushion %, % Profit Captured, Extrinsic Value, APR)
 */
export function computeActiveOptions(
  positions: StockPosition[],
  standalonePositions: StandaloneOptionPosition[],
  quotes: Record<string, StockQuote> = {},
  positionMarks: Record<string, PositionMark> = {},
  baseCurrency: 'EUR' | 'USD' = 'EUR',
  fxRates: Record<string, number> = {}
): ActiveOptionMetric[] {
  const activeMetrics: ActiveOptionMetric[] = [];
  const now = new Date();

  const getSpotForUnderlying = (underlying: string, _currency: string, fallbackStrike: number): number => {
    const pos = positions.find((p) => p.ticker === underlying);
    if (pos && pos.spotPrice > 0) return pos.spotPrice;
    if (positionMarks[underlying]?.markPrice) return positionMarks[underlying].markPrice;
    const q = quotes[underlying];
    if (q && q.regularMarketPrice > 0) return q.regularMarketPrice;
    return fallbackStrike;
  };

  // 1. Linked Covered Calls and Short Options from active positions
  positions.forEach((p) => {
    const spot = p.spotPrice || getSpotForUnderlying(p.ticker, p.currency, 0);

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
      if (camp.type === 'CALL') {
        cushionPct = spot > 0 ? ((camp.strike - spot) / spot) * 100 : 0;
      } else {
        cushionPct = spot > 0 ? ((spot - camp.strike) / spot) * 100 : 0;
      }

      const mark = positionMarks[camp.contractSymbol];
      const openCreditBasis = mark && mark.costBasisMoney !== 0
        ? Math.abs(mark.costBasisMoney) / numContracts / mult
        : camp.totalCredits > 0
        ? camp.totalCredits / Math.max(1, camp.trades.filter((t) => t.quantity < 0).reduce((s, t) => s + Math.abs(t.quantity), 0)) / mult
        : 0;
      const originalPremium = openCreditBasis;
      const markPriceVal = mark?.markPrice ?? Number((originalPremium * Math.min(1, Math.max(0.1, dte / 60))).toFixed(2));

      const profitCapturedPct = originalPremium > 0
        ? Math.max(-200, Math.min(100, Math.round(((originalPremium - markPriceVal) / originalPremium) * 100)))
        : 0;

      const intrinsicPerShare =
        camp.type === 'CALL'
          ? Math.max(0, spot - camp.strike)
          : Math.max(0, camp.strike - spot);
      const extrinsicPerShare = Math.max(0, markPriceVal - intrinsicPerShare);
      const extrinsicRemaining = Number((extrinsicPerShare * numContracts * mult * fx).toFixed(2));
      const thetaPerDay = dte > 0 ? Number((extrinsicRemaining / dte).toFixed(2)) : 0;

      const openCreditDollars = originalPremium * numContracts * mult;
      const collateral = (p.currentShares > 0 ? Math.max(0.01, p.realEntryPrice) : camp.strike) * numContracts * mult;
      const annualizedApr = collateral > 0 && dte > 0
        ? Number((((openCreditDollars / collateral) * 365) / dte * 100).toFixed(1))
        : 0;

      let statusTag: ActiveOptionMetric['statusTag'] = 'ACTIVE';
      let statusLabel = `${dte}d to expiry`;

      if (profitCapturedPct >= 70) {
        statusTag = 'ROLL_CANDIDATE';
        statusLabel = `Roll Candidate (${profitCapturedPct}% captured)`;
      } else if (dte >= 14 && dte <= 45) {
        statusTag = 'SWEET_SPOT';
        statusLabel = `Optimal Decay Zone (${dte}d)`;
      } else if (dte < 14) {
        statusTag = 'EXPIRING_SOON';
        statusLabel = `Expiring Soon (${dte}d left)`;
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
        entryPrice: Number(originalPremium.toFixed(2)),
        currentPrice: Number(markPriceVal.toFixed(2)),
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
      const spot = getSpotForUnderlying(sp.underlying, sp.currency, sp.strike);
      const expiryDate = new Date(sp.expiry);
      const diffMs = expiryDate.getTime() - now.getTime();
      const dte = Math.max(1, Math.round(diffMs / 86400000));
      const numContracts = Math.abs(sp.netContracts) || 1;
      const mult = sp.multiplier || 100;
      const fx = getFxMultiplier(sp.currency, baseCurrency, fxRates);

      const isLong = sp.netContracts > 0;
      const currentMark = sp.currentMarkPrice;
      const pnlPct = sp.avgEntryPrice > 0
        ? isLong
          ? Math.round(((currentMark - sp.avgEntryPrice) / sp.avgEntryPrice) * 100)
          : Math.round(((sp.avgEntryPrice - currentMark) / sp.avgEntryPrice) * 100)
        : 0;

      const intrinsicPerShare =
        sp.type === 'CALL'
          ? Math.max(0, spot - sp.strike)
          : Math.max(0, sp.strike - spot);
      const extrinsicPerShare = Math.max(0, currentMark - intrinsicPerShare);
      const extrinsicVal = Number((extrinsicPerShare * numContracts * mult * fx).toFixed(2));
      const cushionPct =
        sp.type === 'CALL'
          ? spot > 0 ? ((sp.strike - spot) / spot) * 100 : 0
          : spot > 0 ? ((spot - sp.strike) / spot) * 100 : 0;

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
        strikeCushionPct: Number(cushionPct.toFixed(1)),
        profitCapturedPct: Math.max(0, Math.min(100, pnlPct)),
        extrinsicRemaining: extrinsicVal,
        annualizedApr: 0,
        thetaPerDay: dte > 0 ? Number((extrinsicVal / dte).toFixed(2)) : 0,
        statusTag: 'ACTIVE',
        statusLabel: `${isLong ? 'Long' : 'Short'} ${sp.type} (${dte}d)`,
        bucket: 'STANDALONE',
        currency: sp.currency,
      });
    }
  });

  activeMetrics.sort((a, b) => a.dte - b.dte);
  return activeMetrics;
}

/**
 * Capital Allocation across Equity, Cash Collateral, Standalone Options, and Cash Buffer (in baseCurrency)
 */
export function computeCapitalAllocation(
  positions: StockPosition[],
  standalonePositions: StandaloneOptionPosition[],
  transactions: Transaction[],
  baseCurrency: 'EUR' | 'USD' = 'EUR',
  fxRates: Record<string, number> = {},
  endingCashBase?: number
): CapitalAllocation {
  let usdAmount = 0;
  let eurAmount = 0;

  let equityValue = 0;
  positions.forEach((p) => {
    const fx = getFxMultiplier(p.currency, baseCurrency, fxRates);
    const valBase = p.marketValue * fx;
    equityValue += valBase;
    if (p.currency === 'EUR') eurAmount += valBase;
    else usdAmount += valBase;
  });

  // Cash Collateral for open CSPs
  let cashCollateral = 0;
  positions.forEach((p) => {
    p.linkedOptionCampaigns.forEach((camp) => {
      if (camp.status === 'OPEN' && camp.type === 'PUT' && camp.netContracts < 0) {
        const fx = getFxMultiplier(camp.currency, baseCurrency, fxRates);
        const col = camp.strike * (camp.multiplier || 100) * Math.abs(camp.netContracts) * fx;
        cashCollateral += col;
        if (camp.currency === 'EUR') eurAmount += col;
        else usdAmount += col;
      }
    });
  });

  // Standalone open options current market value (or open cost)
  let standaloneOptionsValue = 0;
  standalonePositions.forEach((sp) => {
    if (sp.status === 'OPEN') {
      const fx = getFxMultiplier(sp.currency, baseCurrency, fxRates);
      const val = Math.max(0, sp.marketValue) * fx;
      standaloneOptionsValue += val;
      if (sp.currency === 'EUR') eurAmount += val;
      else usdAmount += val;
    }
  });

  const freeCashBuffer =
    endingCashBase !== undefined && endingCashBase >= 0
      ? Math.round(endingCashBase)
      : Math.round(equityValue * 0.12);

  if (baseCurrency === 'EUR') eurAmount += freeCashBuffer;
  else usdAmount += freeCashBuffer;

  const totalCapital = Math.max(1, equityValue + cashCollateral + standaloneOptionsValue + freeCashBuffer);
  const totalCur = Math.max(1, usdAmount + eurAmount);

  const usdPercent = Number(((usdAmount / totalCur) * 100).toFixed(1));
  const eurPercent = Number(((eurAmount / totalCur) * 100).toFixed(1));

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

  const returnOnMarginPct = totalRawCostBasis > 0
    ? Number((((totalCredits / totalRawCostBasis)) * 100).toFixed(1))
    : 0;

  const shortOptions = activeOptions.filter((o) => o.action === 'SHORT' && o.annualizedApr > 0);
  const annualizedAprPct = shortOptions.length > 0
    ? Number((shortOptions.reduce((acc, opt) => acc + opt.annualizedApr, 0) / shortOptions.length).toFixed(1))
    : 0;

  const dailyThetaDollars = Math.round(
    activeOptions
      .filter((o) => o.action === 'SHORT')
      .reduce((acc, opt) => acc + opt.thetaPerDay, 0)
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
