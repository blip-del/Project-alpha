import React, { useState } from 'react';
import {
  ChevronDown,
  Shield,
  Zap,
  Link2,
  Coins,
  History,
  Archive,
} from 'lucide-react';
import {
  StockPosition,
  BucketType,
  StandaloneOptionPosition,
  ViewVisibilityState,
} from '../types';
import { getFxMultiplier } from '../utils/portfolioEngine';

interface PositionsTabProps {
  positions: StockPosition[];
  closedPositions?: StockPosition[];
  standalonePositions: StandaloneOptionPosition[];
  bucketOverrides: Record<string, BucketType>;
  onToggleBucket: (transactionId: string) => void;
  onToggleCampaignBucket?: (transactionIds: string[], currentBucket: BucketType) => void;
  baseCurrency: 'EUR' | 'USD';
  fxRates?: Record<string, number>;
  visibility: ViewVisibilityState;
}

export const PositionsTab: React.FC<PositionsTabProps> = ({
  positions,
  closedPositions = [],
  standalonePositions,
  onToggleBucket,
  onToggleCampaignBucket,
  baseCurrency,
  fxRates = {},
  visibility,
}) => {
  const [expandedTicker, setExpandedTicker] = useState<string | null>(positions[0]?.ticker || null);
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);
  const [expandedStandaloneId, setExpandedStandaloneId] = useState<string | null>(null);
  const [activeDrawerTab, setActiveDrawerTab] = useState<'OPTIONS' | 'DIVIDENDS' | 'TIMELINE'>('OPTIONS');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<'ALL' | 'ACTIVE_CC' | 'HIGH_CUSHION' | 'EUROPEAN'>('ALL');
  const [showClosedStocks, setShowClosedStocks] = useState(false);
  const [standaloneFilter, setStandaloneFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');

  const baseSymbol = baseCurrency === 'EUR' ? '€' : '$';

  const fmtMoney = (val: number, cur?: string) => {
    const symbol = cur ? (cur === 'EUR' ? '€' : '$') : baseSymbol;
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    return `${sign}${symbol}${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const fmtPerShare = (val: number, cur?: string) => {
    const symbol = cur ? (cur === 'EUR' ? '€' : '$') : baseSymbol;
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    const decimals = abs > 0 && abs < 2 ? 3 : 2;
    return `${sign}${symbol}${abs.toFixed(decimals)}`;
  };

  // Filter active positions
  const filteredPositions = positions.filter((p) => {
    const matchesSearch =
      p.ticker.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.companyName.toLowerCase().includes(searchTerm.toLowerCase());
    if (!matchesSearch) return false;

    if (filterType === 'ACTIVE_CC') return p.activeCoveredCalls.length > 0;
    if (filterType === 'HIGH_CUSHION') return p.downsideCushionPct >= 20;
    if (filterType === 'EUROPEAN') return p.currency === 'EUR';
    return true;
  });

  // Filter standalone option positions
  const openStandaloneCount = standalonePositions.filter((s) => s.status === 'OPEN').length;
  const closedStandaloneCount = standalonePositions.filter((s) => s.status === 'CLOSED').length;
  const filteredStandalone = standalonePositions.filter((s) => {
    if (standaloneFilter !== 'ALL' && s.status !== standaloneFilter) return false;
    if (!searchTerm) return true;
    return (
      s.underlying.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.contractSymbol.toLowerCase().includes(searchTerm.toLowerCase())
    );
  });

  const renderPositionCard = (p: StockPosition, isClosedCard = false) => {
    const isExpanded = expandedTicker === p.ticker;
    const posCurSym = p.currency === 'EUR' ? '€' : '$';
    const fxToBase = getFxMultiplier(p.currency, baseCurrency, fxRates);
    const marketValueBase = p.marketValue * fxToBase;

    return (
      <div
        key={p.ticker}
        className={`bg-[#0d1520] border rounded-xl overflow-hidden transition-all shadow-sm ${
          isExpanded ? 'border-emerald-500/40 shadow-emerald-500/5' : 'border-[#1c2838] hover:border-[#273b52]'
        }`}
      >
        {/* Main Card Header / Bar */}
        <div
          onClick={() => setExpandedTicker(isExpanded ? null : p.ticker)}
          className="p-5 cursor-pointer flex flex-wrap items-center justify-between gap-4 select-none bg-gradient-to-r from-transparent via-transparent to-[#101b2a]/30"
        >
          {/* Left: Ticker, Name, Shares, Market Value */}
          <div className="flex items-center gap-4 min-w-[220px]">
            <div className="w-11 h-11 rounded-lg bg-[#080d14] border border-[#1e2f44] flex items-center justify-center font-mono font-bold text-sm text-white shadow-inner">
              {p.ticker}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-white text-base font-sans tracking-tight">
                  {p.companyName}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 border border-slate-700">
                  {p.currency}
                </span>
                {p.activeCoveredCalls.length > 0 && (
                  <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    COVERED CALL ACTIVE
                  </span>
                )}
                {isClosedCard && (
                  <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                    CLOSED POSITION
                  </span>
                )}
              </div>
              <div className="text-xs font-mono text-slate-400 flex items-center gap-2.5 mt-0.5 flex-wrap">
                <span>{p.currentShares.toLocaleString()} Shares</span>
                <span>•</span>
                {!isClosedCard ? (
                  <>
                    <span className="text-slate-200 font-semibold">
                      Value: {fmtMoney(p.marketValue, p.currency)}
                    </span>
                    {p.currency !== baseCurrency && (
                      <span className="text-slate-500 text-[11px]">
                        ({fmtMoney(marketValueBase, baseCurrency)})
                      </span>
                    )}
                  </>
                ) : (
                  <span className={p.totalRealizedStockPnl >= 0 ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                    Stock Realized: {p.totalRealizedStockPnl >= 0 ? '+' : ''}{fmtMoney(p.totalRealizedStockPnl, p.currency)}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Middle: Live Spot vs Raw Avg vs Real Entry Price + Dual Performance */}
          {!isClosedCard ? (() => {
            const spotVsRawPct = p.rawAvgEntry > 0 ? ((p.spotPrice - p.rawAvgEntry) / p.rawAvgEntry) * 100 : 0;
            const spotVsRealPct = p.realEntryPrice > 0 ? ((p.spotPrice - p.realEntryPrice) / p.realEntryPrice) * 100 : 100;
            return (
              <div className="flex items-center gap-4 sm:gap-5 font-mono text-xs flex-wrap">
                <div>
                  <span className="text-[10px] uppercase text-slate-500 block">Spot Price</span>
                  <span className="text-sm font-bold text-cyan-300">{fmtPerShare(p.spotPrice, p.currency)}</span>
                  <span className={`text-[10px] block ${p.spotChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {p.spotChange >= 0 ? '+' : ''}{p.spotChangePct.toFixed(2)}%
                  </span>
                </div>

                <div>
                  <span className="text-[10px] uppercase text-slate-500 block">Avg Cost</span>
                  <span className="text-sm font-medium text-slate-300">
                    {fmtPerShare(p.rawAvgEntry, p.currency)}
                  </span>
                  <span className="text-[10px] text-slate-500 block">{fmtMoney(p.rawCostPool, p.currency)}</span>
                </div>

                <div className="bg-[#09101a] border border-emerald-500/30 px-3 py-1.5 rounded-lg">
                  <span className="text-[10px] uppercase text-emerald-400 font-semibold block flex items-center gap-1">
                    <Shield className="w-3 h-3" />
                    Real Entry Price
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-base font-bold text-emerald-400 font-mono">
                      {fmtPerShare(p.realEntryPrice, p.currency)}
                    </span>
                    {p.basisReductionDollar !== 0 && (
                      <span className="text-[10px] font-bold text-emerald-300 bg-emerald-500/20 px-1 rounded">
                        -{posCurSym}{Math.abs(p.basisReductionDollar).toFixed(2)} (-{p.basisReductionPct.toFixed(1)}%)
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-[10px] uppercase text-slate-500 block">Spot vs Avg Cost</span>
                  <span className={`text-sm font-bold font-mono ${spotVsRawPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {spotVsRawPct >= 0 ? '+' : ''}{spotVsRawPct.toFixed(1)}%
                  </span>
                  <span className={`text-[10px] block font-mono ${p.unrealizedPnlRaw >= 0 ? 'text-emerald-300' : 'text-rose-300/80'}`}>
                    {p.unrealizedPnlRaw >= 0 ? '+' : ''}{fmtMoney(p.unrealizedPnlRaw, p.currency)}
                  </span>
                </div>

                <div className="text-right">
                  <span className="text-[10px] uppercase text-slate-500 block">Spot vs Real Entry</span>
                  <span className={`text-base font-bold font-mono ${spotVsRealPct >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
                    {spotVsRealPct >= 0 ? '+' : ''}{spotVsRealPct.toFixed(1)}%
                  </span>
                  <span className="text-[10px] text-slate-400 block font-mono">
                    {p.unrealizedPnlReal >= 0 ? '+' : ''}{fmtMoney(p.unrealizedPnlReal, p.currency)}
                  </span>
                </div>

                <div className="text-right hidden xl:block">
                  <span className="text-[10px] uppercase text-slate-500 block">Yield on Cost</span>
                  <span className="text-sm font-bold text-purple-300 font-mono">
                    {p.yieldOnCostPct.toFixed(1)}%
                  </span>
                  <span className="text-[10px] text-slate-400 block font-mono">
                    Div + Prem
                  </span>
                </div>
              </div>
            );
          })() : (
            <div className="flex items-center gap-6 font-mono text-xs flex-wrap">
              <div>
                <span className="text-[10px] uppercase text-slate-500 block">Realized Stock P&amp;L</span>
                <span className={`text-sm font-bold ${p.totalRealizedStockPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {p.totalRealizedStockPnl >= 0 ? '+' : ''}{fmtMoney(p.totalRealizedStockPnl, p.currency)}
                </span>
              </div>
              <div>
                <span className="text-[10px] uppercase text-slate-500 block">Net Dividends</span>
                <span className="text-sm font-bold text-cyan-300">
                  +{fmtMoney(p.totalDividendsNet, p.currency)}
                </span>
              </div>
              <div>
                <span className="text-[10px] uppercase text-slate-500 block">Linked Options</span>
                <span className={`text-sm font-bold ${p.totalLinkedPremiums >= 0 ? 'text-emerald-300' : 'text-rose-400'}`}>
                  {p.totalLinkedPremiums >= 0 ? '+' : ''}{fmtMoney(p.totalLinkedPremiums, p.currency)}
                </span>
              </div>
            </div>
          )}

          {/* Right: Expand arrow button */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-slate-400 hidden md:inline">
              {isExpanded ? 'Hide Campaigns' : 'Inspect Campaigns'}
            </span>
            <div
              className={`w-7 h-7 rounded-full bg-[#132236] flex items-center justify-center text-slate-300 transition-transform duration-200 ${
                isExpanded ? 'rotate-180 bg-emerald-500/20 text-emerald-400' : ''
              }`}
            >
              <ChevronDown className="w-4 h-4" />
            </div>
          </div>
        </div>

        {/* EXPANDED CAMPAIGN DRAWER */}
        {isExpanded && (
          <div className="border-t border-[#18273a] bg-[#070c14] p-5 space-y-4 animate-in fade-in duration-150">
            <div className="flex items-center justify-between border-b border-[#152336] pb-3 flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setActiveDrawerTab('OPTIONS')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                    activeDrawerTab === 'OPTIONS'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold'
                      : 'bg-[#0d1624] text-slate-400 hover:text-slate-200 border border-[#1b2a3d]'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Options &amp; Covered Calls ({p.linkedOptionCampaigns.length + p.standaloneOptionCampaigns.length})</span>
                </button>

                <button
                  onClick={() => setActiveDrawerTab('DIVIDENDS')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                    activeDrawerTab === 'DIVIDENDS'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-bold'
                      : 'bg-[#0d1624] text-slate-400 hover:text-slate-200 border border-[#1b2a3d]'
                  }`}
                >
                  <Coins className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Dividends &amp; Taxes ({p.dividends.length})</span>
                </button>

                <button
                  onClick={() => setActiveDrawerTab('TIMELINE')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-colors ${
                    activeDrawerTab === 'TIMELINE'
                      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40 font-bold'
                      : 'bg-[#0d1624] text-slate-400 hover:text-slate-200 border border-[#1b2a3d]'
                  }`}
                >
                  <History className="w-3.5 h-3.5 text-purple-400" />
                  <span>Basis Journey Timeline ({p.timeline.length} Steps)</span>
                </button>
              </div>

              <div className="text-[11px] font-mono text-slate-400 hidden sm:block">
                Click any toggle pill to switch between <span className="text-emerald-400 font-bold">[🔗 Linked]</span> and <span className="text-cyan-400 font-bold">[⚡ Standalone]</span>.
              </div>
            </div>

            {activeDrawerTab === 'OPTIONS' && (
              <div className="space-y-3">
                <div className="bg-[#09121e] border border-[#19283c] rounded-lg px-3 py-2 text-[11px] font-mono text-slate-400 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="text-slate-200 font-semibold">Auto-Bucket Rule:</span>{' '}
                    <span className="text-emerald-300">SELL-to-Open</span> Covered Calls / Cash-Secured Puts &amp; their closing legs default to <span className="text-emerald-400 font-semibold">[🔗 Linked]</span>;{' '}
                    <span className="text-cyan-300">BUY-to-Open</span> Long Calls / Long Puts default to <span className="text-cyan-400 font-semibold">[⚡ Standalone]</span>.
                  </span>
                  <span className="text-slate-500">Click any row to inspect exact fill legs</span>
                </div>

                {p.linkedOptionCampaigns.length === 0 && p.standaloneOptionCampaigns.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 font-mono text-xs">
                    No option trades recorded for {p.ticker}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs font-mono">
                      <thead>
                        <tr className="border-b border-[#182638] text-slate-400 text-[10px] uppercase tracking-wider">
                          <th className="pb-2">Contract / Campaign</th>
                          <th className="pb-2">Side &amp; Type</th>
                          <th className="pb-2">Strike</th>
                          <th className="pb-2">Expiry</th>
                          <th className="pb-2 text-center">Net Pos</th>
                          <th className="pb-2">Status</th>
                          <th className="pb-2 text-right">Net Cash Impact</th>
                          <th className="pb-2 text-center">Bucket Classification</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#131f2f]">
                        {[...p.linkedOptionCampaigns, ...p.standaloneOptionCampaigns].map((camp) => {
                          const isLinked = camp.bucket === 'LINKED';
                          const campCurSym = camp.currency === 'EUR' ? '€' : '$';
                          const isCampExpanded = expandedCampaignId === camp.id;
                          const openingLeg = camp.trades[0];
                          const isShortOpen = openingLeg?.action === 'SELL';
                          const sideLabel = isShortOpen
                            ? camp.type === 'CALL'
                              ? 'SHORT CC'
                              : 'SHORT PUT'
                            : camp.type === 'CALL'
                            ? 'LONG CALL'
                            : 'LONG PUT';

                          return (
                            <React.Fragment key={camp.id}>
                              <tr
                                onClick={() => setExpandedCampaignId(isCampExpanded ? null : camp.id)}
                                className="hover:bg-[#0a121c] transition-colors cursor-pointer"
                              >
                                <td className="py-2.5 font-bold text-white">
                                  <div className="flex items-center gap-2">
                                    <ChevronDown
                                      className={`w-3.5 h-3.5 text-slate-500 transition-transform ${
                                        isCampExpanded ? 'rotate-180 text-emerald-400' : ''
                                      }`}
                                    />
                                    <span>{camp.contractSymbol}</span>
                                    <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-slate-800/80 text-slate-400 border border-slate-700/70">
                                      {camp.trades.length} {camp.trades.length === 1 ? 'leg' : 'legs'}
                                    </span>
                                    {camp.isCurrentCoveredCall && (
                                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                                        ACTIVE CC
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2.5">
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                      isShortOpen
                                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                        : 'bg-cyan-500/10 text-cyan-300 border border-cyan-500/20'
                                    }`}
                                  >
                                    {sideLabel}
                                  </span>
                                </td>
                                <td className="py-2.5 text-slate-200">{campCurSym}{camp.strike.toFixed(2)}</td>
                                <td className="py-2.5 text-slate-400">{camp.expiry}</td>
                                <td className="py-2.5 text-center text-slate-300">
                                  {camp.netContracts !== 0 ? (camp.netContracts > 0 ? `+${camp.netContracts}` : camp.netContracts) : '0'}
                                </td>
                                <td className="py-2.5">
                                  <span
                                    className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                                      camp.status === 'OPEN'
                                        ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                                    }`}
                                  >
                                    {camp.status}
                                  </span>
                                </td>
                                <td className="py-2.5 text-right font-bold">
                                  <span className={camp.netCashFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                                    {camp.netCashFlow >= 0 ? '+' : ''}
                                    {fmtMoney(camp.netCashFlow, camp.currency)}
                                  </span>
                                </td>
                                <td className="py-2.5 text-center">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (onToggleCampaignBucket) {
                                        onToggleCampaignBucket(camp.trades.map((t) => t.id), camp.bucket);
                                      } else if (camp.trades[0]) {
                                        onToggleBucket(camp.trades[0].id);
                                      }
                                    }}
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono border transition-all ${
                                      isLinked
                                        ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300 shadow-sm shadow-emerald-500/10'
                                        : 'bg-cyan-500/15 hover:bg-cyan-500/25 border-cyan-500/40 text-cyan-300'
                                    }`}
                                    title="Click to toggle between Bucket A (Linked to Basis) and Bucket B (Standalone Trade)"
                                  >
                                    {isLinked ? (
                                      <>
                                        <Link2 className="w-3 h-3 text-emerald-400" />
                                        <span>[🔗 Linked to Basis]</span>
                                      </>
                                    ) : (
                                      <>
                                        <Zap className="w-3 h-3 text-cyan-400" />
                                        <span>[⚡ Standalone Trade]</span>
                                      </>
                                    )}
                                  </button>
                                </td>
                              </tr>
                              {isCampExpanded && (
                                <tr className="bg-[#050a11]">
                                  <td colSpan={8} className="px-4 py-3 border-l-2 border-emerald-500/40">
                                    <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-2">
                                      Execution Legs ({camp.trades.length}) — {isShortOpen ? 'Opened Short (Sell to Open)' : 'Opened Long (Buy to Open)'}
                                    </div>
                                    <div className="space-y-1.5">
                                      {camp.trades.map((tr) => {
                                        const isTrLinked = tr.bucket === 'LINKED';
                                        const ocTag = tr.openCloseIndicator === 'O' ? 'OPEN' : tr.openCloseIndicator === 'C' ? 'CLOSE' : '';
                                        return (
                                          <div
                                            key={tr.id}
                                            className="flex flex-wrap items-center justify-between gap-3 px-2.5 py-1.5 rounded bg-[#0a121d] border border-[#172436] text-[11px]"
                                          >
                                            <div className="flex items-center gap-2.5">
                                              <span className="text-slate-400">{tr.dateTime}</span>
                                              <span
                                                className={`px-1.5 py-0.2 rounded font-bold text-[10px] ${
                                                  tr.action === 'SELL' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-cyan-500/15 text-cyan-300'
                                                }`}
                                              >
                                                {tr.action} {ocTag}
                                              </span>
                                              <span className="text-slate-200 font-semibold">
                                                {tr.quantity > 0 ? `+${tr.quantity}` : tr.quantity}x @ {campCurSym}{tr.price.toFixed(2)}
                                              </span>
                                            </div>
                                            <div className="flex items-center gap-4">
                                              <span className="text-slate-400">
                                                Comm: {fmtMoney(tr.commission, tr.currency)}
                                              </span>
                                              <span className={`font-bold ${tr.netCashFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                Net: {tr.netCashFlow >= 0 ? '+' : ''}{fmtMoney(tr.netCashFlow, tr.currency)}
                                              </span>
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
                                                title="Toggle individual leg bucket"
                                              >
                                                {isTrLinked ? 'Linked' : 'Standalone'}
                                              </button>
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
                )}
              </div>
            )}

            {activeDrawerTab === 'DIVIDENDS' && (
              <div className="space-y-3">
                {p.dividends.length === 0 ? (
                  <div className="text-center py-8 text-slate-500 font-mono text-xs">
                    No dividend payouts recorded for {p.ticker}.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs font-mono">
                      <thead>
                        <tr className="border-b border-[#182638] text-slate-400 text-[10px] uppercase tracking-wider">
                          <th className="pb-2">Payout Date</th>
                          <th className="pb-2">Description</th>
                          <th className="pb-2 text-right">Gross Dividend</th>
                          <th className="pb-2 text-right">Withholding Tax</th>
                          <th className="pb-2 text-right">Net Received</th>
                          <th className="pb-2 text-right">Basis Reduction / sh</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#131f2f]">
                        {p.dividends.map((div) => {
                          const divCurSym = div.currency === 'EUR' ? '€' : '$';
                          const perShareBenefit = p.currentShares > 0 ? div.netAmount / p.currentShares : 0;
                          return (
                            <tr key={div.id} className="hover:bg-[#0a121c] transition-colors">
                              <td className="py-2.5 font-bold text-slate-300">{div.date}</td>
                              <td className="py-2.5 text-slate-400 text-[11px] truncate max-w-[280px]">
                                {div.description}
                              </td>
                              <td className="py-2.5 text-right text-slate-300 font-medium">
                                +{fmtMoney(div.grossAmount, div.currency)}
                              </td>
                              <td className="py-2.5 text-right text-rose-400 font-medium">
                                -{fmtMoney(div.withholdingTax, div.currency)}
                              </td>
                              <td className="py-2.5 text-right text-emerald-400 font-bold">
                                +{fmtMoney(div.netAmount, div.currency)}
                              </td>
                              <td className="py-2.5 text-right text-emerald-300 text-[11px]">
                                {p.currentShares > 0 ? `-${divCurSym}${perShareBenefit.toFixed(3)}/sh` : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeDrawerTab === 'TIMELINE' && (
              <div className="space-y-3">
                <p className="text-xs text-slate-400 font-mono">
                  Step-by-step mathematical progression of <span className="text-white font-bold">{p.ticker}</span> cost basis from inception:
                </p>

                <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                  {p.timeline.map((step, idx) => (
                    <div
                      key={`step-${idx}`}
                      className="bg-[#09101a] border border-[#172538] rounded-lg p-3 text-xs font-mono flex flex-wrap items-center justify-between gap-3 hover:border-[#233852] transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                          Step #{idx + 1}
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-slate-400">{step.date}</span>
                            <span className="text-slate-700">•</span>
                            <span className="font-bold text-white">{step.actionDesc}</span>
                          </div>
                          <span className="text-[11px] text-slate-400 block mt-0.5">{step.notes}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-right">
                        <div>
                          <span className="text-[10px] uppercase text-slate-500 block">Shares</span>
                          <span className="text-slate-300 font-semibold">{step.sharesAfter}</span>
                        </div>

                        <div>
                          <span className="text-[10px] uppercase text-slate-500 block">Raw Avg Cost</span>
                          <span className="text-slate-400 font-medium">{fmtPerShare(step.rawAvgCostAfter, p.currency)}</span>
                        </div>

                        <div className="bg-[#050a11] px-2 py-1 rounded border border-emerald-500/20">
                          <span className="text-[10px] uppercase text-emerald-400 block font-semibold">Real Entry</span>
                          <span className="text-emerald-400 font-bold">{fmtPerShare(step.realEntryPriceAfter, p.currency)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* FILTER & SEARCH CONTROLS */}
      <div className="bg-[#0b1320] border border-[#1c2838] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <input
            type="text"
            placeholder="Search holding or option by ticker (CAPR, NOK, SAN, NVDA...)"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full bg-[#080d14] border border-[#1e2f44] rounded-lg px-3.5 py-1.5 text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
          />
        </div>

        <div className="flex items-center gap-1.5 text-xs font-mono flex-wrap">
          <button
            onClick={() => setFilterType('ALL')}
            className={`px-3 py-1.5 rounded-md border transition-all ${
              filterType === 'ALL'
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 font-bold'
                : 'bg-[#0d1624] border-[#1c2838] text-slate-400 hover:text-slate-200'
            }`}
          >
            Active Equities ({positions.length})
          </button>
          <button
            onClick={() => setFilterType('ACTIVE_CC')}
            className={`px-3 py-1.5 rounded-md border transition-all ${
              filterType === 'ACTIVE_CC'
                ? 'bg-cyan-500/10 border-cyan-500/40 text-cyan-300 font-bold'
                : 'bg-[#0d1624] border-[#1c2838] text-slate-400 hover:text-slate-200'
            }`}
          >
            Active Covered Calls
          </button>
          <button
            onClick={() => setFilterType('HIGH_CUSHION')}
            className={`px-3 py-1.5 rounded-md border transition-all ${
              filterType === 'HIGH_CUSHION'
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 font-bold'
                : 'bg-[#0d1624] border-[#1c2838] text-slate-400 hover:text-slate-200'
            }`}
          >
            High Cushion (&gt;20%)
          </button>
          <button
            onClick={() => setFilterType('EUROPEAN')}
            className={`px-3 py-1.5 rounded-md border transition-all ${
              filterType === 'EUROPEAN'
                ? 'bg-purple-500/10 border-purple-500/40 text-purple-300 font-bold'
                : 'bg-[#0d1624] border-[#1c2838] text-slate-400 hover:text-slate-200'
            }`}
          >
            EUR Native Assets
          </button>
        </div>
      </div>

      {/* ACTIVE STOCK HOLDINGS LIST */}
      <div className="space-y-4">
        {filteredPositions.length === 0 ? (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-8 text-center text-xs font-mono text-slate-400">
            No active stock holdings match the current filter.
          </div>
        ) : (
          filteredPositions.map((p) => renderPositionCard(p, false))
        )}
      </div>

      {/* STANDALONE TRADES SECTION (BUCKET B) */}
      {visibility.section_standalone_options && standalonePositions.length > 0 && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                <Zap className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white font-sans flex items-center gap-2">
                  Bucket B // Standalone Options &amp; Speculative Trades
                </h3>
                <p className="text-xs text-slate-400 font-mono">
                  Long calls, long puts, and unlinked option trades kept separate from equity cost basis.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-xs font-mono">
              <button
                onClick={() => setStandaloneFilter('ALL')}
                className={`px-2.5 py-1 rounded border ${
                  standaloneFilter === 'ALL'
                    ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300 font-bold'
                    : 'bg-[#080d14] border-[#1c2838] text-slate-400'
                }`}
              >
                All ({standalonePositions.length})
              </button>
              <button
                onClick={() => setStandaloneFilter('OPEN')}
                className={`px-2.5 py-1 rounded border ${
                  standaloneFilter === 'OPEN'
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 font-bold'
                    : 'bg-[#080d14] border-[#1c2838] text-slate-400'
                }`}
              >
                Open ({openStandaloneCount})
              </button>
              <button
                onClick={() => setStandaloneFilter('CLOSED')}
                className={`px-2.5 py-1 rounded border ${
                  standaloneFilter === 'CLOSED'
                    ? 'bg-slate-700/40 border-slate-500 text-slate-200 font-bold'
                    : 'bg-[#080d14] border-[#1c2838] text-slate-400'
                }`}
              >
                Closed ({closedStandaloneCount})
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-[#182638] text-slate-400 text-[10px] uppercase tracking-wider">
                  <th className="pb-2">Underlying</th>
                  <th className="pb-2">Contract</th>
                  <th className="pb-2">Type</th>
                  <th className="pb-2">Strike</th>
                  <th className="pb-2">Expiry</th>
                  <th className="pb-2 text-center">Qty</th>
                  <th className="pb-2 text-right">Entry / Mark</th>
                  <th className="pb-2 text-right">Mkt Value / Outlay</th>
                  <th className="pb-2 text-right">Unrealized P&amp;L</th>
                  <th className="pb-2 text-right">Realized P&amp;L</th>
                  <th className="pb-2 text-center">Status</th>
                  <th className="pb-2 text-center">Bucket</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#131f2f]">
                {filteredStandalone.map((pos) => {
                  const isOpen = pos.status === 'OPEN';
                  const curSym = pos.currency === 'EUR' ? '€' : '$';
                  const isRealProfit = pos.realizedPnl >= 0;
                  const isUnrlProfit = pos.unrealizedPnl >= 0;
                  const isStandaloneExpanded = expandedStandaloneId === pos.id;

                  return (
                    <React.Fragment key={pos.id}>
                      <tr
                        onClick={() => setExpandedStandaloneId(isStandaloneExpanded ? null : pos.id)}
                        className="hover:bg-[#0a121c] transition-colors cursor-pointer"
                      >
                        <td className="py-2.5 font-bold text-white">
                          <div className="flex items-center gap-1.5">
                            <ChevronDown
                              className={`w-3.5 h-3.5 text-slate-500 transition-transform ${
                                isStandaloneExpanded ? 'rotate-180 text-cyan-400' : ''
                              }`}
                            />
                            <span>{pos.underlying}</span>
                          </div>
                        </td>
                        <td className="py-2.5 text-slate-200">{pos.contractSymbol}</td>
                        <td className="py-2.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              pos.type === 'CALL' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                            }`}
                          >
                            {pos.type}
                          </span>
                        </td>
                        <td className="py-2.5 text-slate-200">{curSym}{pos.strike.toFixed(pos.strike < 5 ? 2 : 0)}</td>
                        <td className="py-2.5 text-slate-400">{pos.expiry}</td>
                        <td className="py-2.5 text-center font-bold text-white">
                          {isOpen ? (pos.netContracts > 0 ? `+${pos.netContracts}` : pos.netContracts) : '0'}
                        </td>
                        <td className="py-2.5 text-right text-slate-300">
                          {isOpen ? (
                            <span>
                              {curSym}{pos.avgEntryPrice.toFixed(2)} → <span className="text-white font-semibold">{curSym}{pos.currentMarkPrice.toFixed(2)}</span>
                            </span>
                          ) : (
                            <span>{curSym}{pos.avgEntryPrice.toFixed(2)}</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right text-slate-200">
                          {isOpen ? fmtMoney(pos.marketValue, pos.currency) : fmtMoney(pos.totalOutlay, pos.currency)}
                        </td>
                        <td className="py-2.5 text-right font-bold">
                          {isOpen ? (
                            <span className={isUnrlProfit ? 'text-emerald-400' : 'text-rose-400'}>
                              {isUnrlProfit ? '+' : ''}{fmtMoney(pos.unrealizedPnl, pos.currency)}
                            </span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="py-2.5 text-right font-bold">
                          {pos.realizedPnl !== 0 || !isOpen ? (
                            <span className={isRealProfit ? 'text-emerald-400' : 'text-rose-400'}>
                              {isRealProfit ? '+' : ''}{fmtMoney(pos.realizedPnl, pos.currency)}
                            </span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="py-2.5 text-center">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded border ${
                              isOpen
                                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 font-bold'
                                : 'bg-slate-800 text-slate-400 border-slate-700'
                            }`}
                          >
                            {pos.status}
                          </span>
                        </td>
                        <td className="py-2.5 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onToggleCampaignBucket) {
                                onToggleCampaignBucket(pos.trades.map((t) => t.id), 'STANDALONE');
                              } else if (pos.trades[0]) {
                                onToggleBucket(pos.trades[0].id);
                              }
                            }}
                            className="px-2.5 py-1 rounded bg-[#102030] hover:bg-[#182d44] border border-[#233a57] text-slate-300 text-[11px] font-mono transition-colors"
                            title="Switch to Bucket A (Linked to Basis)"
                          >
                            Link to {pos.underlying}
                          </button>
                        </td>
                      </tr>
                      {isStandaloneExpanded && (
                        <tr className="bg-[#050a11]">
                          <td colSpan={12} className="px-4 py-3 border-l-2 border-cyan-500/40">
                            <div className="space-y-1.5">
                              {pos.trades.map((tr) => {
                                const ocTag = tr.openCloseIndicator === 'O' ? 'OPEN' : tr.openCloseIndicator === 'C' ? 'CLOSE' : '';
                                return (
                                  <div
                                    key={tr.id}
                                    className="flex flex-wrap items-center justify-between gap-3 px-2.5 py-1.5 rounded bg-[#0a121d] border border-[#172436] text-[11px]"
                                  >
                                    <div className="flex items-center gap-2.5">
                                      <span className="text-slate-400">{tr.dateTime}</span>
                                      <span
                                        className={`px-1.5 py-0.2 rounded font-bold text-[10px] ${
                                          tr.action === 'SELL' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-cyan-500/15 text-cyan-300'
                                        }`}
                                      >
                                        {tr.action} {ocTag}
                                      </span>
                                      <span className="text-slate-200 font-semibold">
                                        {tr.quantity > 0 ? `+${tr.quantity}` : tr.quantity}x @ {curSym}{tr.price.toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-4">
                                      <span className="text-slate-400">Comm: {fmtMoney(tr.commission, tr.currency)}</span>
                                      <span className={`font-bold ${tr.netCashFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                        Net: {tr.netCashFlow >= 0 ? '+' : ''}{fmtMoney(tr.netCashFlow, tr.currency)}
                                      </span>
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
        </div>
      )}

      {/* CLOSED STOCK POSITIONS & REALIZED HISTORY */}
      {closedPositions.length > 0 && (
        <div className="bg-[#0b1320] border border-[#1c2838] rounded-xl p-5 space-y-4">
          <button
            onClick={() => setShowClosedStocks((v) => !v)}
            className="w-full flex items-center justify-between text-left"
          >
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300">
                <Archive className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white font-sans">
                  Closed Stock Positions &amp; Realized Campaigns ({closedPositions.length})
                </h3>
                <p className="text-xs text-slate-400 font-mono">
                  Fully exited equities ({closedPositions.map((c) => c.ticker).join(', ')}) with realized gains, dividends, and wheel options.
                </p>
              </div>
            </div>
            <div className={`w-7 h-7 rounded-full bg-[#132236] flex items-center justify-center text-slate-300 transition-transform ${showClosedStocks ? 'rotate-180' : ''}`}>
              <ChevronDown className="w-4 h-4" />
            </div>
          </button>

          {showClosedStocks && (
            <div className="space-y-3 pt-2">
              {closedPositions.map((cp) => renderPositionCard(cp, true))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
