import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  UnifiedTickerSummary,
  StockQuote,
  PositionMark,
  JournalTradeOverride,
  JournalSettings,
  JournalSavedView,
  JournalDerivedTrade,
  JournalSignalColor,
  JournalCatalystType,
  JournalExitReason,
  SecTickerFilings,
  JournalTradeIntel,
} from '../types';
import {
  CATALYST_TYPES,
  EXIT_REASONS,
  buildJournalTrades,
  computeJournalTopStrip,
  applyJournalFilters,
  buildJournalTimeline,
  computeJournalAnalysis,
} from '../utils/journalEngine';
import { fetchSecFilings, analyzeJournalTrade } from '../services/optionsService';
import { sanitizeExternalUrl } from '../utils/secForm4Parser';
import { JournalAnalysisTab } from './JournalAnalysisTab';
import {
  RefreshCw,
  Calendar,
  Table2,
  Bookmark,
  Plus,
  X,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Check,
  SlidersHorizontal,
  Sparkles,
  ArrowDownToLine,
} from 'lucide-react';

interface FilteredJournalPanelProps {
  unifiedTickers: UnifiedTickerSummary[];
  quotes: Record<string, StockQuote>;
  quotesFetchedAt?: string;
  positionMarks: Record<string, PositionMark>;
  fxRates: Record<string, number>;
  baseCurrency: 'EUR' | 'USD';
  netLiqValueBase: number;
  onRefreshQuotes: () => Promise<void> | void;
  overrides: Record<string, JournalTradeOverride>;
  onChangeOverrides: React.Dispatch<React.SetStateAction<Record<string, JournalTradeOverride>>>;
  settings: JournalSettings;
  onChangeSettings: React.Dispatch<React.SetStateAction<JournalSettings>>;
  focusClosedTradeId?: string | null;
  onClearFocusTrade?: () => void;
}

const OUTLINE_BORDER: Record<JournalSignalColor, string> = {
  RED: 'border-l-4 border-l-rose-500',
  AMBER: 'border-l-4 border-l-amber-400',
  GREEN: 'border-l-4 border-l-emerald-500',
  GREY: 'border-l-4 border-l-slate-500',
};

const OUTLINE_TEXT: Record<JournalSignalColor, string> = {
  RED: 'text-rose-400',
  AMBER: 'text-amber-300',
  GREEN: 'text-emerald-400',
  GREY: 'text-slate-400',
};

const OUTLINE_LABEL: Record<JournalSignalColor, string> = {
  RED: 'Red',
  AMBER: 'Amber',
  GREEN: 'Green',
  GREY: 'Grey',
};

function formatShortTimestamp(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function isSafeSecUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith('https://www.sec.gov/');
}

/**
 * Pure visual Stock Range Bar: Stop on left, profit targets T1/T2/T3 on right, bright dot for current price.
 * Readable at a glance without reading any numbers.
 */
const StockRangeBar: React.FC<{ trade: JournalDerivedTrade }> = ({ trade }) => {
  const entry = trade.entryPrice;
  const current = trade.currentPrice;
  const stop = trade.stopPrice;

  if (entry <= 0 || current <= 0) {
    return <span className="text-xs font-mono text-slate-500">No price</span>;
  }

  // If stop or targets aren't configured yet, project clean visual defaults from 1R/2R/3R geometry so bar still works
  const effectiveStop = stop !== undefined && stop > 0 ? stop : entry * 0.85;
  const riskUnit = Math.max(0.01, Math.abs(entry - effectiveStop));
  const t1 = trade.target1 ?? entry + riskUnit * 1.5;
  const t2 = trade.target2 ?? entry + riskUnit * 3;
  const t3 = trade.target3 ?? entry + riskUnit * 5;

  const minVal = Math.min(effectiveStop, current, entry) * 0.96;
  const maxVal = Math.max(t3, t2, t1, current, entry) * 1.04;
  const span = Math.max(0.0001, maxVal - minVal);
  const toPct = (v: number) => Math.max(2, Math.min(98, ((v - minVal) / span) * 100));

  const stopPct = toPct(effectiveStop);
  const entryPct = toPct(entry);
  const currPct = toPct(current);
  const t1Pct = toPct(t1);
  const t2Pct = toPct(t2);
  const t3Pct = toPct(t3);

  const dotColor =
    stop !== undefined && current <= stop
      ? 'bg-rose-400 ring-2 ring-rose-500/40'
      : current >= t1 && trade.target1 !== undefined
      ? 'bg-emerald-300 ring-2 ring-emerald-400/40'
      : current >= entry
      ? 'bg-cyan-300'
      : 'bg-amber-300';

  const hasCustomLevels = stop !== undefined || trade.target1 !== undefined;

  return (
    <div
      className="w-full min-w-[140px] py-1"
      title={`Stop: ${stop ? stop.toFixed(2) : 'unset (default -15%)'} · Entry: ${entry.toFixed(2)} · Spot: ${current.toFixed(2)} · T1/T2/T3: ${t1.toFixed(2)}/${t2.toFixed(2)}/${t3.toFixed(2)}`}
    >
      <div className="relative h-4 flex items-center">
        {/* Track */}
        <div className="w-full h-1.5 rounded-full bg-[#09101a] border border-[#1a293c] relative overflow-hidden">
          {/* Risk zone (Stop to Entry) */}
          <div
            style={{ left: `${Math.min(stopPct, entryPct)}%`, width: `${Math.abs(entryPct - stopPct)}%` }}
            className="absolute top-0 bottom-0 bg-rose-500/20"
          />
          {/* Target zone (Entry to T3) */}
          <div
            style={{ left: `${Math.min(entryPct, t3Pct)}%`, width: `${Math.abs(t3Pct - entryPct)}%` }}
            className="absolute top-0 bottom-0 bg-emerald-500/15"
          />
        </div>

        {/* Stop marker (left) */}
        <div
          style={{ left: `${stopPct}%` }}
          className={`absolute top-0.5 bottom-0.5 w-0.5 -translate-x-1/2 ${
            stop !== undefined ? 'bg-rose-500' : 'bg-rose-500/40'
          }`}
        />

        {/* Entry tick */}
        <div
          style={{ left: `${entryPct}%` }}
          className="absolute top-1 bottom-1 w-px bg-slate-400/70 -translate-x-1/2"
        />

        {/* T1 / T2 / T3 target ticks (right) */}
        <div
          style={{ left: `${t1Pct}%` }}
          className={`absolute top-0.5 bottom-0.5 w-0.5 -translate-x-1/2 ${
            trade.target1 !== undefined ? 'bg-emerald-400/80' : 'bg-emerald-500/25'
          }`}
        />
        <div
          style={{ left: `${t2Pct}%` }}
          className={`absolute top-0.5 bottom-0.5 w-0.5 -translate-x-1/2 ${
            trade.target2 !== undefined ? 'bg-emerald-400' : 'bg-emerald-500/25'
          }`}
        />
        <div
          style={{ left: `${t3Pct}%` }}
          className={`absolute top-0.5 bottom-0.5 w-0.5 -translate-x-1/2 ${
            trade.target3 !== undefined ? 'bg-emerald-300' : 'bg-emerald-500/25'
          }`}
        />

        {/* Current price dot */}
        <div
          style={{ left: `${currPct}%` }}
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full ${dotColor}`}
        />
      </div>
      <div className="flex items-center justify-between text-[9px] font-mono text-slate-500 leading-none mt-0.5">
        <span>{stop !== undefined ? 'STOP' : 'stop?'}</span>
        <span>{hasCustomLevels ? 'T1 · T2 · T3' : 'set stop/targets'}</span>
      </div>
    </div>
  );
};

export const FilteredJournalPanel: React.FC<FilteredJournalPanelProps> = ({
  unifiedTickers,
  quotes,
  quotesFetchedAt,
  positionMarks,
  fxRates,
  baseCurrency,
  netLiqValueBase,
  onRefreshQuotes,
  overrides,
  onChangeOverrides,
  settings,
  onChangeSettings,
  focusClosedTradeId,
  onClearFocusTrade,
}) => {
  // Strictly separate tabs: Positions (monitoring) vs Analysis (closed-trade learning)
  const [activeTab, setActiveTab] = useState<'POSITIONS' | 'ANALYSIS'>('POSITIONS');

  // Positions tab controls
  const [instrumentFilter, setInstrumentFilter] = useState<'ALL' | 'STOCK' | 'OPTION'>('ALL');
  const [layoutMode, setLayoutMode] = useState<'TABLE' | 'TIMELINE'>('TABLE');
  const [statusChip, setStatusChip] = useState<'OPEN' | 'ATTENTION' | 'CLOSED'>('OPEN');
  const [catalystFilter, setCatalystFilter] = useState<string>('ALL');
  const [ageFilter, setAgeFilter] = useState<'ALL' | 'LT14' | 'D14_60' | 'GT60'>('ALL');
  const [activeSavedViewId, setActiveSavedViewId] = useState<string | null>(null);
  const [showSaveViewInput, setShowSaveViewInput] = useState(false);
  const [newViewName, setNewViewName] = useState('');

  // Inline expansion states (NO modals/popups)
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [openSignalReasonId, setOpenSignalReasonId] = useState<string | null>(null);
  const [showRiskConfig, setShowRiskConfig] = useState(false);

  // Jump straight to a newly closed trade from the Import Diff banner
  useEffect(() => {
    if (!focusClosedTradeId) return;
    setActiveTab('POSITIONS');
    setLayoutMode('TABLE');
    setStatusChip('CLOSED');
    setInstrumentFilter('ALL');
    setCatalystFilter('ALL');
    setAgeFilter('ALL');
    setActiveSavedViewId(null);
    setExpandedRowId(focusClosedTradeId);
    onClearFocusTrade?.();
  }, [focusClosedTradeId, onClearFocusTrade]);

  // SEC EDGAR automation state
  const [secFilingsByTicker, setSecFilingsByTicker] = useState<Record<string, SecTickerFilings>>({});
  const [secLastFetchedAt, setSecLastFetchedAt] = useState<string | undefined>(undefined);
  const [isRefreshingSec, setIsRefreshingSec] = useState(false);

  // AI Filing & News Intelligence state (persisted per stable trade ID)
  const [intelByTradeId, setIntelByTradeId] = useState<Record<string, JournalTradeIntel>>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_journal_intel_v1');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore storage errors
    }
    return {};
  });
  const [analyzingTradeId, setAnalyzingTradeId] = useState<string | null>(null);
  const [intelErrorByTradeId, setIntelErrorByTradeId] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_journal_intel_v1', JSON.stringify(intelByTradeId));
    } catch {
      // ignore quota errors
    }
  }, [intelByTradeId]);

  const handleAnalyzeTrade = useCallback(
    async (trade: JournalDerivedTrade, forceRefresh = false) => {
      setAnalyzingTradeId(trade.id);
      setIntelErrorByTradeId((prev) => {
        const next = { ...prev };
        delete next[trade.id];
        return next;
      });
      try {
        const intel = await analyzeJournalTrade({
          ticker: trade.ticker,
          companyName: trade.companyName,
          instrument: trade.instrument,
          status: trade.status,
          entryDate: trade.entryDate,
          exitDate: trade.exitDate,
          expiry: trade.expiry,
          thesis: trade.thesis,
          catalystType: trade.catalystType,
          catalystDate: trade.catalystDate,
          manualFilingNote: trade.manualFilingNote,
          forceRefresh,
        });
        setIntelByTradeId((prev) => ({ ...prev, [trade.id]: intel }));
      } catch (err: any) {
        setIntelErrorByTradeId((prev) => ({
          ...prev,
          [trade.id]: err?.message || 'Failed to analyze filings and news.',
        }));
      } finally {
        setAnalyzingTradeId((curr) => (curr === trade.id ? null : curr));
      }
    },
    []
  );

  const uniqueTickers = useMemo(
    () => Array.from(new Set(unifiedTickers.map((t) => t.ticker))).sort(),
    [unifiedTickers]
  );

  const refreshSecAndMarket = useCallback(
    async (forceRefresh = false) => {
      if (uniqueTickers.length === 0) return;
      setIsRefreshingSec(true);
      try {
        const [secRes] = await Promise.all([
          fetchSecFilings(uniqueTickers, forceRefresh),
          forceRefresh ? Promise.resolve(onRefreshQuotes()) : Promise.resolve(),
        ]);
        if (secRes.filingsByTicker && Object.keys(secRes.filingsByTicker).length > 0) {
          setSecFilingsByTicker((prev) => ({ ...prev, ...secRes.filingsByTicker }));
          setSecLastFetchedAt(secRes.fetchedAt);
        }
      } finally {
        setIsRefreshingSec(false);
      }
    },
    [uniqueTickers, onRefreshQuotes]
  );

  // Initial SEC EDGAR load + auto-refresh timer
  useEffect(() => {
    refreshSecAndMarket(false);
  }, [refreshSecAndMarket]);

  useEffect(() => {
    const mins = Math.max(5, settings.autoRefreshMinutes || 15);
    const id = setInterval(() => {
      refreshSecAndMarket(false);
    }, mins * 60 * 1000);
    return () => clearInterval(id);
  }, [settings.autoRefreshMinutes, refreshSecAndMarket]);

  // Build derived journal rows
  const allTrades = useMemo(
    () =>
      buildJournalTrades(
        unifiedTickers,
        quotes,
        quotesFetchedAt,
        positionMarks,
        fxRates,
        baseCurrency,
        overrides,
        settings,
        secFilingsByTicker,
        undefined,
        intelByTradeId
      ),
    [
      unifiedTickers,
      quotes,
      quotesFetchedAt,
      positionMarks,
      fxRates,
      baseCurrency,
      overrides,
      settings,
      secFilingsByTicker,
      intelByTradeId,
    ]
  );

  const topStrip = useMemo(
    () => computeJournalTopStrip(allTrades, netLiqValueBase, settings.sleeveCapPct),
    [allTrades, netLiqValueBase, settings.sleeveCapPct]
  );

  const activeSavedView = useMemo(
    () => settings.savedViews.find((v) => v.id === activeSavedViewId) || null,
    [settings.savedViews, activeSavedViewId]
  );

  const filteredTrades = useMemo(
    () =>
      applyJournalFilters(allTrades, {
        instrument: instrumentFilter,
        statusChip,
        catalystFilter,
        ageFilter,
        activeSavedView,
      }),
    [allTrades, instrumentFilter, statusChip, catalystFilter, ageFilter, activeSavedView]
  );

  const closedTrades = useMemo(() => allTrades.filter((t) => t.status === 'CLOSED'), [allTrades]);
  const analysis = useMemo(() => computeJournalAnalysis(closedTrades), [closedTrades]);

  const timeline = useMemo(
    () => buildJournalTimeline(filteredTrades.filter((t) => t.status === 'OPEN')),
    [filteredTrades]
  );

  const stockRows = useMemo(() => filteredTrades.filter((t) => t.instrument === 'STOCK'), [filteredTrades]);
  const optionRows = useMemo(() => filteredTrades.filter((t) => t.instrument === 'OPTION'), [filteredTrades]);

  const updateOverride = (tradeId: string, patch: Partial<JournalTradeOverride>) => {
    onChangeOverrides((prev) => ({
      ...prev,
      [tradeId]: {
        ...(prev[tradeId] || {}),
        ...patch,
      },
    }));
  };

  const toggleLoggedField = (tradeId: string, field: keyof NonNullable<JournalTradeOverride['loggedFields']>, currentVal: boolean) => {
    onChangeOverrides((prev) => ({
      ...prev,
      [tradeId]: {
        ...(prev[tradeId] || {}),
        loggedFields: {
          ...(prev[tradeId]?.loggedFields || {}),
          [field]: !currentVal,
        },
      },
    }));
  };

  const markFilingsReviewed = (tradeId: string) => {
    updateOverride(tradeId, { lastViewedAt: new Date().toISOString() });
  };

  const applySavedView = (view: JournalSavedView) => {
    if (activeSavedViewId === view.id) {
      setActiveSavedViewId(null);
      setInstrumentFilter('ALL');
      setStatusChip('OPEN');
      setCatalystFilter('ALL');
      setAgeFilter('ALL');
      return;
    }
    setActiveSavedViewId(view.id);
    setInstrumentFilter(view.instrument);
    setStatusChip(view.statusChip);
    setCatalystFilter(view.catalystFilter);
    setAgeFilter(view.ageFilter);
  };

  const handleSaveCurrentView = () => {
    const trimmed = newViewName.trim();
    if (!trimmed) return;
    const nextView: JournalSavedView = {
      id: `view-custom-${Date.now()}`,
      name: trimmed,
      builtIn: false,
      instrument: instrumentFilter,
      statusChip,
      catalystFilter,
      ageFilter,
    };
    onChangeSettings((prev) => ({
      ...prev,
      savedViews: [...prev.savedViews, nextView],
    }));
    setActiveSavedViewId(nextView.id);
    setNewViewName('');
    setShowSaveViewInput(false);
  };

  const handleDeleteSavedView = (id: string) => {
    onChangeSettings((prev) => ({
      ...prev,
      savedViews: prev.savedViews.filter((v) => v.id !== id),
    }));
    if (activeSavedViewId === id) setActiveSavedViewId(null);
  };

  const baseSym = baseCurrency === 'EUR' ? '€' : '$';
  const fmtMoney = (val: number, curSym: string = baseSym, signed = false) => {
    const abs = Math.abs(val);
    const sign = signed ? (val > 0 ? '+' : val < 0 ? '-' : '') : val < 0 ? '-' : '';
    return `${sign}${curSym}${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };
  const fmtPrice = (val: number, cur: string) => {
    const s = cur === 'EUR' ? '€' : '$';
    const dec = val > 0 && val < 2 ? 3 : 2;
    return `${s}${val.toFixed(dec)}`;
  };
  const fmtR = (val: number) => `${val > 0 ? '+' : ''}${val.toFixed(2)}R`;

  // Render inline expanded detail panel for any trade row
  const renderExpandedDetail = (trade: JournalDerivedTrade) => {
    const curSym = trade.currency === 'EUR' ? '€' : '$';
    const ov = overrides[trade.id] || {};
    const isStock = trade.instrument === 'STOCK';

    return (
      <div className="bg-[#09101a] border-t border-[#182638] px-5 py-4 space-y-5">
        {/* Top Row: Automated IBKR / Market Data + 1R Sizing + Manual Price Override */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Column 1: Position & R-Sizing Mechanics */}
          <div className="space-y-2.5 text-xs font-mono">
            <div className="text-[11px] font-semibold text-slate-300 border-b border-[#182638] pb-1.5">
              1R Risk &amp; Sizing Mechanics
            </div>
            <div className="grid grid-cols-2 gap-y-1.5 gap-x-3 tabular-nums">
              <span className="text-slate-400">Entry Date</span>
              <span className="text-slate-200 text-right">{trade.entryDate || '—'} ({trade.holdingDays}d)</span>

              <span className="text-slate-400">Actual Size</span>
              <span className="text-slate-200 text-right">
                {trade.quantity.toLocaleString()} {isStock ? 'shs' : `ct (${trade.multiplier}x)`}
              </span>

              <span className="text-slate-400">Entry Price</span>
              <span className="text-slate-200 text-right">{fmtPrice(trade.entryPrice, trade.currency)}</span>

              {isStock && trade.realEntryPrice !== undefined && trade.realEntryPrice > 0 && (
                <>
                  <span className="text-slate-400">Real Entry (Basis)</span>
                  <span className="text-emerald-400 text-right">{fmtPrice(trade.realEntryPrice, trade.currency)}</span>
                </>
              )}

              <span className="text-slate-400">Result</span>
              <span className={`text-right font-bold ${trade.currentR >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmtR(trade.currentR)} ({fmtMoney(trade.pnlNative, curSym, true)})
              </span>

              <span className="text-slate-400">1R Sized Units</span>
              <span className="text-cyan-300 text-right">
                {trade.plannedSizeUnits !== undefined
                  ? `${trade.plannedSizeUnits} ${isStock ? 'shs (entry-stop)' : 'ct (prem=1R)'}`
                  : isStock
                  ? 'Set stop to compute'
                  : '—'}
              </span>
            </div>

            <div className="pt-2 border-t border-[#162334] grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] text-slate-400 block mb-1">Fixed 1R ({curSym})</span>
                <input
                  type="number"
                  min={1}
                  step="10"
                  placeholder={String(settings.defaultRisk1R)}
                  value={ov.riskPerTrade ?? ''}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    updateOverride(trade.id, { riskPerTrade: isNaN(v) || v <= 0 ? undefined : v });
                  }}
                  className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500 tabular-nums"
                />
              </label>

              <label className="block">
                <span className="text-[10px] text-slate-400 block mb-1">
                  Price Override ({curSym})
                </span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.01"
                    placeholder={trade.currentPrice > 0 ? trade.currentPrice.toFixed(2) : '0.00'}
                    value={ov.manualPriceOverride ?? ''}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      updateOverride(trade.id, {
                        manualPriceOverride: isNaN(v) || v <= 0 ? undefined : v,
                        manualPriceTimestamp: isNaN(v) || v <= 0 ? undefined : new Date().toISOString(),
                      });
                    }}
                    className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-cyan-500 tabular-nums"
                  />
                  {ov.manualPriceOverride !== undefined && (
                    <button
                      type="button"
                      onClick={() =>
                        updateOverride(trade.id, {
                          manualPriceOverride: undefined,
                          manualPriceTimestamp: undefined,
                        })
                      }
                      title="Clear manual price override"
                      className="p-1 text-slate-400 hover:text-rose-400"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </label>
            </div>
            <div className="text-[10px] text-slate-500">
              Price source: <span className="text-slate-300">{trade.priceSource}</span> · {formatShortTimestamp(trade.priceTimestamp)}
            </div>
          </div>

          {/* Column 2: Trade Plan, Levels & Journal Fields */}
          <div className="space-y-2.5 text-xs font-mono">
            <div className="text-[11px] font-semibold text-slate-300 border-b border-[#182638] pb-1.5">
              Trade Plan &amp; Journal Fields
            </div>

            <label className="block">
              <span className="text-[10px] text-slate-400 block mb-1">1. Why I Entered (One-Line Thesis)</span>
              <input
                type="text"
                placeholder="Why this trade has asymmetric edge..."
                value={ov.thesis ?? ''}
                onChange={(e) => updateOverride(trade.id, { thesis: e.target.value })}
                className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-emerald-500"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[10px] text-slate-400 block mb-1">2. Catalyst Waiting For</span>
                <select
                  value={ov.catalystType || 'Other'}
                  onChange={(e) => updateOverride(trade.id, { catalystType: e.target.value as JournalCatalystType })}
                  className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                >
                  {CATALYST_TYPES.map((ct) => (
                    <option key={ct} value={ct}>
                      {ct}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-[10px] text-slate-400 block mb-1">Catalyst Date</span>
                <input
                  type="date"
                  value={ov.catalystDate ?? ''}
                  onChange={(e) => updateOverride(trade.id, { catalystDate: e.target.value || undefined })}
                  className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </label>
            </div>

            {isStock ? (
              <div className="grid grid-cols-4 gap-2">
                <label className="block">
                  <span className="text-[10px] text-rose-400 block mb-1">Stop ({curSym})</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="—"
                    value={ov.stopPrice ?? ''}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      updateOverride(trade.id, { stopPrice: isNaN(v) || v <= 0 ? undefined : v });
                    }}
                    className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-rose-500 tabular-nums"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] text-emerald-400 block mb-1">T1</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="—"
                    value={ov.target1 ?? ''}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      updateOverride(trade.id, { target1: isNaN(v) || v <= 0 ? undefined : v });
                    }}
                    className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500 tabular-nums"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] text-emerald-400 block mb-1">T2</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="—"
                    value={ov.target2 ?? ''}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      updateOverride(trade.id, { target2: isNaN(v) || v <= 0 ? undefined : v });
                    }}
                    className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500 tabular-nums"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] text-emerald-400 block mb-1">T3</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="—"
                    value={ov.target3 ?? ''}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      updateOverride(trade.id, { target3: isNaN(v) || v <= 0 ? undefined : v });
                    }}
                    className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500 tabular-nums"
                  />
                </label>
              </div>
            ) : (
              <div className="text-[11px] text-slate-400 py-1">
                Option rule: premium paid sized at 1R ({curSym}{trade.risk1RNative.toFixed(0)}). No price stop is used.
              </div>
            )}

            {/* Thesis broken + Setup tags for 30+ correlation */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
              <label className="inline-flex items-center gap-1.5 text-rose-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(ov.thesisBroken)}
                  onChange={(e) => updateOverride(trade.id, { thesisBroken: e.target.checked })}
                  className="accent-rose-500 rounded"
                />
                <span>Thesis broken</span>
              </label>

              {(
                [
                  ['insiderCluster', 'Insider cluster'],
                  ['preCatalystEntry', 'Pre-catalyst'],
                  ['asymmetricRR', 'Asymmetric >3R'],
                  ['volumeConfirmed', 'Volume confirmed'],
                  ['sectorTailwind', 'Sector tailwind'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(trade.loggedFields[key])}
                    onChange={() => toggleLoggedField(trade.id, key, Boolean(trade.loggedFields[key]))}
                    className="accent-cyan-500 rounded"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            {/* Closed trade required exit fields (also editable proactively) */}
            <div className="pt-2 border-t border-[#162334] space-y-2">
              <div className="text-[10px] text-slate-400">
                {trade.status === 'CLOSED'
                  ? '3. Why I Exited (Required Exit Reason + One-Line Lesson)'
                  : '3. Why I Exited (Post-Trade Exit Reason & Lesson)'}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  value={ov.exitReason || ''}
                  onChange={(e) =>
                    updateOverride(trade.id, {
                      exitReason: (e.target.value || undefined) as JournalExitReason | undefined,
                    })
                  }
                  className="bg-[#070c14] border border-[#1a293c] rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                >
                  <option value="">Exit reason...</option>
                  {EXIT_REASONS.map((er) => (
                    <option key={er.value} value={er.value}>
                      {er.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="One-line lesson from this trade..."
                  value={ov.lesson ?? ''}
                  onChange={(e) => updateOverride(trade.id, { lesson: e.target.value })}
                  className="sm:col-span-2 bg-[#070c14] border border-[#1a293c] rounded px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-600 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          </div>

          {/* Column 3: SEC EDGAR Filings Feed (Smart Form 4 Parsed) + Manual Override */}
          <div className="space-y-2.5 text-xs font-mono">
            <div className="flex items-center justify-between border-b border-[#182638] pb-1.5">
              <span className="text-[11px] font-semibold text-slate-300">
                SEC EDGAR Filings (4, 8-K, 13D, 10-Q)
              </span>
              {trade.newTriggerFilings.length > 0 && (
                <button
                  type="button"
                  onClick={() => markFilingsReviewed(trade.id)}
                  className="inline-flex items-center gap-1 text-[11px] text-amber-300 hover:text-emerald-300 transition-colors"
                >
                  <Check className="w-3 h-3" />
                  <span>Mark reviewed</span>
                </button>
              )}
            </div>

            <div className="text-[10px] text-slate-500">
              Source: <span className="text-slate-300">SEC EDGAR</span> · {formatShortTimestamp(trade.secFetchedAt)}
              {trade.lastViewedAt ? ` · Reviewed ${trade.lastViewedAt.slice(0, 10)}` : ''}
            </div>

            {trade.secStatus === 'NO_CIK' ? (
              <div className="text-slate-400 text-[11px] py-2">
                No US SEC CIK found for {trade.ticker} (likely non-US listing). Use manual filing note or AI Search Intelligence below.
              </div>
            ) : trade.secStatus === 'ERROR' ? (
              <div className="text-rose-400 text-[11px] py-2">
                SEC EDGAR fetch error — click Refresh SEC &amp; Prices to retry.
              </div>
            ) : trade.secFilings.length === 0 ? (
              <div className="text-slate-500 text-[11px] py-2">
                {isRefreshingSec ? 'Loading SEC EDGAR submissions...' : 'No recent Form 4, 8-K, SC 13D, or 10-Q filings returned.'}
              </div>
            ) : (
              <div className="max-h-44 overflow-y-auto divide-y divide-[#131e2d] pr-1">
                {trade.secFilings.slice(0, 8).map((f) => {
                  const isUnread = trade.newTriggerFilings.some((nf) => nf.accessionNumber === f.accessionNumber);
                  const f4 = f.form4Summary;
                  return (
                    <div key={f.accessionNumber || `${f.form}-${f.filingDate}`} className="py-1.5 flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <div>
                          <span
                            className={`font-bold ${
                              f4?.isOpenMarketBuy
                                ? 'text-emerald-400'
                                : f4?.isOpenMarketSale
                                ? 'text-rose-400'
                                : f4?.isRoutineNoise
                                ? 'text-slate-500'
                                : isUnread
                                ? 'text-amber-300'
                                : 'text-slate-200'
                            }`}
                          >
                            {f.form}
                          </span>
                          <span className="text-slate-500 mx-1.5">·</span>
                          <span className="text-slate-400">{f.filingDate}</span>
                          {!f4 && f.description && f.description !== f.form && (
                            <span className="text-slate-500 ml-1.5 truncate">{f.description}</span>
                          )}
                        </div>
                        {f4 && (
                          <div
                            className={`text-[10px] leading-snug ${
                              f4.isOpenMarketBuy
                                ? 'text-emerald-300/90'
                                : f4.isOpenMarketSale
                                ? 'text-rose-300/90'
                                : 'text-slate-500'
                            }`}
                          >
                            {f4.actionLabel} · {f4.insiderName} ({f4.insiderRole})
                            {f4.shares > 0
                              ? ` · ${f4.shares.toLocaleString()} shs${f4.pricePerShare > 0 ? ` @ $${f4.pricePerShare.toFixed(2)}` : ''}`
                              : ''}
                          </div>
                        )}
                      </div>
                      {isSafeSecUrl(f.secUrl) && (
                        <a
                          href={f.secUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cyan-400 hover:text-cyan-300 shrink-0 mt-0.5"
                          title="Open SEC filing"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <label className="block pt-1">
              <span className="text-[10px] text-slate-400 block mb-1">Manual Filing / Catalyst Override Note</span>
              <input
                type="text"
                placeholder="Optional manual filing note or European regulatory link..."
                value={ov.manualFilingNote ?? ''}
                onChange={(e) => updateOverride(trade.id, { manualFilingNote: e.target.value })}
                className="w-full bg-[#070c14] border border-[#1a293c] rounded px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
              />
            </label>
          </div>
        </div>

        {/* Bottom Row: AI Filing & News Intelligence (directly aligned to the 3 manual inputs) */}
        {(() => {
          const intel = intelByTradeId[trade.id];
          const isAnalyzing = analyzingTradeId === trade.id;
          const intelError = intelErrorByTradeId[trade.id];
          const effectiveCatDate = trade.catalystDate || intel?.catalystRadar?.suggestedDate;
          const hasExpiryMismatch = Boolean(!isStock && trade.expiry && effectiveCatDate && effectiveCatDate > trade.expiry);

          const verdictStyle =
            intel?.thesisCheck.verdict === 'ALIGNED'
              ? 'text-emerald-400'
              : intel?.thesisCheck.verdict === 'RISK'
              ? 'text-rose-400'
              : intel?.thesisCheck.verdict === 'WATCH'
              ? 'text-amber-300'
              : 'text-slate-400';

          const verdictLabel =
            intel?.thesisCheck.verdict === 'ALIGNED'
              ? 'Thesis Aligned'
              : intel?.thesisCheck.verdict === 'RISK'
              ? 'Thesis Risk'
              : intel?.thesisCheck.verdict === 'WATCH'
              ? 'Watch Carefully'
              : 'Add Thesis to Check';

          const dilutionStyle =
            intel?.runwayAndDilution.dilutionRisk === 'HIGH'
              ? 'text-rose-400'
              : intel?.runwayAndDilution.dilutionRisk === 'MODERATE'
              ? 'text-amber-300'
              : intel?.runwayAndDilution.dilutionRisk === 'LOW'
              ? 'text-emerald-400'
              : 'text-slate-400';

          return (
            <div className="border-t border-[#182638] pt-4 space-y-3 text-xs font-mono">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                  <span className="text-[11px] font-semibold text-slate-200">
                    AI Filing &amp; News Intelligence
                  </span>
                  {intel && (
                    <span className="text-[10px] text-slate-500">
                      · {intel.source} · {formatShortTimestamp(intel.analyzedAt)}
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  disabled={isAnalyzing}
                  onClick={() => handleAnalyzeTrade(trade, Boolean(intel))}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#0d1827] hover:bg-[#132236] border border-[#1f344d] text-[11px] font-mono text-cyan-300 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${isAnalyzing ? 'animate-spin' : ''}`} />
                  <span>
                    {isAnalyzing
                      ? 'Analyzing filings & news...'
                      : intel
                      ? 'Re-analyze'
                      : 'Analyze Filings & News'}
                  </span>
                </button>
              </div>

              {intelError && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-md px-3 py-2 text-[11px] text-rose-300">
                  {intelError}
                </div>
              )}

              {!intel && !isAnalyzing && !intelError && (
                <div className="bg-[#070c14] border border-[#162334] rounded-lg px-3.5 py-2.5 text-[11px] text-slate-400">
                  Click <span className="text-cyan-300">Analyze Filings &amp; News</span> to check your thesis against recent SEC filings &amp; news, extract upcoming catalyst dates + cash runway/dilution, and pull exit-day context on closed trades.
                </div>
              )}

              {intel && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  {/* Card 1: Thesis Check + Plain-English Filing Digests (paired with 1. Why I Entered) */}
                  <div className="bg-[#070c14] border border-[#162334] rounded-lg p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2 border-b border-[#142030] pb-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">
                        1. Thesis Check &amp; Filing Digests
                      </span>
                      <span className={`text-[11px] font-bold ${verdictStyle}`}>{verdictLabel}</span>
                    </div>

                    <div className="space-y-1">
                      <p className="text-[11px] text-slate-200 leading-relaxed">{intel.thesisCheck.summary}</p>
                      {intel.thesisCheck.evidence && (
                        <p className="text-[10px] text-slate-400 leading-relaxed">
                          {intel.thesisCheck.evidence}
                          {sanitizeExternalUrl(intel.thesisCheck.sourceUrl) && (
                            <a
                              href={sanitizeExternalUrl(intel.thesisCheck.sourceUrl)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-0.5 text-cyan-400 hover:text-cyan-300 ml-1.5"
                            >
                              <span>Source</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </p>
                      )}
                    </div>

                    {intel.filingDigests.length > 0 && (
                      <div className="pt-1.5 border-t border-[#142030] space-y-1.5 max-h-36 overflow-y-auto pr-1">
                        {intel.filingDigests.map((fd, idx) => {
                          const matColor =
                            fd.materiality === 'DILUTION'
                              ? 'text-rose-400'
                              : fd.materiality === 'INSIDER_BUY'
                              ? 'text-emerald-400'
                              : fd.materiality === 'MATERIAL'
                              ? 'text-amber-300'
                              : 'text-slate-500';
                          const safeLink = sanitizeExternalUrl(fd.secUrl);
                          return (
                            <div key={`${fd.form}-${fd.date}-${idx}`} className="text-[10px] space-y-0.5">
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0 truncate">
                                  <span className={`font-bold ${matColor}`}>{fd.form}</span>
                                  <span className="text-slate-500 mx-1">·</span>
                                  <span className="text-slate-400">{fd.date}</span>
                                  <span className="text-slate-500 mx-1">·</span>
                                  <span className="text-slate-200">{fd.headline}</span>
                                </div>
                                {safeLink && (
                                  <a
                                    href={safeLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 hover:text-cyan-300 shrink-0"
                                    title="Open filing/source"
                                  >
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                              </div>
                              <p className="text-slate-400 leading-snug">{fd.summary}</p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Card 2: Catalyst Radar + Runway & Dilution (paired with 2. Catalyst Waiting For) */}
                  <div className="bg-[#070c14] border border-[#162334] rounded-lg p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2 border-b border-[#142030] pb-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">
                        2. Catalyst Radar &amp; Runway
                      </span>
                      <span
                        className={`text-[10px] font-bold ${
                          intel.catalystRadar.timelineDrift === 'DELAYED'
                            ? 'text-amber-300'
                            : intel.catalystRadar.timelineDrift === 'ON_TRACK'
                            ? 'text-emerald-400'
                            : intel.catalystRadar.timelineDrift === 'PULLED_FORWARD'
                            ? 'text-cyan-300'
                            : 'text-slate-400'
                        }`}
                      >
                        {intel.catalystRadar.timelineDrift.replace('_', ' ')}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <div className="text-[11px] text-slate-200 font-medium">
                        {intel.catalystRadar.eventLabel}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px] text-slate-400 tabular-nums">
                          Date:{' '}
                          <span className="text-cyan-300 font-semibold">
                            {intel.catalystRadar.suggestedDate || 'Not confirmed'}
                          </span>
                          {intel.catalystRadar.suggestedCatalystType
                            ? ` · ${intel.catalystRadar.suggestedCatalystType}`
                            : ''}
                        </div>
                        {intel.catalystRadar.suggestedDate && (
                          <button
                            type="button"
                            onClick={() =>
                              updateOverride(trade.id, {
                                catalystDate: intel.catalystRadar.suggestedDate,
                                ...(intel.catalystRadar.suggestedCatalystType
                                  ? { catalystType: intel.catalystRadar.suggestedCatalystType }
                                  : {}),
                              })
                            }
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-[10px] text-emerald-300 transition-colors"
                            title="Apply detected catalyst date to your manual journal field"
                          >
                            <ArrowDownToLine className="w-2.5 h-2.5" />
                            <span>Apply Date</span>
                          </button>
                        )}
                      </div>

                      {intel.catalystRadar.driftNote && (
                        <p className="text-[10px] text-slate-400 leading-snug">{intel.catalystRadar.driftNote}</p>
                      )}

                      {hasExpiryMismatch && (
                        <div className="text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                          Expiry mismatch: catalyst ({effectiveCatDate}) falls after option expiry ({trade.expiry}).
                        </div>
                      )}
                    </div>

                    {/* Cash Runway & Dilution */}
                    <div className="pt-2 border-t border-[#142030] space-y-1">
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-400">Cash / Burn</span>
                        <span className="text-slate-200 tabular-nums text-right">
                          {intel.runwayAndDilution.cashAndEquivalents || 'Unknown'} ·{' '}
                          {intel.runwayAndDilution.quarterlyBurn || 'Unknown'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-slate-400">Runway &amp; Dilution</span>
                        <span className={`font-semibold tabular-nums ${dilutionStyle}`}>
                          {intel.runwayAndDilution.estimatedRunwayMonths !== null &&
                          intel.runwayAndDilution.estimatedRunwayMonths !== undefined
                            ? `~${intel.runwayAndDilution.estimatedRunwayMonths} mo · `
                            : ''}
                          Dilution: {intel.runwayAndDilution.dilutionRisk}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 leading-snug">
                        {intel.runwayAndDilution.atmOrShelfNote}
                      </p>
                    </div>
                  </div>

                  {/* Card 3: Exit-Day Context (for Closed Trades) + Verified Sources */}
                  <div className="bg-[#070c14] border border-[#162334] rounded-lg p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2 border-b border-[#142030] pb-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">
                        {trade.status === 'CLOSED'
                          ? `3. Exit-Day Context (${trade.exitDate || 'Closed'})`
                          : '3. Grounded Sources & Citations'}
                      </span>
                    </div>

                    {trade.status === 'CLOSED' && intel.exitContext ? (
                      <div className="space-y-1.5">
                        <p className="text-[11px] text-slate-200 leading-relaxed">{intel.exitContext.summary}</p>
                        {intel.exitContext.keyEvents.length > 0 && (
                          <div className="space-y-1 pt-1">
                            {intel.exitContext.keyEvents.map((ev, idx) => {
                              const safeUrl = sanitizeExternalUrl(ev.sourceUrl);
                              return (
                                <div key={`${ev.date}-${idx}`} className="flex items-start justify-between gap-2 text-[10px]">
                                  <span className="text-slate-400">
                                    <span className="text-slate-300">{ev.date}</span> · {ev.headline}
                                  </span>
                                  {safeUrl && (
                                    <a
                                      href={safeUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-cyan-400 hover:text-cyan-300 shrink-0"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-400 leading-relaxed">
                        {trade.status === 'CLOSED'
                          ? 'Re-analyze to pull +/- 3 day news and filings around your broker exit date.'
                          : 'Once this position is closed in IBKR, Re-analyze will automatically pull +/- 3 day exit-date news and filings right beside your exit reason and lesson.'}
                      </div>
                    )}

                    {intel.sources.length > 0 && (
                      <div className="pt-2 border-t border-[#142030] space-y-1">
                        <div className="text-[10px] text-slate-500">Verified Citations</div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1">
                          {intel.sources.slice(0, 6).map((src, idx) => {
                            const safe = sanitizeExternalUrl(src.url);
                            if (!safe) return null;
                            return (
                              <a
                                key={`${safe}-${idx}`}
                                href={safe}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 max-w-[200px] truncate"
                                title={src.title}
                              >
                                <span className="truncate">{src.title}</span>
                                <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                              </a>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    );
  };

  // Render inline outline-reason strip when the user clicks a row's left-edge signal reason
  const renderSignalReasonStrip = (trade: JournalDerivedTrade) => {
    if (openSignalReasonId !== trade.id) return null;
    return (
      <div className="bg-[#080f19] border-t border-[#182638] px-5 py-2.5 text-xs font-mono flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <div className={`font-bold ${OUTLINE_TEXT[trade.signalColor]}`}>
            Signal: {OUTLINE_LABEL[trade.signalColor]} Outline
          </div>
          {trade.signalReasons.map((r, idx) => (
            <div key={`${r.code}-${idx}`} className="text-slate-300">
              <span>{r.detail}</span>
              <span className="text-slate-500">
                {' '}
                · {r.source}
                {r.timestamp ? ` (${formatShortTimestamp(r.timestamp)})` : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {trade.newTriggerFilings.length > 0 && (
            <button
              type="button"
              onClick={() => markFilingsReviewed(trade.id)}
              className="text-amber-300 hover:text-emerald-300 underline underline-offset-2"
            >
              Mark SEC filings reviewed
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpenSignalReasonId(null)}
            className="text-slate-400 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  };

  return (
    <section
      aria-label="Filtered Journal Deep-Dive Panel"
      className="bg-[#0d1520] border border-[#1c2838] rounded-xl overflow-hidden shadow-sm"
    >
      {/* ------------------------------------------------------------ */}
      {/* PANEL HEADER & STRICT 2-TAB SWITCHER (POSITIONS | ANALYSIS) */}
      {/* ------------------------------------------------------------ */}
      <div className="px-5 py-4 border-b border-[#182638] flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-white font-sans">Filtered Journal</h3>
          <p className="text-xs font-mono text-slate-400 mt-0.5">
            Fixed-1R risk tracking, SEC EDGAR automation, and closed-trade edge analysis. Signals use left-edge outline only.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* SEC & Market Refresh Control */}
          <button
            type="button"
            onClick={() => refreshSecAndMarket(true)}
            disabled={isRefreshingSec}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#080d14] hover:bg-[#111c2b] border border-[#1a283a] text-xs font-mono text-slate-300 transition-colors whitespace-nowrap disabled:opacity-50"
            title="Refresh Yahoo Finance quotes and SEC EDGAR filings"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isRefreshingSec ? 'animate-spin' : ''}`} />
            <span>{isRefreshingSec ? 'Refreshing SEC...' : 'Refresh SEC & Prices'}</span>
          </button>

          {/* 1R & Sleeve Cap Config Toggle */}
          <button
            type="button"
            onClick={() => setShowRiskConfig((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono transition-colors whitespace-nowrap ${
              showRiskConfig
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-[#080d14] border-[#1a283a] text-slate-300 hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>1R &amp; Cap</span>
          </button>

          {/* Strict 2-Tab Switcher: Positions vs Analysis */}
          <div className="flex items-center bg-[#070c14] border border-[#182638] rounded-lg p-0.5 text-xs font-mono">
            <button
              type="button"
              onClick={() => setActiveTab('POSITIONS')}
              className={`px-3.5 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'POSITIONS'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              Positions
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ANALYSIS')}
              className={`px-3.5 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                activeTab === 'ANALYSIS'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              Analysis
            </button>
          </div>
        </div>
      </div>

      {/* Inline 1R Default & Sleeve Cap Config Bar (collapsed by default) */}
      {showRiskConfig && (
        <div className="px-5 py-3 bg-[#09101a] border-b border-[#182638] flex flex-wrap items-center gap-6 text-xs font-mono">
          <label className="flex items-center gap-2 text-slate-300">
            <span>Default 1R Risk (position currency):</span>
            <input
              type="number"
              min={10}
              step={10}
              value={settings.defaultRisk1R}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v > 0) {
                  onChangeSettings((prev) => ({ ...prev, defaultRisk1R: v }));
                }
              }}
              className="w-20 bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-white tabular-nums focus:outline-none focus:border-emerald-500"
            />
          </label>
          <label className="flex items-center gap-2 text-slate-300">
            <span>Open-Risk Sleeve Cap (%):</span>
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={settings.sleeveCapPct}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v > 0) {
                  onChangeSettings((prev) => ({ ...prev, sleeveCapPct: v }));
                }
              }}
              className="w-16 bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-white tabular-nums focus:outline-none focus:border-emerald-500"
            />
          </label>
          <label className="flex items-center gap-2 text-slate-300">
            <span>SEC Auto-Refresh (min):</span>
            <input
              type="number"
              min={5}
              max={120}
              step={5}
              value={settings.autoRefreshMinutes}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v >= 5) {
                  onChangeSettings((prev) => ({ ...prev, autoRefreshMinutes: v }));
                }
              }}
              className="w-16 bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-white tabular-nums focus:outline-none focus:border-emerald-500"
            />
          </label>
          <span className="text-slate-500 ml-auto">
            SEC sync: {formatShortTimestamp(secLastFetchedAt)}
          </span>
        </div>
      )}

      {/* ------------------------------------------------------------ */}
      {/* ALWAYS-VISIBLE TOP STRIP: STRICTLY 4 NUMBERS */}
      {/* ------------------------------------------------------------ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-[#182638] bg-[#0a111b] border-b border-[#182638]">
        {/* 1. Total Open Risk */}
        <div className="px-5 py-3.5">
          <div className="text-[11px] font-mono text-slate-400">Open Risk</div>
          <div className="text-xl font-bold font-mono text-white tabular-nums mt-0.5">
            {fmtMoney(topStrip.totalOpenRiskBase)}
          </div>
          <div
            className={`text-[11px] font-mono tabular-nums mt-0.5 ${
              topStrip.exceedsSleeveCap ? 'text-rose-400' : 'text-slate-400'
            }`}
          >
            {topStrip.openRiskPctOfPortfolio.toFixed(1)}% of portfolio · Cap {topStrip.sleeveCapPct}%
          </div>
        </div>

        {/* 2. Open R (Sum) */}
        <div className="px-5 py-3.5">
          <div className="text-[11px] font-mono text-slate-400">Open R (Sum)</div>
          <div
            className={`text-xl font-bold font-mono tabular-nums mt-0.5 ${
              topStrip.openRSum >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {fmtR(topStrip.openRSum)}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-0.5">
            Default 1R = {settings.defaultRisk1R}
          </div>
        </div>

        {/* 3. Positions Needing Attention (Amber + Red) */}
        <div className="px-5 py-3.5">
          <div className="text-[11px] font-mono text-slate-400">Needs Attention</div>
          <div className="text-xl font-bold font-mono text-white tabular-nums mt-0.5">
            {topStrip.attentionCount}
          </div>
          <div className="text-[11px] font-mono text-slate-400 tabular-nums mt-0.5">
            {topStrip.redCount} red · {topStrip.amberCount} amber
          </div>
        </div>

        {/* 4. Trades Logged: X / 30 */}
        <div className="px-5 py-3.5">
          <div className="text-[11px] font-mono text-slate-400">Trades Logged</div>
          <div className="text-xl font-bold font-mono text-white tabular-nums mt-0.5">
            {topStrip.closedTradesLogged} / 30
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-0.5">
            {topStrip.statisticallyMeaningful
              ? 'Statistically meaningful sample'
              : 'Not statistically meaningful below 30'}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ */}
      {/* TAB CONTENT: POSITIONS vs ANALYSIS */}
      {/* ------------------------------------------------------------ */}
      <div className="p-5">
        {activeTab === 'ANALYSIS' ? (
          <JournalAnalysisTab
            analysis={analysis}
            closedTrades={closedTrades}
            baseCurrency={baseCurrency}
            onJumpToClosedTrades={() => {
              setActiveTab('POSITIONS');
              setStatusChip('CLOSED');
              setInstrumentFilter('ALL');
              setActiveSavedViewId(null);
            }}
          />
        ) : (
          <div className="space-y-4">
            {/* POSITIONS CONTROL BAR */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[#182638]">
              {/* Left: Instrument Toggle + Quick Filter Chips + Dropdowns */}
              <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono">
                {/* Instrument Toggle: Stocks / Options / All */}
                <div className="flex items-center bg-[#070c14] border border-[#182638] rounded-lg p-0.5">
                  {(['STOCK', 'OPTION', 'ALL'] as const).map((inst) => (
                    <button
                      key={inst}
                      type="button"
                      onClick={() => {
                        setInstrumentFilter(inst);
                        setActiveSavedViewId(null);
                      }}
                      className={`px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
                        instrumentFilter === inst
                          ? 'bg-[#16273c] text-white font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {inst === 'STOCK' ? 'Stocks' : inst === 'OPTION' ? 'Options' : 'All'}
                    </button>
                  ))}
                </div>

                {/* Quick Filter Chips: Open, Needs attention, Closed */}
                <div className="flex items-center bg-[#070c14] border border-[#182638] rounded-lg p-0.5">
                  {(
                    [
                      ['OPEN', 'Open'],
                      ['ATTENTION', 'Needs attention'],
                      ['CLOSED', 'Closed'],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => {
                        setStatusChip(val);
                        setActiveSavedViewId(null);
                      }}
                      className={`px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
                        statusChip === val
                          ? 'bg-emerald-500/20 text-emerald-300 font-bold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Catalyst Filter */}
                <select
                  aria-label="Filter by catalyst type"
                  value={catalystFilter}
                  onChange={(e) => {
                    setCatalystFilter(e.target.value);
                    setActiveSavedViewId(null);
                  }}
                  className="bg-[#070c14] border border-[#182638] rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
                >
                  <option value="ALL">All catalysts</option>
                  {CATALYST_TYPES.map((ct) => (
                    <option key={ct} value={ct}>
                      {ct}
                    </option>
                  ))}
                </select>

                {/* Age Filter */}
                <select
                  aria-label="Filter by trade age"
                  value={ageFilter}
                  onChange={(e) => {
                    setAgeFilter(e.target.value as 'ALL' | 'LT14' | 'D14_60' | 'GT60');
                    setActiveSavedViewId(null);
                  }}
                  className="bg-[#070c14] border border-[#182638] rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-emerald-500"
                >
                  <option value="ALL">All ages</option>
                  <option value="LT14">&lt; 14 days</option>
                  <option value="D14_60">14 – 60 days</option>
                  <option value="GT60">60+ days</option>
                </select>
              </div>

              {/* Right: Layout Toggle (Table / Timeline) */}
              <div className="flex items-center bg-[#070c14] border border-[#182638] rounded-lg p-0.5 text-xs font-mono">
                <button
                  type="button"
                  onClick={() => setLayoutMode('TABLE')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
                    layoutMode === 'TABLE'
                      ? 'bg-[#16273c] text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Table2 className="w-3.5 h-3.5" />
                  <span>Table</span>
                </button>
                <button
                  type="button"
                  onClick={() => setLayoutMode('TIMELINE')}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors whitespace-nowrap ${
                    layoutMode === 'TIMELINE'
                      ? 'bg-[#16273c] text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Calendar className="w-3.5 h-3.5" />
                  <span>Timeline</span>
                </button>
              </div>
            </div>

            {/* SAVED VIEWS BAR */}
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
              <span className="text-slate-500 inline-flex items-center gap-1 mr-1">
                <Bookmark className="w-3 h-3" />
                <span>Saved views:</span>
              </span>
              {settings.savedViews.map((v) => {
                const isActive = activeSavedViewId === v.id;
                return (
                  <div key={v.id} className="inline-flex items-center">
                    <button
                      type="button"
                      onClick={() => applySavedView(v)}
                      className={`px-2.5 py-1 rounded-md border transition-colors whitespace-nowrap ${
                        isActive
                          ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300 font-bold'
                          : 'bg-[#080d14] border-[#182638] text-slate-300 hover:text-white'
                      }`}
                    >
                      {v.name}
                    </button>
                    {!v.builtIn && (
                      <button
                        type="button"
                        onClick={() => handleDeleteSavedView(v.id)}
                        title="Delete saved view"
                        className="ml-0.5 p-1 text-slate-500 hover:text-rose-400"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}

              {showSaveViewInput ? (
                <div className="inline-flex items-center gap-1.5">
                  <input
                    type="text"
                    placeholder="View name..."
                    value={newViewName}
                    onChange={(e) => setNewViewName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveCurrentView()}
                    className="bg-[#070c14] border border-[#1a293c] rounded px-2 py-1 text-xs text-white w-36 focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={handleSaveCurrentView}
                    className="px-2 py-1 rounded bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSaveViewInput(false)}
                    className="text-slate-400 hover:text-white"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowSaveViewInput(true)}
                  className="inline-flex items-center gap-1 px-2 py-1 text-slate-400 hover:text-slate-200 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>Save current view</span>
                </button>
              )}

              <span className="ml-auto text-[11px] text-slate-500 hidden md:inline">
                Sorted by attention (Red · Amber · Green · Grey) → nearest catalyst/expiry
              </span>
            </div>

            {/* -------------------------------------------------------- */}
            {/* LAYOUT: TIMELINE CALENDAR OR INSTRUMENT-ADAPTIVE TABLES */}
            {/* -------------------------------------------------------- */}
            {layoutMode === 'TIMELINE' ? (
              <div className="space-y-3 pt-1">
                {timeline.weeks.length === 0 ? (
                  <div className="py-10 text-center text-xs font-mono text-slate-400 border border-[#182638] rounded-lg bg-[#09101a]">
                    No upcoming catalyst dates or option expiries match the active filters. Set a catalyst date inside any expanded row to plot it here.
                  </div>
                ) : (
                  <div className="overflow-x-auto pb-2">
                    <div className="flex gap-3 min-w-max">
                      {timeline.weeks.map((week) => {
                        const isCluster = week.events.length >= 2;
                        return (
                          <div
                            key={week.weekKey}
                            className="w-60 shrink-0 bg-[#09101a] border border-[#182638] rounded-lg p-3 space-y-2.5"
                          >
                            <div className="flex items-center justify-between border-b border-[#162334] pb-2 font-mono">
                              <span className="text-xs font-bold text-white">{week.weekLabel}</span>
                              <span
                                className={`text-[10px] ${
                                  isCluster ? 'text-amber-300 font-bold' : 'text-slate-500'
                                }`}
                              >
                                {week.events.length} {week.events.length === 1 ? 'event' : 'events'}
                              </span>
                            </div>

                            <div className="space-y-2">
                              {week.events.map((ev) => (
                                <button
                                  key={ev.id}
                                  type="button"
                                  onClick={() => {
                                    setLayoutMode('TABLE');
                                    setExpandedRowId(ev.tradeId);
                                  }}
                                  className={`w-full text-left bg-[#0d1520] hover:bg-[#111d2d] border border-[#182638] ${OUTLINE_BORDER[ev.signalColor]} rounded-r-md px-2.5 py-2 transition-colors font-mono`}
                                >
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="font-bold text-white">{ev.ticker}</span>
                                    <span className={ev.currentR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                      {fmtR(ev.currentR)}
                                    </span>
                                  </div>
                                  <div className="text-[11px] text-slate-300 truncate mt-0.5">
                                    {ev.eventType === 'EXPIRY' ? 'Expiry: ' : 'Catalyst: '}
                                    {ev.eventLabel}
                                  </div>
                                  <div className="text-[10px] text-slate-500 mt-0.5 tabular-nums">
                                    {ev.date} · {ev.daysUntil >= 0 ? `${ev.daysUntil}d` : `${Math.abs(ev.daysUntil)}d ago`}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {timeline.undatedCount > 0 && (
                  <div className="text-[11px] font-mono text-slate-500">
                    {timeline.undatedCount} open position{timeline.undatedCount === 1 ? '' : 's'} without a catalyst date or expiry not shown on timeline.
                  </div>
                )}
              </div>
            ) : filteredTrades.length === 0 ? (
              <div className="py-10 text-center text-xs font-mono text-slate-400 border border-[#182638] rounded-lg bg-[#09101a]">
                No trades match the selected journal filters.
              </div>
            ) : (
              <div className="space-y-5">
                {/* STOCKS TABLE (6 columns: ticker | type | thesis | range bar | current R | catalyst date) */}
                {(instrumentFilter === 'STOCK' || (instrumentFilter === 'ALL' && stockRows.length > 0)) && (
                  <div className="space-y-2">
                    {instrumentFilter === 'ALL' && (
                      <div className="text-xs font-mono font-semibold text-slate-300">
                        Stocks ({stockRows.length})
                      </div>
                    )}
                    <div className="border border-[#182638] rounded-lg overflow-hidden">
                      <div className="hidden lg:grid lg:grid-cols-[1.15fr_0.8fr_2.1fr_1.9fr_1fr_1.15fr] gap-3 px-4 py-2.5 bg-[#09101a] border-b border-[#182638] text-[10px] font-mono text-slate-400 font-semibold">
                        <div>Ticker</div>
                        <div>Type</div>
                        <div>One-Line Thesis</div>
                        <div>Range Bar (Stop → T1/T2/T3)</div>
                        <div className="text-right">Current R</div>
                        <div className="text-right">Catalyst Date</div>
                      </div>

                      <div className="divide-y divide-[#152233]">
                        {stockRows.map((trade) => {
                          const isExpanded = expandedRowId === trade.id;
                          const curSym = trade.currency === 'EUR' ? '€' : '$';
                          return (
                            <div
                              key={trade.id}
                              className={`${OUTLINE_BORDER[trade.signalColor]} transition-colors`}
                            >
                              <div className="grid grid-cols-1 lg:grid-cols-[1.15fr_0.8fr_2.1fr_1.9fr_1fr_1.15fr] gap-3 px-4 py-3 items-center hover:bg-[#111c2b]/70 transition-colors">
                                {/* Col 1: Ticker + clickable outline reason */}
                                <div className="flex items-center gap-2 min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                    className="text-slate-400 hover:text-white shrink-0"
                                    aria-label={`Toggle details for ${trade.ticker}`}
                                  >
                                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                  </button>
                                  <div className="min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                      className="font-mono font-bold text-sm text-white hover:text-emerald-300 text-left block truncate"
                                    >
                                      {trade.ticker}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setOpenSignalReasonId(openSignalReasonId === trade.id ? null : trade.id)
                                      }
                                      className={`text-[10px] font-mono ${OUTLINE_TEXT[trade.signalColor]} hover:underline text-left block`}
                                      title="Click to inspect why this row has this outline color"
                                    >
                                      {OUTLINE_LABEL[trade.signalColor]} · why?
                                    </button>
                                  </div>
                                </div>

                                {/* Col 2: Type */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left text-xs font-mono text-slate-300"
                                >
                                  <div>{trade.displayType}</div>
                                  <div className="text-[10px] text-slate-500 tabular-nums">
                                    {trade.quantity.toLocaleString()} shs
                                  </div>
                                </button>

                                {/* Col 3: One-line thesis */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left text-xs text-slate-300 truncate"
                                  title={trade.thesis || 'Click row to add one-line thesis'}
                                >
                                  {trade.thesis ? (
                                    <span>{trade.thesis}</span>
                                  ) : (
                                    <span className="text-slate-500 font-mono">Click to add thesis · {trade.catalystType}</span>
                                  )}
                                </button>

                                {/* Col 4: Range bar */}
                                <div onClick={() => setExpandedRowId(isExpanded ? null : trade.id)} className="cursor-pointer">
                                  <StockRangeBar trade={trade} />
                                </div>

                                {/* Col 5: Current R */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left lg:text-right font-mono tabular-nums"
                                >
                                  <div
                                    className={`text-sm font-bold ${
                                      trade.currentR >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                    }`}
                                  >
                                    {fmtR(trade.currentR)}
                                  </div>
                                  <div className="text-[10px] text-slate-400">
                                    {fmtMoney(trade.pnlNative, curSym, true)}
                                  </div>
                                </button>

                                {/* Col 6: Catalyst Date */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left lg:text-right font-mono tabular-nums"
                                >
                                  <div className="text-xs text-slate-200">
                                    {trade.catalystDate || 'Unscheduled'}
                                  </div>
                                  <div className="text-[10px] text-slate-500">
                                    {trade.catalystType}
                                  </div>
                                </button>
                              </div>

                              {renderSignalReasonStrip(trade)}
                              {isExpanded && renderExpandedDetail(trade)}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* OPTIONS TABLE (7 columns: ticker | type | thesis | DTE | prem paid vs current % | breakeven vs current | current R) */}
                {(instrumentFilter === 'OPTION' || (instrumentFilter === 'ALL' && optionRows.length > 0)) && (
                  <div className="space-y-2">
                    {instrumentFilter === 'ALL' && (
                      <div className="text-xs font-mono font-semibold text-slate-300">
                        Options ({optionRows.length})
                      </div>
                    )}
                    <div className="border border-[#182638] rounded-lg overflow-hidden">
                      <div className="hidden lg:grid lg:grid-cols-[1.25fr_0.9fr_1.6fr_0.75fr_1.15fr_1.2fr_0.95fr] gap-3 px-4 py-2.5 bg-[#09101a] border-b border-[#182638] text-[10px] font-mono text-slate-400 font-semibold">
                        <div>Ticker</div>
                        <div>Type</div>
                        <div>Thesis</div>
                        <div className="text-right">DTE</div>
                        <div className="text-right">Prem Paid vs Cur</div>
                        <div className="text-right">Breakeven vs Spot</div>
                        <div className="text-right">Current R</div>
                      </div>

                      <div className="divide-y divide-[#152233]">
                        {optionRows.map((trade) => {
                          const isExpanded = expandedRowId === trade.id;
                          const curSym = trade.currency === 'EUR' ? '€' : '$';
                          return (
                            <div
                              key={trade.id}
                              className={`${OUTLINE_BORDER[trade.signalColor]} transition-colors`}
                            >
                              <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_0.9fr_1.6fr_0.75fr_1.15fr_1.2fr_0.95fr] gap-3 px-4 py-3 items-center hover:bg-[#111c2b]/70 transition-colors">
                                {/* Col 1: Ticker + Strike + Outline Reason */}
                                <div className="flex items-center gap-2 min-w-0">
                                  <button
                                    type="button"
                                    onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                    className="text-slate-400 hover:text-white shrink-0"
                                    aria-label={`Toggle details for ${trade.contractSymbol}`}
                                  >
                                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                  </button>
                                  <div className="min-w-0">
                                    <button
                                      type="button"
                                      onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                      className="font-mono font-bold text-sm text-white hover:text-emerald-300 text-left block truncate"
                                    >
                                      {trade.ticker}{' '}
                                      <span className="text-xs font-normal text-slate-400">
                                        {trade.strike ? `${curSym}${trade.strike}` : ''} {trade.optionType?.[0] || ''}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setOpenSignalReasonId(openSignalReasonId === trade.id ? null : trade.id)
                                      }
                                      className={`text-[10px] font-mono ${OUTLINE_TEXT[trade.signalColor]} hover:underline text-left block`}
                                      title="Click to inspect why this row has this outline color"
                                    >
                                      {OUTLINE_LABEL[trade.signalColor]} · why?
                                    </button>
                                  </div>
                                </div>

                                {/* Col 2: Type */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left text-xs font-mono text-slate-300"
                                >
                                  <div>{trade.displayType}</div>
                                  <div className="text-[10px] text-slate-500 tabular-nums">
                                    {trade.quantity} ct
                                  </div>
                                </button>

                                {/* Col 3: Thesis */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left text-xs text-slate-300 truncate"
                                  title={trade.thesis || 'Click row to add one-line thesis'}
                                >
                                  {trade.thesis ? (
                                    <span>{trade.thesis}</span>
                                  ) : (
                                    <span className="text-slate-500 font-mono">Click to add thesis · {trade.catalystType}</span>
                                  )}
                                </button>

                                {/* Col 4: Days to Expiry */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left lg:text-right font-mono tabular-nums"
                                >
                                  <div className="text-xs font-semibold text-slate-200">
                                    {trade.status === 'CLOSED'
                                      ? 'Closed'
                                      : trade.dte !== undefined
                                      ? `${trade.dte}d`
                                      : '—'}
                                  </div>
                                  <div className="text-[10px] text-slate-500">{trade.expiry || '—'}</div>
                                </button>

                                {/* Col 5: Premium Paid vs Current (%) */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left lg:text-right font-mono tabular-nums"
                                >
                                  <div
                                    className={`text-xs font-bold ${
                                      (trade.premiumChangePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                    }`}
                                  >
                                    {trade.premiumChangePct !== undefined
                                      ? `${trade.premiumChangePct > 0 ? '+' : ''}${trade.premiumChangePct.toFixed(1)}%`
                                      : '—'}
                                  </div>
                                  <div className="text-[10px] text-slate-500">
                                    {trade.premiumPaidNative !== undefined
                                      ? `${fmtMoney(trade.premiumPaidNative, curSym)} → ${fmtMoney(trade.currentOptionValueNative || 0, curSym)}`
                                      : '—'}
                                  </div>
                                </button>

                                {/* Col 6: Breakeven vs Current Spot */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left lg:text-right font-mono tabular-nums"
                                >
                                  <div className="text-xs text-slate-200">
                                    BE {trade.breakevenPrice ? fmtPrice(trade.breakevenPrice, trade.currency) : '—'}
                                  </div>
                                  <div
                                    className={`text-[10px] ${
                                      (trade.breakevenDiffPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-slate-400'
                                    }`}
                                  >
                                    Spot {trade.spotPrice ? fmtPrice(trade.spotPrice, trade.currency) : '—'}
                                    {trade.breakevenDiffPct !== undefined
                                      ? ` (${trade.breakevenDiffPct > 0 ? '+' : ''}${trade.breakevenDiffPct.toFixed(1)}%)`
                                      : ''}
                                  </div>
                                </button>

                                {/* Col 7: Current R */}
                                <button
                                  type="button"
                                  onClick={() => setExpandedRowId(isExpanded ? null : trade.id)}
                                  className="text-left lg:text-right font-mono tabular-nums"
                                >
                                  <div
                                    className={`text-sm font-bold ${
                                      trade.currentR >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                    }`}
                                  >
                                    {fmtR(trade.currentR)}
                                  </div>
                                  <div className="text-[10px] text-slate-400">
                                    {fmtMoney(trade.pnlNative, curSym, true)}
                                  </div>
                                </button>
                              </div>

                              {renderSignalReasonStrip(trade)}
                              {isExpanded && renderExpandedDetail(trade)}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
