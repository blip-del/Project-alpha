import React, { useState } from 'react';
import {
  Search,
  ChevronDown,
  ChevronRight,
  Link2,
  Zap,
  Shield,
  BarChart3,
  Clock,
  Coins,
  History,
  Upload,
} from 'lucide-react';
import {
  UnifiedTickerSummary,
  BucketType,
  OptionalPanelsState,
  CampaignComparisonItem,
} from '../types';

interface UnifiedTickerMatrixProps {
  tickers: UnifiedTickerSummary[];
  baseCurrency: 'EUR' | 'USD';
  panels: OptionalPanelsState;
  onChangePanels: React.Dispatch<React.SetStateAction<OptionalPanelsState>>;
  onToggleCampaignBucket: (transactionIds: string[], currentBucket: BucketType) => void;
  onToggleBucket: (transactionId: string) => void;
  onOpenImport: () => void;
}

export const UnifiedTickerMatrix: React.FC<UnifiedTickerMatrixProps> = ({
  tickers,
  baseCurrency,
  panels,
  onChangePanels,
  onToggleCampaignBucket,
  onToggleBucket,
  onOpenImport,
}) => {
  const [scope, setScope] = useState<'ACTIVE' | 'ALL'>('ACTIVE');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTickers, setExpandedTickers] = useState<Record<string, boolean>>({});
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);
  const [subViewByTicker, setSubViewByTicker] = useState<Record<string, 'CAMPAIGNS' | 'STEPS'>>({});

  const baseSym = baseCurrency === 'EUR' ? '€' : '$';
  const activeCount = tickers.filter((t) => t.isActive).length;
  const totalCount = tickers.length;

  const fmtMoney = (val: number, curSym: string = baseSym) => {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    return `${sign}${curSym}${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const fmtSigned = (val: number, curSym: string = baseSym) => {
    const abs = Math.abs(val);
    const sign = val > 0 ? '+' : val < 0 ? '-' : '';
    return `${sign}${curSym}${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const fmtShare = (val: number, cur: string) => {
    const s = cur === 'EUR' ? '€' : '$';
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    const dec = abs > 0 && abs < 2 ? 3 : 2;
    return `${sign}${s}${abs.toFixed(dec)}`;
  };

  const filteredTickers = tickers.filter((t) => {
    if (scope === 'ACTIVE' && !t.isActive) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return t.ticker.toLowerCase().includes(q) || t.companyName.toLowerCase().includes(q);
  });

  const toggleTickerExpand = (ticker: string) => {
    setExpandedTickers((prev) => ({ ...prev, [ticker]: !prev[ticker] }));
  };

  const togglePanel = (key: keyof OptionalPanelsState) => {
    onChangePanels((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (tickers.length === 0) {
    return (
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-10 text-center space-y-4 max-w-2xl mx-auto my-6 shadow-sm">
        <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
          <Upload className="w-6 h-6" />
        </div>
        <div className="space-y-1.5">
          <h3 className="text-base font-bold text-white font-sans">
            No Portfolio Data Loaded
          </h3>
          <p className="text-xs font-mono text-slate-400 max-w-md mx-auto leading-relaxed">
            Import an Interactive Brokers Flex XML, Multi-Section Activity CSV, or JSON backup in Trade Ledger &amp; Import to populate your Unified Ticker Matrix and Real Entry Basis Engine.
          </p>
        </div>
        <button
          onClick={onOpenImport}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-bold transition-colors"
        >
          <Upload className="w-4 h-4" />
          <span>Import IBKR Statement</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- */}
      {/* 2. VIEW FILTER & OPTIONAL DEEP-DIVE CONTROL BAR */}
      {/* ---------------------------------------------------------------- */}
      <div className="bg-[#0b121d] border border-[#1c2838] rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        {/* Left: Scope Filter + Search */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center bg-[#070c14] border border-[#182638] rounded-lg p-0.5 text-xs font-mono">
            <button
              onClick={() => setScope('ACTIVE')}
              className={`px-3 py-1.5 rounded-md transition-all ${
                scope === 'ACTIVE'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              Active Tickers ({activeCount})
            </button>
            <button
              onClick={() => setScope('ALL')}
              className={`px-3 py-1.5 rounded-md transition-all ${
                scope === 'ALL'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent'
              }`}
            >
              All Tickers ({totalCount})
            </button>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2 pointer-events-none" />
            <input
              type="text"
              placeholder="Search Ticker..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#070c14] border border-[#1a293c] rounded-lg pl-8 pr-3 py-1.5 text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500 w-44 sm:w-52"
            />
          </div>
        </div>

        {/* Right: Optional Deep-Dive Panels (ALL OFF BY DEFAULT) */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1 hidden sm:inline">
            Deep-Dive Panels:
          </span>

          <button
            onClick={() => togglePanel('stepDown')}
            aria-pressed={panels.stepDown}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all ${
              panels.stepDown
                ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300 font-bold'
                : 'bg-[#080d14] border-[#1a283a] text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className={`w-2 h-2 rounded-sm ${panels.stepDown ? 'bg-emerald-400' : 'border border-slate-500'}`} />
            <Shield className="w-3.5 h-3.5" />
            <span>Basis Step-Down Chart</span>
          </button>

          <button
            onClick={() => togglePanel('monthlyCashflow')}
            aria-pressed={panels.monthlyCashflow}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all ${
              panels.monthlyCashflow
                ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-300 font-bold'
                : 'bg-[#080d14] border-[#1a283a] text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className={`w-2 h-2 rounded-sm ${panels.monthlyCashflow ? 'bg-cyan-400' : 'border border-slate-500'}`} />
            <BarChart3 className="w-3.5 h-3.5" />
            <span>Monthly Cashflow Chart</span>
          </button>

          <button
            onClick={() => togglePanel('expiryMatrix')}
            aria-pressed={panels.expiryMatrix}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all ${
              panels.expiryMatrix
                ? 'bg-purple-500/15 border-purple-500/50 text-purple-300 font-bold'
                : 'bg-[#080d14] border-[#1a283a] text-slate-400 hover:text-slate-200'
            }`}
          >
            <span className={`w-2 h-2 rounded-sm ${panels.expiryMatrix ? 'bg-purple-400' : 'border border-slate-500'}`} />
            <Clock className="w-3.5 h-3.5" />
            <span>Open Expiry &amp; Theta Matrix</span>
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* 3. PRIMARY WORKSPACE: UNIFIED TICKER PERFORMANCE MATRIX */}
      {/* ---------------------------------------------------------------- */}
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl overflow-hidden shadow-sm">
        {/* Matrix Column Headers (Desktop) */}
        <div className="hidden lg:grid lg:grid-cols-[2.5fr_2.8fr_1.35fr_1.35fr_1.6fr_1.4fr] gap-3 px-5 py-3 bg-[#09101a] border-b border-[#182638] text-[10px] font-mono uppercase tracking-wider text-slate-400 font-semibold items-center">
          <div>Ticker &amp; Exposure</div>
          <div>Cost Basis &amp; Real Entry</div>
          <div className="text-right">Active Open P&amp;L</div>
          <div className="text-right">Realized P&amp;L</div>
          <div className="text-right">Total Ticker Net P&amp;L</div>
          <div className="text-right">Annualized (XIRR)</div>
        </div>

        {filteredTickers.length === 0 ? (
          <div className="p-8 text-center text-xs font-mono text-slate-400">
            No tickers match your filter criteria.
          </div>
        ) : (
          <div className="divide-y divide-[#152234]">
            {filteredTickers.map((t) => {
              const isExpanded = Boolean(expandedTickers[t.ticker]);
              const natSym = t.currency === 'EUR' ? '€' : '$';
              const subView = subViewByTicker[t.ticker] || 'CAMPAIGNS';
              const showNativeSub = t.currency !== baseCurrency;

              // Bullet bar scaling for stock positions
              const maxScale = t.hasStockPosition
                ? Math.max(t.spotPrice, t.rawAvgEntry, t.realEntryPrice, 0.01) * 1.1
                : 1;
              const rawPosPct = Math.min(100, Math.max(2, (t.rawAvgEntry / maxScale) * 100));
              const realPosPct = Math.min(100, Math.max(2, (Math.max(0, t.realEntryPrice) / maxScale) * 100));
              const spotPosPct = Math.min(100, Math.max(2, (t.spotPrice / maxScale) * 100));
              const isProtected = t.cushionPct >= 0;

              return (
                <div key={t.ticker} className={isExpanded ? 'bg-[#0a111c]' : ''}>
                  {/* Unified Ticker Row */}
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleTickerExpand(t.ticker)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleTickerExpand(t.ticker);
                      }
                    }}
                    className="grid grid-cols-1 lg:grid-cols-[2.5fr_2.8fr_1.35fr_1.35fr_1.6fr_1.4fr] gap-3 px-4 sm:px-5 py-4 items-center cursor-pointer hover:bg-[#101b2c]/70 transition-colors"
                  >
                    {/* Col 1: Ticker & Exposure */}
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="mt-0.5 text-slate-500 shrink-0">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-bold text-sm text-white bg-[#070c14] border border-[#1f3147] px-2 py-0.5 rounded">
                            {t.ticker}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-300 border border-slate-700">
                            {t.currency}
                          </span>
                          {t.spotPrice > 0 && (
                            <span className="text-xs font-mono font-bold text-cyan-300">
                              {fmtShare(t.spotPrice, t.currency)}
                              {t.spotChangePct !== 0 && (
                                <span
                                  className={`ml-1 text-[10px] font-normal ${
                                    t.spotChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                                  }`}
                                >
                                  {t.spotChangePct >= 0 ? '+' : ''}
                                  {t.spotChangePct.toFixed(1)}%
                                </span>
                              )}
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-slate-400 truncate mt-1 font-sans">
                          {t.companyName}
                        </div>

                        <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[10px] font-mono">
                          {t.currentShares > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                              {t.currentShares.toLocaleString()} Shs
                            </span>
                          )}
                          {t.openOptionCount > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/30">
                              {t.openOptionCount} Active {t.openOptionCount === 1 ? 'Opt' : 'Opts'}
                            </span>
                          )}
                          {!t.isActive && (
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                              CLOSED
                            </span>
                          )}
                          {t.totalExposureBase > 0 && (
                            <span className="text-slate-400 ml-0.5">
                              Exp: {fmtMoney(t.totalExposureBase)}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Col 2: Cost Basis & Real Entry + Visual Bullet Bar */}
                    <div className="font-mono text-xs min-w-0">
                      {t.hasStockPosition ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="text-slate-400">
                              Raw: <span className="text-slate-200 font-semibold">{fmtShare(t.rawAvgEntry, t.currency)}</span>
                            </span>
                            <span className={t.realEntryPrice < t.rawAvgEntry ? 'text-emerald-400 font-bold' : 'text-slate-200 font-bold'}>
                              Real: {fmtShare(t.realEntryPrice, t.currency)}
                              {t.basisReductionPct > 0.1 && (
                                <span className="text-[10px] text-emerald-300 ml-1">(-{t.basisReductionPct.toFixed(1)}%)</span>
                              )}
                            </span>
                          </div>

                          {/* Visual Bullet Bar: Spot vs Real Entry vs Raw Avg */}
                          <div className="relative h-2.5 w-full bg-[#070c14] border border-[#1a283a] rounded-full overflow-visible">
                            {/* Basis reduction span between Real Entry and Raw Avg */}
                            <div
                              className="absolute top-0 bottom-0 bg-emerald-500/35 rounded-full"
                              style={{
                                left: `${Math.min(realPosPct, rawPosPct)}%`,
                                width: `${Math.max(2, Math.abs(rawPosPct - realPosPct))}%`,
                              }}
                              title={`Basis reduced from ${fmtShare(t.rawAvgEntry, t.currency)} to ${fmtShare(t.realEntryPrice, t.currency)}`}
                            />
                            {/* Raw Avg tick */}
                            <div
                              className="absolute -top-0.5 w-0.5 h-3.5 bg-slate-400"
                              style={{ left: `${rawPosPct}%` }}
                              title={`Raw Avg Cost: ${fmtShare(t.rawAvgEntry, t.currency)}`}
                            />
                            {/* Real Entry tick */}
                            <div
                              className="absolute -top-0.5 w-1 h-3.5 bg-emerald-400 rounded-sm"
                              style={{ left: `${realPosPct}%` }}
                              title={`Real Entry Price: ${fmtShare(t.realEntryPrice, t.currency)}`}
                            />
                            {/* Live Spot marker */}
                            <div
                              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full border border-[#080d14] shadow ${
                                isProtected ? 'bg-cyan-300' : 'bg-rose-400'
                              }`}
                              style={{ left: `${spotPosPct}%` }}
                              title={`Spot Price: ${fmtShare(t.spotPrice, t.currency)}`}
                            />
                          </div>

                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-[10px] text-slate-500">Spot vs Real Entry</span>
                            <span
                              className={`font-bold ${
                                isProtected ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {t.cushionPct >= 0 ? `+${t.cushionPct.toFixed(1)}% Protected` : `${t.cushionPct.toFixed(1)}% Underwater`}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="bg-[#080d14] border border-[#172537] rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
                          <div>
                            <span className="text-[10px] uppercase text-purple-300 font-bold block">
                              Options Only
                            </span>
                            <span className="text-[10px] text-slate-500">
                              {t.isActive ? 'Capital At Risk' : 'Closed Campaigns'}
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-xs font-bold text-slate-200 block">
                              {t.capitalAtRiskBase > 0 ? fmtMoney(t.capitalAtRiskBase) : `${t.totalCampaignCount} Trades`}
                            </span>
                            {showNativeSub && t.capitalAtRiskNative > 0 && (
                              <span className="text-[10px] text-slate-500">
                                ({fmtMoney(t.capitalAtRiskNative, natSym)})
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Col 3: Active Open P&L */}
                    <div className="lg:text-right font-mono flex lg:block items-center justify-between">
                      <span className="text-[10px] uppercase text-slate-500 lg:hidden">Active Open P&amp;L</span>
                      {t.isActive ? (
                        <div>
                          <div
                            className={`text-xs font-bold ${
                              t.activeOpenPnlBase >= 0 ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {fmtSigned(t.activeOpenPnlBase)}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {t.activeOpenPnlPct >= 0 ? '+' : ''}
                            {t.activeOpenPnlPct.toFixed(1)}%
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                    </div>

                    {/* Col 4: Realized P&L */}
                    <div className="lg:text-right font-mono flex lg:block items-center justify-between">
                      <span className="text-[10px] uppercase text-slate-500 lg:hidden">Realized P&amp;L</span>
                      <div>
                        <div
                          className={`text-xs font-bold ${
                            t.realizedPnlBase > 0.005
                              ? 'text-emerald-400'
                              : t.realizedPnlBase < -0.005
                              ? 'text-rose-400'
                              : 'text-slate-400'
                          }`}
                        >
                          {fmtSigned(t.realizedPnlBase)}
                        </div>
                        {showNativeSub && Math.abs(t.realizedPnlNative) > 0.01 && (
                          <div className="text-[10px] text-slate-500">
                            {fmtSigned(t.realizedPnlNative, natSym)}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Col 5: Total Ticker Net P&L */}
                    <div className="lg:text-right font-mono flex lg:block items-center justify-between">
                      <span className="text-[10px] uppercase text-slate-500 lg:hidden">Total Ticker Net P&amp;L</span>
                      <div>
                        <div
                          className={`text-sm font-bold ${
                            t.totalNetPnlBase >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {fmtSigned(t.totalNetPnlBase)}
                        </div>
                        {showNativeSub && (
                          <div className="text-[11px] text-slate-400">
                            {fmtSigned(t.totalNetPnlNative, natSym)}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Col 6: Annualized Return XIRR / ROM */}
                    <div className="lg:text-right font-mono flex lg:block items-center justify-between">
                      <span className="text-[10px] uppercase text-slate-500 lg:hidden">Annualized Return</span>
                      <div>
                        {t.annualizedReturnPct !== null ? (
                          <span
                            className={`text-sm font-bold ${
                              t.annualizedReturnPct >= 0 ? 'text-cyan-300' : 'text-amber-400'
                            }`}
                          >
                            {t.annualizedReturnPct >= 0 ? '+' : ''}
                            {t.annualizedReturnPct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400 font-semibold">Intraday</span>
                        )}
                        <div className="text-[10px] text-slate-500">
                          {t.holdingDays > 0
                            ? t.isShortDuration
                              ? `${t.holdingDays}d Trade (30d ann.)`
                              : `${t.holdingDays}d XIRR`
                            : 'Same-Day'}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ------------------------------------------------------------ */}
                  {/* 4. EXPANDABLE SIDE-BY-SIDE TRADE & CAMPAIGN COMPARISON */}
                  {/* ------------------------------------------------------------ */}
                  {isExpanded && (
                    <div className="border-t border-[#18273a] bg-[#070c14] px-4 sm:px-6 py-4 space-y-3 animate-in fade-in duration-150">
                      {/* Sub-panel header & mini switch (Campaign Comparison vs Basis Steps) */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#142031]">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setSubViewByTicker((p) => ({ ...p, [t.ticker]: 'CAMPAIGNS' }))}
                            className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-mono border transition-colors ${
                              subView === 'CAMPAIGNS'
                                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 font-bold'
                                : 'bg-[#0b131e] border-[#19283c] text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            <Zap className="w-3.5 h-3.5" />
                            <span>Campaign Comparison ({t.campaigns.length})</span>
                          </button>

                          {t.stockPosition && t.stockPosition.timeline.length > 0 && (
                            <button
                              onClick={() => setSubViewByTicker((p) => ({ ...p, [t.ticker]: 'STEPS' }))}
                              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-mono border transition-colors ${
                                subView === 'STEPS'
                                  ? 'bg-purple-500/15 border-purple-500/40 text-purple-300 font-bold'
                                  : 'bg-[#0b131e] border-[#19283c] text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              <History className="w-3.5 h-3.5" />
                              <span>Basis Steps ({t.stockPosition.timeline.length})</span>
                            </button>
                          )}
                        </div>

                        <div className="text-[11px] font-mono text-slate-400">
                          Click option bucket tag to switch{' '}
                          <span className="text-emerald-300 font-semibold">[🔗 Linked]</span> ↔{' '}
                          <span className="text-cyan-300 font-semibold">[⚡ Standalone]</span> • Click row for legs
                        </div>
                      </div>

                      {subView === 'CAMPAIGNS' ? (
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs font-mono">
                            <thead>
                              <tr className="border-b border-[#182638] text-slate-400 text-[10px] uppercase tracking-wider">
                                <th className="pb-2">Campaign / Contract</th>
                                <th className="pb-2">Strategy Type</th>
                                <th className="pb-2 text-center">Bucket Tag</th>
                                <th className="pb-2">Status &amp; Cushion</th>
                                <th className="pb-2 text-right">Capital Deployed</th>
                                <th className="pb-2 text-right">Net P&amp;L ({baseCurrency} / Native)</th>
                                <th className="pb-2 text-right">Trade ROI %</th>
                                <th className="pb-2 text-right">Annualized %</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[#131f2f]">
                              {t.campaigns.map((camp: CampaignComparisonItem) => {
                                const isCampExp = expandedCampaignId === camp.id;
                                const isLinked = camp.bucket === 'LINKED';
                                const campCurSym = camp.currency === 'EUR' ? '€' : '$';
                                const showCampNative = camp.currency !== baseCurrency;

                                return (
                                  <React.Fragment key={camp.id}>
                                    <tr
                                      onClick={() => setExpandedCampaignId(isCampExp ? null : camp.id)}
                                      className="hover:bg-[#0d1725] cursor-pointer transition-colors"
                                    >
                                      <td className="py-2.5 font-bold text-white">
                                        <div className="flex items-center gap-1.5">
                                          <ChevronDown
                                            className={`w-3.5 h-3.5 text-slate-500 transition-transform ${
                                              isCampExp ? 'rotate-180 text-emerald-400' : ''
                                            }`}
                                          />
                                          <span>{camp.kind === 'OPTION_CAMPAIGN' ? camp.title || camp.contractSymbol : camp.contractSymbol}</span>
                                          <span className="text-[10px] font-normal text-slate-500">
                                            ({camp.trades.length} {camp.trades.length === 1 ? 'leg' : 'legs'})
                                          </span>
                                        </div>
                                        {camp.kind === 'OPTION_CAMPAIGN' && (
                                          <div className="text-[10px] font-normal text-slate-500 pl-5">
                                            {camp.contractSymbol}
                                          </div>
                                        )}
                                      </td>

                                      <td className="py-2.5">
                                        <span
                                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                            camp.strategyType.includes('Covered') || camp.strategyType.includes('Put')
                                              ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                                              : camp.strategyType.includes('Dividends')
                                              ? 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                                              : camp.strategyType.includes('Equity')
                                              ? 'bg-slate-800 text-slate-200 border border-slate-700'
                                              : 'bg-purple-500/10 text-purple-300 border border-purple-500/20'
                                          }`}
                                        >
                                          {camp.strategyType}
                                        </span>
                                      </td>

                                      <td className="py-2.5 text-center">
                                        {camp.canToggleBucket ? (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              onToggleCampaignBucket(camp.transactionIds, camp.bucket);
                                            }}
                                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition-colors ${
                                              isLinked
                                                ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
                                                : 'bg-cyan-500/15 hover:bg-cyan-500/25 border-cyan-500/40 text-cyan-300'
                                            }`}
                                            title="Toggle campaign between Linked to Basis and Standalone"
                                          >
                                            {isLinked ? (
                                              <>
                                                <Link2 className="w-2.5 h-2.5" />
                                                <span>[🔗 Linked]</span>
                                              </>
                                            ) : (
                                              <>
                                                <Zap className="w-2.5 h-2.5" />
                                                <span>[⚡ Standalone]</span>
                                              </>
                                            )}
                                          </button>
                                        ) : (
                                          <span className="text-[10px] text-slate-500">
                                            {camp.kind === 'DIVIDENDS' ? '[🔗 Auto-Linked]' : '[🔗 Core]'}
                                          </span>
                                        )}
                                      </td>

                                      <td className="py-2.5">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <span
                                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                                              camp.status === 'OPEN'
                                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                                : 'bg-slate-800 text-slate-400 border border-slate-700'
                                            }`}
                                          >
                                            {camp.status}
                                            {camp.status === 'OPEN' && camp.dte !== undefined ? ` • ${camp.dte}d` : ''}
                                          </span>
                                          {camp.status === 'OPEN' && camp.strikeCushionPct !== undefined && (() => {
                                            const isShortSide = (camp.netContracts || 0) < 0;
                                            const label = isShortSide
                                              ? camp.strikeCushionPct >= 0
                                                ? `+${camp.strikeCushionPct.toFixed(1)}% OTM`
                                                : `${camp.strikeCushionPct.toFixed(1)}% ITM`
                                              : camp.strikeCushionPct >= 0
                                              ? `+${camp.strikeCushionPct.toFixed(1)}% ITM`
                                              : `${camp.strikeCushionPct.toFixed(1)}% OTM`;
                                            const isFavorable = camp.strikeCushionPct >= 0;
                                            return (
                                              <span
                                                className={`text-[10px] font-bold ${
                                                  isFavorable ? 'text-emerald-400' : 'text-amber-400'
                                                }`}
                                              >
                                                {label}
                                              </span>
                                            );
                                          })()}
                                        </div>
                                      </td>

                                      <td className="py-2.5 text-right text-slate-300">
                                        <div>{fmtMoney(camp.capitalDeployedBase)}</div>
                                        {showCampNative && (
                                          <div className="text-[10px] text-slate-500">
                                            {fmtMoney(camp.capitalDeployedNative, campCurSym)}
                                          </div>
                                        )}
                                      </td>

                                      <td className="py-2.5 text-right font-bold">
                                        <div className={camp.netPnlBase >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                          {fmtSigned(camp.netPnlBase)}
                                        </div>
                                        {showCampNative && (
                                          <div className="text-[10px] font-normal text-slate-400">
                                            {fmtSigned(camp.netPnlNative, campCurSym)}
                                          </div>
                                        )}
                                      </td>

                                      <td className="py-2.5 text-right font-semibold">
                                        <span className={camp.tradeRoiPct >= 0 ? 'text-emerald-300' : 'text-rose-400'}>
                                          {camp.tradeRoiPct >= 0 ? '+' : ''}
                                          {camp.tradeRoiPct.toFixed(1)}%
                                        </span>
                                      </td>

                                      <td className="py-2.5 text-right">
                                        {camp.annualizedReturnPct !== null ? (
                                          <div>
                                            <span
                                              className={`font-bold ${
                                                camp.annualizedReturnPct >= 0 ? 'text-cyan-300' : 'text-amber-400'
                                              }`}
                                            >
                                              {camp.annualizedReturnPct >= 0 ? '+' : ''}
                                              {camp.annualizedReturnPct.toFixed(1)}%
                                            </span>
                                            {camp.holdingDays > 0 && (
                                              <span className="text-[10px] text-slate-500 block">
                                                {camp.holdingDays}d
                                              </span>
                                            )}
                                          </div>
                                        ) : (
                                          <span className="text-slate-500">—</span>
                                        )}
                                      </td>
                                    </tr>

                                    {/* Expanded Execution Legs */}
                                    {isCampExp && (
                                      <tr className="bg-[#050910]">
                                        <td colSpan={8} className="px-4 py-3 border-l-2 border-emerald-500/40">
                                          <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-2">
                                            Execution Legs ({camp.trades.length})
                                          </div>
                                          <div className="space-y-1.5">
                                            {camp.trades.map((tr) => {
                                              const isTrLinked = tr.bucket === 'LINKED';
                                              const trSym = tr.currency === 'EUR' ? '€' : '$';
                                              const ocTag = tr.openCloseIndicator === 'O' ? 'OPEN' : tr.openCloseIndicator === 'C' ? 'CLOSE' : '';
                                              return (
                                                <div
                                                  key={tr.id}
                                                  className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-[#0a121d] border border-[#172436] text-[11px]"
                                                >
                                                  <div className="flex items-center gap-2.5">
                                                    <span className="text-slate-400">{tr.dateTime}</span>
                                                    <span
                                                      className={`px-1.5 py-0.2 rounded font-bold text-[10px] ${
                                                        tr.action === 'SELL'
                                                          ? 'bg-emerald-500/15 text-emerald-300'
                                                          : tr.action === 'DIV'
                                                          ? 'bg-cyan-500/15 text-cyan-300'
                                                          : tr.action === 'TAX'
                                                          ? 'bg-amber-500/15 text-amber-300'
                                                          : 'bg-purple-500/15 text-purple-300'
                                                      }`}
                                                    >
                                                      {tr.action} {ocTag}
                                                    </span>
                                                    <span className="text-slate-200 font-semibold">
                                                      {tr.quantity > 0 ? `+${tr.quantity}` : tr.quantity}x @ {trSym}
                                                      {Math.abs(tr.price).toFixed(Math.abs(tr.price) < 2 ? 3 : 2)}
                                                    </span>
                                                  </div>

                                                  <div className="flex items-center gap-3">
                                                    {tr.commission !== 0 && (
                                                      <span className="text-slate-400">
                                                        Comm: {fmtMoney(tr.commission, trSym)}
                                                      </span>
                                                    )}
                                                    <span className={`font-bold ${tr.netCashFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                      Net: {fmtSigned(tr.netCashFlow, trSym)}
                                                    </span>
                                                    {tr.assetCategory === 'OPT' && (
                                                      <button
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          onToggleBucket(tr.id);
                                                        }}
                                                        className={`px-2 py-0.5 rounded text-[10px] border ${
                                                          isTrLinked
                                                            ? 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
                                                            : 'border-cyan-500/30 text-cyan-300 bg-cyan-500/10'
                                                        }`}
                                                      >
                                                        {isTrLinked ? 'Linked' : 'Standalone'}
                                                      </button>
                                                    )}
                                                  </div>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        </td>
                                      </tr>
                                    )}
                                  </React.Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        /* Chronological Basis Steps mini-view */
                        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                          {t.stockPosition?.timeline.map((step, idx) => (
                            <div
                              key={`${t.ticker}-step-${idx}`}
                              className="bg-[#0a121c] border border-[#162335] rounded-lg px-3 py-2 text-xs font-mono flex flex-wrap items-center justify-between gap-2"
                            >
                              <div className="flex items-center gap-2.5">
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                                  #{idx + 1}
                                </span>
                                <span className="text-slate-400">{step.date}</span>
                                <span className="font-bold text-white">{step.actionDesc}</span>
                              </div>
                              <div className="flex items-center gap-4 text-[11px]">
                                <span className="text-slate-400">Shs: {step.sharesAfter}</span>
                                <span className="text-slate-400">Raw: {fmtShare(step.rawAvgCostAfter, t.currency)}</span>
                                <span className="text-emerald-400 font-bold">Real: {fmtShare(step.realEntryPriceAfter, t.currency)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
