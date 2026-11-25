/**
 * Filtered Journal Engine
 *
 * Pure quantitative & signal engine powering the Filtered Journal deep-dive panel:
 * - Reuses existing IBKR/Portfolio campaign data (dates, costs, qty, exits, P&L)
 * - Fixed 1R position risk (default 100 in position currency) for R-multiple evaluation
 * - Stock position sizing from entry, stop, and 1R; Options sized at 1R premium with no stop
 * - 4-state left-edge outline signal logic (RED > AMBER > GREEN / GREY) with source + timestamp
 * - Default attention-first sort (Red, Amber, Green, Grey -> nearest catalyst/expiry)
 * - Closed-trade expectancy, R-dot strip, equity curve, gap slippage, holding days & 30+ field correlation
 */

import {
  UnifiedTickerSummary,
  CampaignComparisonItem,
  StockQuote,
  PositionMark,
  JournalTradeOverride,
  JournalSettings,
  SecTickerFilings,
  SecFilingItem,
  JournalDerivedTrade,
  JournalSignalColor,
  JournalSignalReason,
  JournalCatalystType,
  JournalSavedView,
  JournalTradeIntel,
} from '../types';
import { getFxMultiplier } from './portfolioEngine';

export const CATALYST_TYPES: JournalCatalystType[] = [
  'Earnings',
  'Clinical / FDA',
  'Insider Cluster',
  'Activist / 13D',
  'M&A / Spin-off',
  'Product / Contract',
  'Macro / Technical',
  'Other',
];

export const EXIT_REASONS: Array<{ value: 'stop' | 'target' | 'thesis_broke' | 'gap' | 'expiry'; label: string }> = [
  { value: 'stop', label: 'Stop Hit' },
  { value: 'target', label: 'Target Reached' },
  { value: 'thesis_broke', label: 'Thesis Broke' },
  { value: 'gap', label: 'Gap Slippage' },
  { value: 'expiry', label: 'Option Expiry' },
];

const SIGNAL_PRIORITY: Record<JournalSignalColor, number> = {
  RED: 0,
  AMBER: 1,
  GREEN: 2,
  GREY: 3,
};

function daysBetween(fromIso: string, toMs: number): number | undefined {
  if (!fromIso) return undefined;
  const ms = new Date(fromIso.slice(0, 10) + 'T00:00:00Z').getTime();
  if (isNaN(ms)) return undefined;
  return Math.round((ms - toMs) / 86400000);
}

export function detectAutoInsiderCluster(filings: SecFilingItem[], nowMs: number): boolean {
  const cutoffMs = nowMs - 45 * 86400000;
  const recentForm4s = filings.filter((f) => {
    if (f.form !== '4' && f.form !== '4/A') return false;
    const fMs = new Date(f.filingDate + 'T00:00:00Z').getTime();
    return !isNaN(fMs) && fMs >= cutoffMs;
  });
  if (recentForm4s.length < 2) return false;

  // If XML form4Summary is available on any recent Form 4, require genuine open-market buys (Code P)
  const hasParsedSummary = recentForm4s.some((f) => Boolean(f.form4Summary));
  if (hasParsedSummary) {
    const openMarketBuys = recentForm4s.filter((f) => f.form4Summary?.isOpenMarketBuy === true);
    return openMarketBuys.length >= 2;
  }

  return recentForm4s.length >= 2;
}

export function getNewTriggerFilings(
  filings: SecFilingItem[],
  lastViewedAt: string | undefined,
  nowMs: number
): SecFilingItem[] {
  // Ignore routine compensation/tax Form 4 filings (A, M, F, G) when XML parsing confirmed routine noise
  const triggerOnly = filings.filter(
    (f) => f.isTriggerForm && !(f.form4Summary && f.form4Summary.isRoutineNoise)
  );
  if (triggerOnly.length === 0) return [];

  if (lastViewedAt) {
    const viewedDate = lastViewedAt.slice(0, 10);
    return triggerOnly.filter((f) => f.filingDate > viewedDate);
  }

  // Never viewed yet: flag trigger filings from the last 14 days
  const recentCutoff = nowMs - 14 * 86400000;
  return triggerOnly.filter((f) => {
    const fMs = new Date(f.filingDate + 'T00:00:00Z').getTime();
    return !isNaN(fMs) && fMs >= recentCutoff;
  });
}

function buildJournalTradeFromCampaign(
  ut: UnifiedTickerSummary,
  camp: CampaignComparisonItem,
  quotes: Record<string, StockQuote>,
  quotesFetchedAt: string | undefined,
  positionMarks: Record<string, PositionMark>,
  fxRates: Record<string, number>,
  baseCurrency: 'EUR' | 'USD',
  override: JournalTradeOverride,
  settings: JournalSettings,
  secInfo: SecTickerFilings | undefined,
  nowMs: number,
  intel?: JournalTradeIntel
): JournalDerivedTrade {
  const isStock = camp.kind === 'STOCK_LOT';
  const instrument: 'STOCK' | 'OPTION' = isStock ? 'STOCK' : 'OPTION';
  const currency = camp.currency || ut.currency || 'USD';
  const fxToBase = getFxMultiplier(currency, baseCurrency, fxRates);

  const sortedTrades = [...camp.trades].sort(
    (a, b) => (new Date(a.dateTime).getTime() || 0) - (new Date(b.dateTime).getTime() || 0)
  );
  const firstTrade = sortedTrades[0];
  const lastTrade = sortedTrades[sortedTrades.length - 1];
  const entryDate = firstTrade?.date || firstTrade?.dateTime?.slice(0, 10) || '';
  const exitDate = camp.status === 'CLOSED' ? lastTrade?.date || lastTrade?.dateTime?.slice(0, 10) : undefined;

  const entryMs = entryDate ? new Date(entryDate + 'T00:00:00Z').getTime() : nowMs;
  const endMs =
    camp.status === 'CLOSED' && exitDate
      ? new Date(exitDate + 'T00:00:00Z').getTime()
      : nowMs;
  const holdingDays = !isNaN(entryMs) && !isNaN(endMs) ? Math.max(0, Math.round((endMs - entryMs) / 86400000)) : camp.holdingDays;

  const multiplier = firstTrade?.multiplier || (isStock ? 1 : 100);
  const quantity = isStock
    ? camp.status === 'OPEN'
      ? ut.currentShares
      : sortedTrades.filter((t) => t.quantity > 0).reduce((s, t) => s + Math.abs(t.quantity), 0)
    : camp.status === 'OPEN'
    ? Math.abs(camp.netContracts || 0)
    : Math.max(
        1,
        sortedTrades
          .filter((t) => (firstTrade?.action === 'SELL' ? t.quantity < 0 : t.quantity > 0))
          .reduce((s, t) => s + Math.abs(t.quantity), 0)
      );

  const isShortOption = !isStock && ((camp.netContracts || 0) < 0 || (camp.status === 'CLOSED' && firstTrade?.action === 'SELL'));
  const displayType = isStock ? 'Stock' : camp.strategyType;

  // Entry price
  let entryPrice = 0;
  if (isStock) {
    if (camp.status === 'OPEN' && ut.rawAvgEntry > 0) {
      entryPrice = ut.rawAvgEntry;
    } else if (quantity > 0) {
      entryPrice = camp.capitalDeployedNative / quantity;
    } else {
      entryPrice = firstTrade?.price || 0;
    }
  } else {
    const openLegs = sortedTrades.filter((t) => (isShortOption ? t.quantity < 0 : t.quantity > 0));
    const openQtySum = openLegs.reduce((s, t) => s + Math.abs(t.quantity), 0);
    const openValSum = openLegs.reduce((s, t) => s + Math.abs(t.quantity) * t.price, 0);
    entryPrice = openQtySum > 0 ? openValSum / openQtySum : firstTrade?.price || 0;
  }

  // Current price & provenance
  const liveQuote = quotes[ut.ticker];
  const optionMark = !isStock ? positionMarks[camp.contractSymbol] : undefined;
  const stockMark = isStock ? positionMarks[ut.ticker] : undefined;
  let currentPrice = 0;
  let priceSource: 'Yahoo Finance' | 'IBKR XML Mark' | 'Manual Override' | 'Missing' = 'Missing';
  let priceTimestamp: string | undefined;
  let priceIsStale = false;

  if (camp.status === 'CLOSED') {
    currentPrice = lastTrade?.price || 0;
    priceSource = 'IBKR XML Mark';
    priceTimestamp = lastTrade?.dateTime || exitDate;
  } else if (override.manualPriceOverride !== undefined && override.manualPriceOverride > 0) {
    currentPrice = override.manualPriceOverride;
    priceSource = 'Manual Override';
    priceTimestamp = override.manualPriceTimestamp;
  } else if (isStock) {
    if (liveQuote && liveQuote.regularMarketPrice > 0) {
      currentPrice = liveQuote.regularMarketPrice;
      priceSource = 'Yahoo Finance';
      priceTimestamp = quotesFetchedAt;
      if (quotesFetchedAt) {
        const ageMs = nowMs - new Date(quotesFetchedAt).getTime();
        if (ageMs > 24 * 60 * 60 * 1000) priceIsStale = true;
      }
    } else if (ut.spotPrice > 0 || (stockMark && stockMark.markPrice > 0)) {
      currentPrice = ut.spotPrice || stockMark?.markPrice || 0;
      priceSource = 'IBKR XML Mark';
      priceIsStale = true; // Static XML mark without live refresh
    } else {
      priceSource = 'Missing';
      priceIsStale = true;
    }
  } else {
    // Open option mark price
    if (optionMark && optionMark.markPrice > 0) {
      currentPrice = optionMark.markPrice;
      priceSource = 'IBKR XML Mark';
      // Mark price is static from statement until next import or manual override
      priceIsStale = false;
    } else if (entryPrice > 0) {
      currentPrice = entryPrice;
      priceSource = 'IBKR XML Mark';
      priceIsStale = true;
    } else {
      priceSource = 'Missing';
      priceIsStale = true;
    }
  }

  // Fixed 1R risk (in native currency, default 100)
  const risk1RNative =
    override.riskPerTrade !== undefined && override.riskPerTrade > 0
      ? override.riskPerTrade
      : settings.defaultRisk1R > 0
      ? settings.defaultRisk1R
      : 100;
  const risk1RBase = risk1RNative * fxToBase;

  // P&L calculation (always consistent with resolved currentPrice for open positions)
  let pnlNative = camp.status === 'OPEN' ? camp.unrealizedPnlNative : camp.realizedPnlNative;
  if (camp.status === 'OPEN' && isStock && currentPrice > 0 && entryPrice > 0) {
    pnlNative = (currentPrice - entryPrice) * quantity;
  } else if (camp.status === 'OPEN' && !isStock && override.manualPriceOverride !== undefined && override.manualPriceOverride > 0) {
    const signedContracts = camp.netContracts || (isShortOption ? -quantity : quantity);
    pnlNative = signedContracts * (override.manualPriceOverride - entryPrice) * multiplier;
  }
  const pnlBase = pnlNative * fxToBase;
  const currentR = risk1RNative > 0 ? pnlNative / risk1RNative : 0;

  // Stock stop, targets, sizing & open risk
  const stopPrice = isStock && override.stopPrice && override.stopPrice > 0 ? override.stopPrice : undefined;
  const target1 = isStock && override.target1 && override.target1 > 0 ? override.target1 : undefined;
  const target2 = isStock && override.target2 && override.target2 > 0 ? override.target2 : undefined;
  const target3 = isStock && override.target3 && override.target3 > 0 ? override.target3 : undefined;

  let plannedSizeUnits: number | undefined;
  let openRiskNative = 0;
  let stopDistancePct: number | undefined;

  if (isStock) {
    if (stopPrice !== undefined && entryPrice > stopPrice) {
      const riskPerShare = entryPrice - stopPrice;
      plannedSizeUnits = Math.max(1, Math.floor(risk1RNative / riskPerShare));
      openRiskNative = camp.status === 'OPEN' ? riskPerShare * quantity : 0;
      if (currentPrice > 0) {
        stopDistancePct = ((currentPrice - stopPrice) / riskPerShare) * 100;
      }
    } else if (camp.status === 'OPEN') {
      openRiskNative = risk1RNative;
    }
  } else {
    // Options: premium paid is sized at 1R. No stop is used.
    const contractPremium = entryPrice * multiplier;
    if (contractPremium > 0) {
      plannedSizeUnits = Math.max(1, Math.floor(risk1RNative / contractPremium));
    }
    if (camp.status === 'OPEN') {
      openRiskNative = !isShortOption
        ? Math.max(0, camp.capitalDeployedNative || contractPremium * quantity)
        : risk1RNative;
    }
  }
  const openRiskBase = openRiskNative * fxToBase;

  // Option-specific columns
  let premiumPaidNative: number | undefined;
  let currentOptionValueNative: number | undefined;
  let premiumChangePct: number | undefined;
  let breakevenPrice: number | undefined;
  let breakevenDiffPct: number | undefined;
  const spotPrice = liveQuote?.regularMarketPrice || ut.spotPrice || 0;

  if (!isStock) {
    // Use actual open cost basis (IBKR mark costBasisMoney) when open so partial closes never inflate premium paid
    const openBasisAbs =
      camp.status === 'OPEN' && optionMark && Math.abs(optionMark.costBasisMoney) > 0
        ? Math.abs(optionMark.costBasisMoney)
        : entryPrice * multiplier * quantity;
    premiumPaidNative = openBasisAbs > 0 ? openBasisAbs : camp.capitalDeployedNative;
    currentOptionValueNative =
      camp.status === 'OPEN'
        ? currentPrice * multiplier * quantity
        : Math.max(0, premiumPaidNative + pnlNative);
    if (premiumPaidNative > 0) {
      premiumChangePct = isShortOption
        ? ((premiumPaidNative - currentOptionValueNative) / premiumPaidNative) * 100
        : ((currentOptionValueNative - premiumPaidNative) / premiumPaidNative) * 100;
    }
    if (camp.strike && camp.strike > 0) {
      const effectiveEntryPerShare =
        quantity > 0 && multiplier > 0 && premiumPaidNative > 0
          ? premiumPaidNative / (quantity * multiplier)
          : entryPrice;
      breakevenPrice =
        camp.optionType === 'CALL'
          ? camp.strike + effectiveEntryPerShare
          : camp.strike - effectiveEntryPerShare;
      if (spotPrice > 0 && breakevenPrice > 0) {
        const bullish = (camp.optionType === 'CALL' && !isShortOption) || (camp.optionType === 'PUT' && isShortOption);
        breakevenDiffPct = bullish
          ? ((spotPrice - breakevenPrice) / spotPrice) * 100
          : ((breakevenPrice - spotPrice) / spotPrice) * 100;
      }
    }
  }

  // Dates: catalyst & expiry
  const catalystType: JournalCatalystType = override.catalystType || 'Other';
  const catalystDate = override.catalystDate || undefined;
  const expiry = !isStock ? camp.expiry : undefined;
  const dte =
    !isStock && camp.status === 'OPEN' && expiry
      ? Math.max(0, daysBetween(expiry, nowMs) ?? camp.dte ?? 0)
      : camp.dte;

  const daysToCatalyst = catalystDate ? daysBetween(catalystDate, nowMs) : undefined;
  const candidateEvents: Array<{ date: string; days: number }> = [];
  if (catalystDate && daysToCatalyst !== undefined && daysToCatalyst >= -1) {
    candidateEvents.push({ date: catalystDate, days: daysToCatalyst });
  }
  if (expiry && dte !== undefined && camp.status === 'OPEN') {
    candidateEvents.push({ date: expiry, days: dte });
  }
  candidateEvents.sort((a, b) => a.days - b.days);
  const nextEventDate = candidateEvents[0]?.date;
  const daysToNextEvent = candidateEvents[0]?.days;

  // SEC Filings
  const secFilings = secInfo?.filings || [];
  const secStatus = secInfo?.status || 'IDLE';
  const secFetchedAt = secInfo?.fetchedAt;
  const newTriggerFilings = camp.status === 'OPEN' ? getNewTriggerFilings(secFilings, override.lastViewedAt, nowMs) : [];

  const autoInsiderCluster = detectAutoInsiderCluster(secFilings, nowMs);
  const loggedFields = {
    insiderCluster: override.loggedFields?.insiderCluster ?? (catalystType === 'Insider Cluster' || autoInsiderCluster),
    preCatalystEntry: override.loggedFields?.preCatalystEntry ?? false,
    asymmetricRR: override.loggedFields?.asymmetricRR ?? false,
    volumeConfirmed: override.loggedFields?.volumeConfirmed ?? false,
    sectorTailwind: override.loggedFields?.sectorTailwind ?? false,
  };
  const hasInsiderCluster = Boolean(loggedFields.insiderCluster || catalystType === 'Insider Cluster' || autoInsiderCluster);

  // ------------------------------------------------------------------
  // 4-STATE LEFT-EDGE OUTLINE SIGNAL EVALUATION (NO popups / badges)
  // ------------------------------------------------------------------
  const signalReasons: JournalSignalReason[] = [];

  if (camp.status === 'OPEN') {
    // RED triggers
    if (override.thesisBroken) {
      signalReasons.push({
        level: 'RED',
        code: 'THESIS_BROKEN',
        detail: 'Thesis manually marked broken',
        source: 'Journal Override',
      });
    }
    if (isStock && stopPrice !== undefined && currentPrice > 0 && currentPrice <= stopPrice) {
      signalReasons.push({
        level: 'RED',
        code: 'STOP_HIT',
        detail: `Price ${currency === 'EUR' ? '€' : '$'}${currentPrice.toFixed(2)} hit stop ${currency === 'EUR' ? '€' : '$'}${stopPrice.toFixed(2)}`,
        source: priceSource,
        timestamp: priceTimestamp,
      });
    }
    if (currentR < -1.0001) {
      signalReasons.push({
        level: 'RED',
        code: 'LOSS_EXCEEDED_1R',
        detail: `Loss (${currentR.toFixed(2)}R) exceeded planned -1.00R risk (${currency === 'EUR' ? '€' : '$'}${risk1RNative.toFixed(0)})`,
        source: priceSource,
        timestamp: priceTimestamp,
      });
    }

    // AMBER triggers
    if (newTriggerFilings.length > 0) {
      const formsList = Array.from(new Set(newTriggerFilings.map((f) => f.form))).join(', ');
      signalReasons.push({
        level: 'AMBER',
        code: 'NEW_FILING',
        detail: `${newTriggerFilings.length} new SEC filing(s) since last view: ${formsList} (latest ${newTriggerFilings[0].filingDate})`,
        source: 'SEC EDGAR',
        timestamp: secFetchedAt,
      });
    }
    if (daysToCatalyst !== undefined && daysToCatalyst >= 0 && daysToCatalyst <= 14) {
      signalReasons.push({
        level: 'AMBER',
        code: 'CATALYST_SOON',
        detail: `Catalyst (${catalystType}) in ${daysToCatalyst}d (${catalystDate})`,
        source: 'Journal Plan',
      });
    }
    if (!isStock && dte !== undefined && dte >= 0 && dte <= 14) {
      signalReasons.push({
        level: 'AMBER',
        code: 'EXPIRY_SOON',
        detail: `Option expires in ${dte}d (${expiry})`,
        source: 'IBKR Contract',
      });
    }
    if (
      isStock &&
      stopPrice !== undefined &&
      stopDistancePct !== undefined &&
      currentPrice > stopPrice &&
      stopDistancePct <= 20
    ) {
      signalReasons.push({
        level: 'AMBER',
        code: 'NEAR_STOP',
        detail: `Price within ${stopDistancePct.toFixed(1)}% of stop distance (Stop ${currency === 'EUR' ? '€' : '$'}${stopPrice.toFixed(2)})`,
        source: priceSource,
        timestamp: priceTimestamp,
      });
    }
    if (intel?.thesisCheck?.verdict === 'RISK') {
      signalReasons.push({
        level: 'AMBER',
        code: 'AI_THESIS_RISK',
        detail: `Filing / news thesis check flagged risk: ${intel.thesisCheck.summary}`,
        source: intel.source,
        timestamp: intel.analyzedAt,
      });
    }
    if (intel?.catalystRadar?.timelineDrift === 'DELAYED') {
      signalReasons.push({
        level: 'AMBER',
        code: 'CATALYST_DELAYED',
        detail: intel.catalystRadar.driftNote || `Catalyst timeline delayed (${intel.catalystRadar.eventLabel})`,
        source: intel.source,
        timestamp: intel.analyzedAt,
      });
    }
    if (!isStock && expiry) {
      const effectiveCatDate = catalystDate || intel?.catalystRadar?.suggestedDate;
      if (effectiveCatDate && effectiveCatDate > expiry) {
        signalReasons.push({
          level: 'AMBER',
          code: 'OPTION_EXPIRY_MISMATCH',
          detail: `Expected catalyst (${effectiveCatDate}) falls after option expiry (${expiry})`,
          source: catalystDate ? 'Journal Plan' : intel?.source || 'Catalyst Radar',
          timestamp: catalystDate ? undefined : intel?.analyzedAt,
        });
      }
    }

    // GREY triggers (data stale or missing)
    if (currentPrice <= 0 || priceSource === 'Missing') {
      signalReasons.push({
        level: 'GREY',
        code: 'PRICE_MISSING',
        detail: 'Current market price is missing — refresh quotes or enter manual override',
        source: 'Market Feed',
      });
    } else if (priceIsStale) {
      signalReasons.push({
        level: 'GREY',
        code: 'DATA_STALE',
        detail: `Using static ${priceSource} price — refresh live feed or override`,
        source: priceSource,
        timestamp: priceTimestamp,
      });
    }
    if (secStatus === 'ERROR') {
      signalReasons.push({
        level: 'GREY',
        code: 'SEC_ERROR',
        detail: secInfo?.error || 'SEC EDGAR feed unavailable',
        source: 'SEC EDGAR',
        timestamp: secFetchedAt,
      });
    }
  } else {
    // Closed trade signal reflects outcome cleanly
    if (override.exitReason === 'gap' || currentR < -1.0001 || override.thesisBroken) {
      signalReasons.push({
        level: 'RED',
        code: 'CLOSED_SLIPPAGE',
        detail: `Closed at ${currentR.toFixed(2)}R${override.exitReason ? ` (${override.exitReason})` : ''}`,
        source: 'IBKR Ledger',
        timestamp: exitDate,
      });
    } else if (!override.exitReason || !override.lesson?.trim()) {
      signalReasons.push({
        level: 'AMBER',
        code: 'LOG_INCOMPLETE',
        detail: 'Closed trade missing required exit reason or one-line lesson',
        source: 'Journal Audit',
      });
    } else {
      signalReasons.push({
        level: 'GREEN',
        code: 'LOGGED_CLEAN',
        detail: `Logged with exit reason (${override.exitReason}) and lesson`,
        source: 'Journal Audit',
        timestamp: exitDate,
      });
    }
  }

  let signalColor: JournalSignalColor = 'GREEN';
  if (signalReasons.some((r) => r.level === 'RED')) {
    signalColor = 'RED';
  } else if (signalReasons.some((r) => r.level === 'AMBER')) {
    signalColor = 'AMBER';
  } else if (signalReasons.some((r) => r.level === 'GREY')) {
    signalColor = 'GREY';
  } else {
    signalColor = 'GREEN';
    if (signalReasons.length === 0) {
      signalReasons.push({
        level: 'GREEN',
        code: 'INTACT',
        detail: 'Thesis intact — no stop breach, upcoming 14d event, or unread SEC trigger filing',
        source: priceSource,
        timestamp: priceTimestamp || secFetchedAt,
      });
    }
  }

  return {
    id: camp.id,
    ticker: ut.ticker,
    companyName: ut.companyName,
    contractSymbol: camp.contractSymbol,
    instrument,
    displayType,
    optionType: camp.optionType,
    isShortOption,
    status: camp.status,
    currency,
    fxToBase,
    entryDate,
    exitDate,
    holdingDays,
    dte,
    expiry,
    catalystType,
    catalystDate,
    nextEventDate,
    daysToNextEvent,
    quantity,
    multiplier,
    entryPrice,
    realEntryPrice: isStock ? ut.realEntryPrice : undefined,
    currentPrice,
    priceSource,
    priceTimestamp,
    priceIsStale,
    risk1RNative,
    risk1RBase,
    plannedSizeUnits,
    openRiskNative,
    openRiskBase,
    stopPrice,
    target1,
    target2,
    target3,
    stopDistancePct,
    strike: camp.strike,
    premiumPaidNative,
    currentOptionValueNative,
    premiumChangePct: premiumChangePct !== undefined ? Number(premiumChangePct.toFixed(1)) : undefined,
    breakevenPrice,
    spotPrice,
    breakevenDiffPct: breakevenDiffPct !== undefined ? Number(breakevenDiffPct.toFixed(1)) : undefined,
    pnlNative,
    pnlBase,
    currentR: Number(currentR.toFixed(2)),
    plannedLossR: -1.0,
    actualLossR: camp.status === 'CLOSED' && currentR < 0 ? Number(currentR.toFixed(2)) : undefined,
    thesis: override.thesis || '',
    thesisBroken: Boolean(override.thesisBroken),
    exitReason: override.exitReason,
    lesson: override.lesson || '',
    loggedFields,
    hasInsiderCluster,
    secFilings,
    newTriggerFilings,
    secStatus,
    secFetchedAt,
    lastViewedAt: override.lastViewedAt,
    manualFilingNote: override.manualFilingNote,
    signalColor,
    signalPriority: SIGNAL_PRIORITY[signalColor],
    signalReasons,
  };
}

/**
 * Derive all open + closed journal trades sorted by default attention priority (Red, Amber, Green, Grey)
 * and then nearest catalyst/expiry date (never by entry date).
 */
export function buildJournalTrades(
  unifiedTickers: UnifiedTickerSummary[],
  quotes: Record<string, StockQuote>,
  quotesFetchedAt: string | undefined,
  positionMarks: Record<string, PositionMark>,
  fxRates: Record<string, number>,
  baseCurrency: 'EUR' | 'USD',
  overrides: Record<string, JournalTradeOverride>,
  settings: JournalSettings,
  secFilingsByTicker: Record<string, SecTickerFilings>,
  now: Date = new Date(),
  intelByTradeId: Record<string, JournalTradeIntel> = {}
): JournalDerivedTrade[] {
  const nowMs = now.getTime();
  const rows: JournalDerivedTrade[] = [];

  for (const ut of unifiedTickers) {
    const secInfo = secFilingsByTicker[ut.ticker];
    for (const camp of ut.campaigns) {
      if (camp.kind === 'DIVIDENDS') continue;
      let override: JournalTradeOverride = overrides[camp.id] || {};
      if (!overrides[camp.id] && camp.legacyIds && camp.legacyIds.length > 0) {
        for (const legacyId of camp.legacyIds) {
          if (overrides[legacyId]) {
            override = overrides[legacyId];
            break;
          }
        }
      }
      const intel = intelByTradeId[camp.id];
      rows.push(
        buildJournalTradeFromCampaign(
          ut,
          camp,
          quotes,
          quotesFetchedAt,
          positionMarks,
          fxRates,
          baseCurrency,
          override,
          settings,
          secInfo,
          nowMs,
          intel
        )
      );
    }
  }

  // Default sort: by attention (Red, Amber, Green, Grey), then nearest catalyst/expiry date
  rows.sort((a, b) => {
    if (a.signalPriority !== b.signalPriority) {
      return a.signalPriority - b.signalPriority;
    }
    const aDays = a.daysToNextEvent !== undefined ? a.daysToNextEvent : Number.POSITIVE_INFINITY;
    const bDays = b.daysToNextEvent !== undefined ? b.daysToNextEvent : Number.POSITIVE_INFINITY;
    if (aDays !== bDays) {
      return aDays - bDays;
    }
    return a.ticker.localeCompare(b.ticker);
  });

  return rows;
}

export interface JournalTopStripStats {
  totalOpenRiskBase: number;
  openRiskPctOfPortfolio: number;
  sleeveCapPct: number;
  exceedsSleeveCap: boolean;
  openRSum: number;
  attentionCount: number;
  redCount: number;
  amberCount: number;
  closedTradesLogged: number;
  statisticallyMeaningful: boolean;
}

export function computeJournalTopStrip(
  allTrades: JournalDerivedTrade[],
  netLiqValueBase: number,
  sleeveCapPct: number
): JournalTopStripStats {
  const open = allTrades.filter((t) => t.status === 'OPEN');
  const closed = allTrades.filter((t) => t.status === 'CLOSED');

  const totalOpenRiskBase = open.reduce((sum, t) => sum + t.openRiskBase, 0);
  const openRiskPctOfPortfolio = netLiqValueBase > 0 ? (totalOpenRiskBase / netLiqValueBase) * 100 : 0;
  const openRSum = open.reduce((sum, t) => sum + t.currentR, 0);
  const redCount = open.filter((t) => t.signalColor === 'RED').length;
  const amberCount = open.filter((t) => t.signalColor === 'AMBER').length;

  return {
    totalOpenRiskBase,
    openRiskPctOfPortfolio: Number(openRiskPctOfPortfolio.toFixed(1)),
    sleeveCapPct,
    exceedsSleeveCap: openRiskPctOfPortfolio > sleeveCapPct,
    openRSum: Number(openRSum.toFixed(2)),
    attentionCount: redCount + amberCount,
    redCount,
    amberCount,
    closedTradesLogged: closed.length,
    statisticallyMeaningful: closed.length >= 30,
  };
}

export function applyJournalFilters(
  allTrades: JournalDerivedTrade[],
  opts: {
    instrument: 'ALL' | 'STOCK' | 'OPTION';
    statusChip: 'OPEN' | 'ATTENTION' | 'CLOSED';
    catalystFilter: string;
    ageFilter: 'ALL' | 'LT14' | 'D14_60' | 'GT60';
    activeSavedView?: JournalSavedView | null;
    now?: Date;
  }
): JournalDerivedTrade[] {
  const now = opts.now || new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth();

  return allTrades.filter((t) => {
    // Status chip
    if (opts.statusChip === 'OPEN' && t.status !== 'OPEN') return false;
    if (opts.statusChip === 'CLOSED' && t.status !== 'CLOSED') return false;
    if (opts.statusChip === 'ATTENTION') {
      if (t.status !== 'OPEN' || (t.signalColor !== 'RED' && t.signalColor !== 'AMBER')) return false;
    }

    // Instrument
    if (opts.instrument !== 'ALL' && t.instrument !== opts.instrument) return false;

    // Catalyst
    if (opts.catalystFilter && opts.catalystFilter !== 'ALL' && t.catalystType !== opts.catalystFilter) return false;

    // Age
    if (opts.ageFilter === 'LT14' && t.holdingDays >= 14) return false;
    if (opts.ageFilter === 'D14_60' && (t.holdingDays < 14 || t.holdingDays > 60)) return false;
    if (opts.ageFilter === 'GT60' && t.holdingDays <= 60) return false;

    // Saved view special predicates
    if (opts.activeSavedView?.expiringThisMonth) {
      if (t.instrument !== 'OPTION' || !t.expiry) return false;
      const exp = new Date(t.expiry + 'T00:00:00Z');
      if (isNaN(exp.getTime())) return false;
      const within31Days = t.dte !== undefined && t.dte <= 31;
      const sameMonth = exp.getUTCFullYear() === currentYear && exp.getUTCMonth() === currentMonth;
      if (!sameMonth && !within31Days) return false;
    }

    if (opts.activeSavedView?.insiderClusterOnly) {
      if (!t.hasInsiderCluster) return false;
    }

    return true;
  });
}

// ------------------------------------------------------------
// TIMELINE CALENDAR BUCKETS (HORIZONTAL BY WEEK)
// ------------------------------------------------------------
export interface JournalTimelineEvent {
  id: string;
  tradeId: string;
  ticker: string;
  instrument: 'STOCK' | 'OPTION';
  eventType: 'CATALYST' | 'EXPIRY';
  eventLabel: string;
  date: string;
  daysUntil: number;
  signalColor: JournalSignalColor;
  currentR: number;
}

export interface JournalTimelineWeek {
  weekKey: string; // YYYY-MM-DD (Monday)
  weekLabel: string;
  events: JournalTimelineEvent[];
}

export function buildJournalTimeline(
  openTrades: JournalDerivedTrade[],
  now: Date = new Date()
): { weeks: JournalTimelineWeek[]; undatedCount: number } {
  const nowMs = now.getTime();
  const events: JournalTimelineEvent[] = [];
  let undatedCount = 0;

  for (const t of openTrades) {
    let added = false;
    if (t.catalystDate) {
      const d = daysBetween(t.catalystDate, nowMs);
      if (d !== undefined) {
        events.push({
          id: `${t.id}-cat`,
          tradeId: t.id,
          ticker: t.ticker,
          instrument: t.instrument,
          eventType: 'CATALYST',
          eventLabel: t.catalystType,
          date: t.catalystDate,
          daysUntil: d,
          signalColor: t.signalColor,
          currentR: t.currentR,
        });
        added = true;
      }
    }
    if (t.instrument === 'OPTION' && t.expiry) {
      const d = daysBetween(t.expiry, nowMs);
      if (d !== undefined) {
        const cSym = t.currency === 'EUR' ? '€' : '$';
        events.push({
          id: `${t.id}-exp`,
          tradeId: t.id,
          ticker: t.ticker,
          instrument: 'OPTION',
          eventType: 'EXPIRY',
          eventLabel: `${t.displayType} ${cSym}${t.strike ?? ''}`,
          date: t.expiry,
          daysUntil: d,
          signalColor: t.signalColor,
          currentR: t.currentR,
        });
        added = true;
      }
    }
    if (!added) undatedCount++;
  }

  events.sort((a, b) => a.date.localeCompare(b.date));

  const weekMap = new Map<string, JournalTimelineWeek>();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  for (const ev of events) {
    const dt = new Date(ev.date + 'T00:00:00Z');
    if (isNaN(dt.getTime())) continue;
    // Monday start of ISO week
    const day = dt.getUTCDay();
    const diffToMon = (day + 6) % 7;
    const monday = new Date(dt.getTime() - diffToMon * 86400000);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    const weekKey = monday.toISOString().slice(0, 10);

    if (!weekMap.has(weekKey)) {
      const label = `${months[monday.getUTCMonth()]} ${monday.getUTCDate()} – ${months[sunday.getUTCMonth()]} ${sunday.getUTCDate()}`;
      weekMap.set(weekKey, { weekKey, weekLabel: label, events: [] });
    }
    weekMap.get(weekKey)!.events.push(ev);
  }

  const weeks = Array.from(weekMap.values()).sort((a, b) => a.weekKey.localeCompare(b.weekKey));
  return { weeks, undatedCount };
}

// ------------------------------------------------------------
// TAB 2: CLOSED TRADE ANALYSIS ENGINE
// ------------------------------------------------------------
export interface JournalAnalysisResult {
  closedCount: number;
  statisticallyMeaningful: boolean;
  missingLogCount: number;
  expectancyR: number;
  winRatePct: number;
  avgWinR: number;
  avgLossR: number;
  payoffRatio: number;
  totalR: number;
  totalPnlBase: number;
  rDotStrip: Array<{
    id: string;
    ticker: string;
    contractSymbol: string;
    instrument: 'STOCK' | 'OPTION';
    r: number;
    clampedR: number; // plotted on [-1, 10]
    overflowLeft: boolean;
    overflowRight: boolean;
    lane: number; // vertical lane to prevent dot overlap
    pnlBase: number;
    exitReason?: string;
    lesson?: string;
  }>;
  equityCurve: Array<{
    index: number;
    date: string;
    ticker: string;
    tradeR: number;
    cumulativeR: number;
    pnlBase: number;
  }>;
  expectancyByCatalyst: Array<{
    catalyst: string;
    count: number;
    expectancyR: number;
    winRatePct: number;
  }>;
  expectancyByInstrument: Array<{
    instrument: 'Stock' | 'Option';
    count: number;
    expectancyR: number;
    winRatePct: number;
    totalR: number;
  }>;
  plannedVsActualLoss: Array<{
    id: string;
    label: string;
    ticker: string;
    plannedLossR: number; // -1.0
    actualLossR: number; // e.g., -1.45
    slippageR: number; // negative when exceeded -1R
    exitReason: string;
  }>;
  holdingDaysVsResult: Array<{
    id: string;
    ticker: string;
    instrument: 'STOCK' | 'OPTION';
    holdingDays: number;
    resultR: number;
    pnlBase: number;
    exitReason: string;
  }>;
  fieldCorrelations: Array<{
    field: string;
    withCount: number;
    withWinRatePct: number;
    withExpectancyR: number;
    withoutExpectancyR: number;
    liftR: number;
  }>;
}

export function computeJournalAnalysis(closedTrades: JournalDerivedTrade[]): JournalAnalysisResult {
  const closedCount = closedTrades.length;
  const statisticallyMeaningful = closedCount >= 30;
  const missingLogCount = closedTrades.filter((t) => !t.exitReason || !t.lesson?.trim()).length;

  const wins = closedTrades.filter((t) => t.currentR > 0);
  const losses = closedTrades.filter((t) => t.currentR < 0);

  const totalR = closedTrades.reduce((s, t) => s + t.currentR, 0);
  const totalPnlBase = closedTrades.reduce((s, t) => s + t.pnlBase, 0);
  const expectancyR = closedCount > 0 ? totalR / closedCount : 0;
  const winRatePct = closedCount > 0 ? (wins.length / closedCount) * 100 : 0;
  const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + t.currentR, 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? losses.reduce((s, t) => s + t.currentR, 0) / losses.length : 0;
  const payoffRatio = avgLossR < 0 ? Math.abs(avgWinR / avgLossR) : avgWinR > 0 ? 9.99 : 0;

  // 1. R-Dot Strip (-1R to +10R) with collision-free lanes
  const sortedByR = [...closedTrades].sort((a, b) => a.currentR - b.currentR);
  const laneLastX: number[] = [];
  const rDotStrip = sortedByR.map((t) => {
    const clampedR = Math.max(-1, Math.min(10, t.currentR));
    let lane = 0;
    while (lane < laneLastX.length && Math.abs(clampedR - laneLastX[lane]) < 0.28) {
      lane++;
    }
    laneLastX[lane] = clampedR;
    return {
      id: t.id,
      ticker: t.ticker,
      contractSymbol: t.contractSymbol,
      instrument: t.instrument,
      r: t.currentR,
      clampedR,
      overflowLeft: t.currentR < -1,
      overflowRight: t.currentR > 10,
      lane: lane % 5,
      pnlBase: t.pnlBase,
      exitReason: t.exitReason,
      lesson: t.lesson,
    };
  });

  // 2. Equity Curve in R (chronological by exit date)
  const chronoClosed = [...closedTrades].sort((a, b) =>
    (a.exitDate || a.entryDate).localeCompare(b.exitDate || b.entryDate)
  );
  let cumR = 0;
  const equityCurve = chronoClosed.map((t, idx) => {
    cumR += t.currentR;
    return {
      index: idx + 1,
      date: t.exitDate || t.entryDate || `#${idx + 1}`,
      ticker: t.ticker,
      tradeR: t.currentR,
      cumulativeR: Number(cumR.toFixed(2)),
      pnlBase: Number(t.pnlBase.toFixed(2)),
    };
  });

  // 3. Expectancy by Catalyst Type
  const catMap = new Map<string, JournalDerivedTrade[]>();
  for (const t of closedTrades) {
    const k = t.catalystType || 'Other';
    if (!catMap.has(k)) catMap.set(k, []);
    catMap.get(k)!.push(t);
  }
  const expectancyByCatalyst = Array.from(catMap.entries())
    .map(([catalyst, list]) => {
      const exp = list.reduce((s, x) => s + x.currentR, 0) / list.length;
      const wr = (list.filter((x) => x.currentR > 0).length / list.length) * 100;
      return {
        catalyst,
        count: list.length,
        expectancyR: Number(exp.toFixed(2)),
        winRatePct: Number(wr.toFixed(1)),
      };
    })
    .sort((a, b) => b.expectancyR - a.expectancyR);

  // 4. Expectancy by Instrument (Stock vs Option)
  const stockClosed = closedTrades.filter((t) => t.instrument === 'STOCK');
  const optClosed = closedTrades.filter((t) => t.instrument === 'OPTION');
  const expectancyByInstrument: JournalAnalysisResult['expectancyByInstrument'] = [
    {
      instrument: 'Stock',
      count: stockClosed.length,
      expectancyR: stockClosed.length > 0 ? Number((stockClosed.reduce((s, x) => s + x.currentR, 0) / stockClosed.length).toFixed(2)) : 0,
      winRatePct: stockClosed.length > 0 ? Number(((stockClosed.filter((x) => x.currentR > 0).length / stockClosed.length) * 100).toFixed(1)) : 0,
      totalR: Number(stockClosed.reduce((s, x) => s + x.currentR, 0).toFixed(2)),
    },
    {
      instrument: 'Option',
      count: optClosed.length,
      expectancyR: optClosed.length > 0 ? Number((optClosed.reduce((s, x) => s + x.currentR, 0) / optClosed.length).toFixed(2)) : 0,
      winRatePct: optClosed.length > 0 ? Number(((optClosed.filter((x) => x.currentR > 0).length / optClosed.length) * 100).toFixed(1)) : 0,
      totalR: Number(optClosed.reduce((s, x) => s + x.currentR, 0).toFixed(2)),
    },
  ];

  // 5. Planned vs Actual Loss (exposes gap slippage on losing trades)
  const plannedVsActualLoss = losses
    .sort((a, b) => a.currentR - b.currentR)
    .slice(0, 12)
    .map((t, i) => ({
      id: t.id,
      label: `${t.ticker} #${i + 1}`,
      ticker: t.ticker,
      plannedLossR: -1.0,
      actualLossR: t.currentR,
      slippageR: Number(Math.min(0, t.currentR + 1.0).toFixed(2)),
      exitReason: t.exitReason || 'unlogged',
    }));

  // 6. Holding Days vs Result (R)
  const holdingDaysVsResult = closedTrades.map((t) => ({
    id: t.id,
    ticker: t.ticker,
    instrument: t.instrument,
    holdingDays: t.holdingDays,
    resultR: t.currentR,
    pnlBase: Number(t.pnlBase.toFixed(2)),
    exitReason: t.exitReason || 'unlogged',
  }));

  // 7. Field-Correlation View (STRICTLY computed & surfaced only after 30+ closed trades)
  const fieldCorrelations: JournalAnalysisResult['fieldCorrelations'] = [];
  if (statisticallyMeaningful) {
    const predicates: Array<{ label: string; fn: (t: JournalDerivedTrade) => boolean }> = [
      { label: 'Insider Cluster', fn: (t) => Boolean(t.hasInsiderCluster) },
      { label: 'Pre-Catalyst Entry', fn: (t) => Boolean(t.loggedFields.preCatalystEntry) },
      { label: 'Asymmetric >3R Setup', fn: (t) => Boolean(t.loggedFields.asymmetricRR) },
      { label: 'Volume Confirmed', fn: (t) => Boolean(t.loggedFields.volumeConfirmed) },
      { label: 'Sector Tailwind', fn: (t) => Boolean(t.loggedFields.sectorTailwind) },
      { label: 'Instrument: Option', fn: (t) => t.instrument === 'OPTION' },
      { label: 'Instrument: Stock', fn: (t) => t.instrument === 'STOCK' },
      ...CATALYST_TYPES.map((ct) => ({
        label: `Catalyst: ${ct}`,
        fn: (t: JournalDerivedTrade) => t.catalystType === ct,
      })),
    ];

    for (const p of predicates) {
      const withSet = closedTrades.filter(p.fn);
      const withoutSet = closedTrades.filter((t) => !p.fn(t));
      if (withSet.length < 3 || withoutSet.length < 3) continue;
      const withExp = withSet.reduce((s, x) => s + x.currentR, 0) / withSet.length;
      const withoutExp = withoutSet.reduce((s, x) => s + x.currentR, 0) / withoutSet.length;
      const withWr = (withSet.filter((x) => x.currentR > 0).length / withSet.length) * 100;
      fieldCorrelations.push({
        field: p.label,
        withCount: withSet.length,
        withWinRatePct: Number(withWr.toFixed(1)),
        withExpectancyR: Number(withExp.toFixed(2)),
        withoutExpectancyR: Number(withoutExp.toFixed(2)),
        liftR: Number((withExp - withoutExp).toFixed(2)),
      });
    }
    fieldCorrelations.sort((a, b) => b.liftR - a.liftR);
  }

  return {
    closedCount,
    statisticallyMeaningful,
    missingLogCount,
    expectancyR: Number(expectancyR.toFixed(2)),
    winRatePct: Number(winRatePct.toFixed(1)),
    avgWinR: Number(avgWinR.toFixed(2)),
    avgLossR: Number(avgLossR.toFixed(2)),
    payoffRatio: Number(payoffRatio.toFixed(2)),
    totalR: Number(totalR.toFixed(2)),
    totalPnlBase: Number(totalPnlBase.toFixed(2)),
    rDotStrip,
    equityCurve,
    expectancyByCatalyst,
    expectancyByInstrument,
    plannedVsActualLoss,
    holdingDaysVsResult,
    fieldCorrelations,
  };
}
