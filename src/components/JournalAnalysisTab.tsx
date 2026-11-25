import React, { useState, useEffect } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  Tooltip,
  ReferenceLine,
  Cell,
} from 'recharts';
import { JournalAnalysisResult } from '../utils/journalEngine';
import { JournalDerivedTrade, JournalPostMortemReview } from '../types';
import { runJournalPostMortem } from '../services/optionsService';
import { Lock, Sparkles, RefreshCw } from 'lucide-react';

interface JournalAnalysisTabProps {
  analysis: JournalAnalysisResult;
  closedTrades: JournalDerivedTrade[];
  baseCurrency: 'EUR' | 'USD';
  onJumpToClosedTrades: () => void;
}

export const JournalAnalysisTab: React.FC<JournalAnalysisTabProps> = ({
  analysis,
  closedTrades,
  baseCurrency,
  onJumpToClosedTrades,
}) => {
  const [hoveredDot, setHoveredDot] = useState<JournalAnalysisResult['rDotStrip'][0] | null>(null);
  const [postMortem, setPostMortem] = useState<JournalPostMortemReview | null>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_journal_postmortem_v1');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore storage errors
    }
    return null;
  });
  const [isRunningReview, setIsRunningReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!postMortem) return;
    try {
      localStorage.setItem('ais_portfolio_journal_postmortem_v1', JSON.stringify(postMortem));
    } catch {
      // ignore quota errors
    }
  }, [postMortem]);

  const handleRunPostMortem = async () => {
    if (closedTrades.length === 0) return;
    setIsRunningReview(true);
    setReviewError(null);
    try {
      const review = await runJournalPostMortem(closedTrades);
      setPostMortem(review);
    } catch (err: any) {
      setReviewError(err?.message || 'Failed to generate AI Edge Review.');
    } finally {
      setIsRunningReview(false);
    }
  };

  const sym = baseCurrency === 'EUR' ? '€' : '$';

  const fmtR = (val: number) => `${val > 0 ? '+' : ''}${val.toFixed(2)}R`;
  const fmtMoney = (val: number) => {
    const abs = Math.abs(val);
    const sign = val > 0 ? '+' : val < 0 ? '-' : '';
    return `${sign}${sym}${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  if (analysis.closedCount === 0) {
    return (
      <div className="py-12 text-center space-y-2 border-t border-[#182638]">
        <p className="text-sm font-semibold text-slate-200">No closed trades available for analysis yet</p>
        <p className="text-xs font-mono text-slate-400 max-w-md mx-auto">
          Closed stock and option trades from your IBKR ledger will populate R-distribution, expectancy, gap slippage, and holding-period charts here automatically.
        </p>
      </div>
    );
  }

  // R-Dot Strip geometry (-1R to +10R)
  const rTicks = [-1, 0, 1, 2, 3, 5, 8, 10];
  const rToPct = (r: number) => ((Math.max(-1, Math.min(10, r)) + 1) / 11) * 100;

  return (
    <div className="space-y-6 pt-2">
      {/* Statistical threshold & completeness notice (inline quiet text, no popups/alerts) */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-mono text-slate-400 border-b border-[#182638] pb-3">
        <div>
          {analysis.statisticallyMeaningful ? (
            <span className="text-emerald-400">
              {analysis.closedCount} closed trades analyzed · Statistically meaningful sample (&ge;30)
            </span>
          ) : (
            <span>
              Sample size: <strong className="text-slate-200">{analysis.closedCount} / 30</strong> closed trades · Results are not yet statistically meaningful below 30 trades
            </span>
          )}
        </div>
        {analysis.missingLogCount > 0 && (
          <button
            onClick={onJumpToClosedTrades}
            className="text-amber-300 hover:text-amber-200 underline underline-offset-2 transition-colors whitespace-nowrap"
          >
            {analysis.missingLogCount} closed trade{analysis.missingLogCount === 1 ? '' : 's'} missing exit reason or lesson — log in Positions
          </button>
        )}
      </div>

      {/* 1. HEADLINE STATS (clean single-elevation row) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 border-b border-[#182638] pb-5">
        <div>
          <div className="text-[11px] font-mono text-slate-400">Expectancy (R)</div>
          <div
            className={`text-2xl font-bold font-mono tabular-nums mt-0.5 ${
              analysis.expectancyR >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {fmtR(analysis.expectancyR)}
          </div>
          <div className="text-[11px] font-mono text-slate-500 tabular-nums mt-0.5">
            Total: {fmtR(analysis.totalR)} ({fmtMoney(analysis.totalPnlBase)})
          </div>
        </div>

        <div>
          <div className="text-[11px] font-mono text-slate-400">Win Rate</div>
          <div className="text-2xl font-bold font-mono text-white tabular-nums mt-0.5">
            {analysis.winRatePct.toFixed(1)}%
          </div>
          <div className="text-[11px] font-mono text-slate-500 tabular-nums mt-0.5">
            Across {analysis.closedCount} closed trades
          </div>
        </div>

        <div>
          <div className="text-[11px] font-mono text-slate-400">Avg Win (R)</div>
          <div className="text-2xl font-bold font-mono text-emerald-400 tabular-nums mt-0.5">
            {fmtR(analysis.avgWinR)}
          </div>
          <div className="text-[11px] font-mono text-slate-500 tabular-nums mt-0.5">
            Payoff Ratio: {analysis.payoffRatio.toFixed(2)}x
          </div>
        </div>

        <div>
          <div className="text-[11px] font-mono text-slate-400">Avg Loss (R)</div>
          <div className="text-2xl font-bold font-mono text-rose-400 tabular-nums mt-0.5">
            {fmtR(analysis.avgLossR)}
          </div>
          <div className="text-[11px] font-mono text-slate-500 tabular-nums mt-0.5">
            Planned cap: -1.00R
          </div>
        </div>
      </div>

      {/* 2. R-DOT STRIP (-1R to +10R) */}
      <div className="space-y-3 border-b border-[#182638] pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-white">R-Multiple Distribution Strip (-1R to +10R)</h4>
            <p className="text-xs font-mono text-slate-400 mt-0.5">
              Each dot is one closed trade. Positive edge shows tight losses clustered near -1R and a right tail of multi-R winners.
            </p>
          </div>
          {hoveredDot && (
            <div className="text-xs font-mono text-slate-200 tabular-nums">
              <strong className="text-white">{hoveredDot.ticker}</strong> ({hoveredDot.instrument === 'STOCK' ? 'Stock' : 'Option'}) ·{' '}
              <span className={hoveredDot.r >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {fmtR(hoveredDot.r)}
              </span>{' '}
              · {fmtMoney(hoveredDot.pnlBase)}
              {hoveredDot.exitReason ? ` · ${hoveredDot.exitReason}` : ''}
              {hoveredDot.lesson ? ` · "${hoveredDot.lesson}"` : ''}
            </div>
          )}
        </div>

        <div className="relative bg-[#09101a] border border-[#182638] rounded-lg px-5 py-6">
          {/* Axis line & ticks */}
          <div className="relative h-24">
            {/* Horizontal spine */}
            <div className="absolute left-0 right-0 top-1/2 h-px bg-[#243449]" />

            {/* Reference vertical ticks */}
            {rTicks.map((tick) => {
              const leftPct = rToPct(tick);
              const isZero = tick === 0;
              const isStop = tick === -1;
              return (
                <div
                  key={tick}
                  style={{ left: `${leftPct}%` }}
                  className="absolute top-0 bottom-0 -translate-x-1/2 flex flex-col items-center pointer-events-none"
                >
                  <div
                    className={`w-px flex-1 ${
                      isZero
                        ? 'bg-slate-400/60'
                        : isStop
                        ? 'bg-rose-500/40'
                        : 'bg-[#1a293c]'
                    }`}
                  />
                  <span
                    className={`text-[10px] font-mono mt-1.5 tabular-nums ${
                      isZero ? 'text-slate-200 font-bold' : isStop ? 'text-rose-400' : 'text-slate-500'
                    }`}
                  >
                    {tick > 0 ? `+${tick}R` : `${tick}R`}
                  </span>
                </div>
              );
            })}

            {/* Dots */}
            {analysis.rDotStrip.map((dot) => {
              const leftPct = rToPct(dot.clampedR);
              const topPx = 14 + dot.lane * 14;
              const dotColor =
                dot.r < -1
                  ? 'bg-rose-500 ring-2 ring-rose-400/40'
                  : dot.r < 0
                  ? 'bg-rose-400'
                  : dot.r >= 3
                  ? 'bg-emerald-300 ring-2 ring-emerald-400/40'
                  : 'bg-emerald-400';

              return (
                <button
                  key={dot.id}
                  type="button"
                  onMouseEnter={() => setHoveredDot(dot)}
                  onFocus={() => setHoveredDot(dot)}
                  style={{ left: `${leftPct}%`, top: `${topPx}px` }}
                  title={`${dot.ticker}: ${fmtR(dot.r)} (${fmtMoney(dot.pnlBase)})`}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full transition-transform hover:scale-150 focus:scale-150 focus:outline-none ${dotColor}`}
                  aria-label={`${dot.ticker} ${fmtR(dot.r)}`}
                />
              );
            })}
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 mt-2">
            <span>Left-edge ring = gap loss beyond -1R</span>
            <span>Hover or focus any dot for trade details</span>
          </div>
        </div>
      </div>

      {/* 3. EQUITY CURVE IN R + EXPECTANCY BY INSTRUMENT */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 border-b border-[#182638] pb-6">
        <div className="lg:col-span-2 space-y-2">
          <div>
            <h4 className="text-sm font-semibold text-white">Cumulative Equity Curve (R)</h4>
            <p className="text-xs font-mono text-slate-400">
              Sequential cumulative R across closed trades in chronological exit order.
            </p>
          </div>
          <div className="h-56 w-full bg-[#09101a] border border-[#182638] rounded-lg p-3">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analysis.equityCurve} margin={{ top: 10, right: 32, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="date"
                  padding={{ left: 8, right: 18 }}
                  stroke="#475569"
                  tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}
                />
                <YAxis
                  stroke="#475569"
                  tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}
                  tickFormatter={(v) => `${v}R`}
                />
                <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-[#091019] border border-[#1e2f44] rounded-lg p-2.5 text-xs font-mono shadow-xl space-y-1">
                        <div className="text-white font-bold">
                          #{d.index} {d.ticker} · {d.date}
                        </div>
                        <div className={d.tradeR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          Trade: {fmtR(d.tradeR)} ({fmtMoney(d.pnlBase)})
                        </div>
                        <div className="text-cyan-300">Cumulative: {fmtR(d.cumulativeR)}</div>
                      </div>
                    );
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cumulativeR"
                  stroke="#10B981"
                  strokeWidth={2}
                  fill="#10B981"
                  fillOpacity={0.14}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <h4 className="text-sm font-semibold text-white">Expectancy by Instrument</h4>
            <p className="text-xs font-mono text-slate-400">Stock vs. Option average R per trade.</p>
          </div>
          <div className="h-56 w-full bg-[#09101a] border border-[#182638] rounded-lg p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analysis.expectancyByInstrument} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="instrument"
                  stroke="#475569"
                  tick={{ fill: '#cbd5e1', fontSize: 11, fontFamily: 'monospace' }}
                />
                <YAxis
                  stroke="#475569"
                  tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}
                  tickFormatter={(v) => `${v}R`}
                />
                <ReferenceLine y={0} stroke="#475569" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-[#091019] border border-[#1e2f44] rounded-lg p-2.5 text-xs font-mono shadow-xl space-y-0.5">
                        <div className="text-white font-bold">{d.instrument} ({d.count} trades)</div>
                        <div className={d.expectancyR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          Expectancy: {fmtR(d.expectancyR)}
                        </div>
                        <div className="text-slate-300">Win Rate: {d.winRatePct}%</div>
                        <div className="text-slate-400">Total: {fmtR(d.totalR)}</div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="expectancyR" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {analysis.expectancyByInstrument.map((entry) => (
                    <Cell
                      key={entry.instrument}
                      fill={entry.expectancyR >= 0 ? '#10B981' : '#F43F5E'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* 4. EXPECTANCY BY CATALYST TYPE + PLANNED VS ACTUAL LOSS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 border-b border-[#182638] pb-6">
        <div className="space-y-2">
          <div>
            <h4 className="text-sm font-semibold text-white">Expectancy by Catalyst Type</h4>
            <p className="text-xs font-mono text-slate-400">Average R per closed trade grouped by catalyst setup.</p>
          </div>
          <div className="h-56 w-full bg-[#09101a] border border-[#182638] rounded-lg p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={analysis.expectancyByCatalyst}
                layout="vertical"
                margin={{ top: 5, right: 24, left: 10, bottom: 5 }}
              >
                <XAxis
                  type="number"
                  stroke="#475569"
                  tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}
                  tickFormatter={(v) => `${v}R`}
                />
                <YAxis
                  type="category"
                  dataKey="catalyst"
                  width={108}
                  stroke="#475569"
                  tick={{ fill: '#cbd5e1', fontSize: 10, fontFamily: 'monospace' }}
                />
                <ReferenceLine x={0} stroke="#475569" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-[#091019] border border-[#1e2f44] rounded-lg p-2.5 text-xs font-mono shadow-xl space-y-0.5">
                        <div className="text-white font-bold">{d.catalyst} (n={d.count})</div>
                        <div className={d.expectancyR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          Expectancy: {fmtR(d.expectancyR)}
                        </div>
                        <div className="text-slate-300">Win Rate: {d.winRatePct}%</div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="expectancyR" radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  {analysis.expectancyByCatalyst.map((entry) => (
                    <Cell
                      key={entry.catalyst}
                      fill={entry.expectancyR >= 0 ? '#06B6D4' : '#F43F5E'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <h4 className="text-sm font-semibold text-white">Planned (-1R) vs. Actual Loss</h4>
            <p className="text-xs font-mono text-slate-400">
              Exposes gap slippage or oversized losses where actual loss fell below -1.00R.
            </p>
          </div>
          {analysis.plannedVsActualLoss.length === 0 ? (
            <div className="h-56 bg-[#09101a] border border-[#182638] rounded-lg flex items-center justify-center text-xs font-mono text-slate-500">
              No losing closed trades recorded yet.
            </div>
          ) : (
            <div className="h-56 w-full bg-[#09101a] border border-[#182638] rounded-lg p-3">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analysis.plannedVsActualLoss} margin={{ top: 10, right: 16, left: 0, bottom: 10 }}>
                  <XAxis
                    dataKey="label"
                    interval={0}
                    angle={-20}
                    textAnchor="end"
                    height={36}
                    stroke="#475569"
                    tick={{ fill: '#94a3b8', fontSize: 9, fontFamily: 'monospace' }}
                  />
                  <YAxis
                    stroke="#475569"
                    tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}
                    tickFormatter={(v) => `${v}R`}
                  />
                  <ReferenceLine y={-1} stroke="#F59E0B" strokeDasharray="3 3" />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      return (
                        <div className="bg-[#091019] border border-[#1e2f44] rounded-lg p-2.5 text-xs font-mono shadow-xl space-y-0.5">
                          <div className="text-white font-bold">{d.label} ({d.exitReason})</div>
                          <div className="text-slate-400">Planned Cap: -1.00R</div>
                          <div className="text-rose-400">Actual Loss: {fmtR(d.actualLossR)}</div>
                          {d.slippageR < 0 && (
                            <div className="text-amber-300">Gap / Oversize Slippage: {fmtR(d.slippageR)}</div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="plannedLossR" name="Planned (-1R)" fill="#334155" radius={[0, 0, 3, 3]} isAnimationActive={false} />
                  <Bar dataKey="actualLossR" name="Actual Loss (R)" radius={[0, 0, 3, 3]} isAnimationActive={false}>
                    {analysis.plannedVsActualLoss.map((entry) => (
                      <Cell
                        key={entry.id}
                        fill={entry.actualLossR < -1.05 ? '#F43F5E' : '#F59E0B'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* 5. HOLDING DAYS VS RESULT (R) + FIELD-CORRELATION VIEW (30+ ONLY) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-2">
          <div>
            <h4 className="text-sm font-semibold text-white">Holding Days vs. Result (R)</h4>
            <p className="text-xs font-mono text-slate-400">
              Reveals whether winners are cut too early or losing positions are held too long.
            </p>
          </div>
          <div className="h-56 w-full bg-[#09101a] border border-[#182638] rounded-lg p-3">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                <XAxis
                  type="number"
                  dataKey="holdingDays"
                  name="Holding Days"
                  unit="d"
                  stroke="#475569"
                  tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}
                />
                <YAxis
                  type="number"
                  dataKey="resultR"
                  name="Result"
                  unit="R"
                  stroke="#475569"
                  tick={{ fill: '#94a3b8', fontSize: 10, fontFamily: 'monospace' }}
                />
                <ZAxis range={[55, 55]} />
                <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-[#091019] border border-[#1e2f44] rounded-lg p-2.5 text-xs font-mono shadow-xl space-y-0.5">
                        <div className="text-white font-bold">
                          {d.ticker} ({d.instrument === 'STOCK' ? 'Stock' : 'Option'})
                        </div>
                        <div className="text-slate-300">Held: {d.holdingDays} days</div>
                        <div className={d.resultR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                          Result: {fmtR(d.resultR)} ({fmtMoney(d.pnlBase)})
                        </div>
                        <div className="text-slate-400">Exit: {d.exitReason}</div>
                      </div>
                    );
                  }}
                />
                <Scatter data={analysis.holdingDaysVsResult} isAnimationActive={false}>
                  {analysis.holdingDaysVsResult.map((pt) => (
                    <Cell
                      key={pt.id}
                      fill={pt.resultR >= 0 ? '#10B981' : '#F43F5E'}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Field-Correlation View (strictly gated at 30+ closed trades) */}
        <div className="space-y-2">
          <div>
            <h4 className="text-sm font-semibold text-white">Field-Correlation View (30+ Trades)</h4>
            <p className="text-xs font-mono text-slate-400">
              Measures which logged journal attributes actually associate with higher R expectancy.
            </p>
          </div>
          {!analysis.statisticallyMeaningful ? (
            <div className="h-56 bg-[#09101a] border border-[#182638] rounded-lg p-6 flex flex-col items-center justify-center text-center space-y-2">
              <Lock className="w-5 h-5 text-slate-500" />
              <div className="text-sm font-semibold text-slate-200 font-mono tabular-nums">
                Locked until 30 closed trades ({analysis.closedCount} / 30 logged)
              </div>
              <p className="text-xs font-mono text-slate-400 max-w-sm leading-relaxed">
                Keep logging catalyst type, insider clusters, and setup tags in each expanded row. Field-correlation analysis unlocks automatically once you reach 30 closed trades to prevent small-sample noise.
              </p>
            </div>
          ) : analysis.fieldCorrelations.length === 0 ? (
            <div className="h-56 bg-[#09101a] border border-[#182638] rounded-lg p-6 flex items-center justify-center text-xs font-mono text-slate-400 text-center">
              Tag at least 3 closed trades with setup fields (Insider Cluster, Pre-Catalyst Entry, Asymmetric &gt;3R, Volume Confirmed) to compare expectancy lift.
            </div>
          ) : (
            <div className="h-56 overflow-y-auto bg-[#09101a] border border-[#182638] rounded-lg p-3">
              <table className="w-full text-xs font-mono tabular-nums">
                <thead>
                  <tr className="text-[10px] text-slate-500 border-b border-[#182638]">
                    <th className="text-left pb-2 font-semibold">Logged Field</th>
                    <th className="text-right pb-2 font-semibold">Trades</th>
                    <th className="text-right pb-2 font-semibold">Win %</th>
                    <th className="text-right pb-2 font-semibold">With (R)</th>
                    <th className="text-right pb-2 font-semibold">Lift (&Delta;R)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#131e2d]">
                  {analysis.fieldCorrelations.map((row) => (
                    <tr key={row.field} className="hover:bg-[#0f1927]">
                      <td className="py-2 text-slate-200">{row.field}</td>
                      <td className="py-2 text-right text-slate-400">{row.withCount}</td>
                      <td className="py-2 text-right text-slate-300">{row.withWinRatePct.toFixed(0)}%</td>
                      <td
                        className={`py-2 text-right font-semibold ${
                          row.withExpectancyR >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {fmtR(row.withExpectancyR)}
                      </td>
                      <td
                        className={`py-2 text-right font-bold ${
                          row.liftR >= 0 ? 'text-cyan-300' : 'text-amber-300'
                        }`}
                      >
                        {fmtR(row.liftR)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 6. CROSS-TRADE AI POST-MORTEM REVIEW (On-demand pattern synthesis across closed trades) */}
      <div className="border-t border-[#182638] pt-6 space-y-3">
        <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
              <h4 className="text-sm font-semibold text-white">AI Edge &amp; Mistake Post-Mortem Review</h4>
            </div>
            <p className="text-xs font-mono text-slate-400 mt-0.5">
              Synthesizes your theses, catalysts, exit reasons, holding days, and R-multiples across {analysis.closedCount} closed trade{analysis.closedCount === 1 ? '' : 's'}
              {!analysis.statisticallyMeaningful ? ' (early directional read below 30 trades).' : '.'}
            </p>
          </div>
          <button
            type="button"
            disabled={isRunningReview || closedTrades.length === 0}
            onClick={handleRunPostMortem}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#0d1827] hover:bg-[#132236] border border-[#1f344d] text-xs font-mono text-cyan-300 transition-colors disabled:opacity-50 shrink-0 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRunningReview ? 'animate-spin' : ''}`} />
            <span>
              {isRunningReview
                ? 'Reviewing closed trades...'
                : postMortem
                ? 'Re-run AI Edge Review'
                : 'Run AI Edge Review'}
            </span>
          </button>
        </div>

        {reviewError && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-3.5 py-2.5 text-xs font-mono text-rose-300">
            {reviewError}
          </div>
        )}

        {postMortem ? (
          <div className="bg-[#09101a] border border-[#182638] rounded-lg p-4 space-y-4 font-mono">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[#162334] pb-3">
              <p className="text-xs text-slate-200 leading-relaxed max-w-4xl">
                {postMortem.executiveTakeaway}
              </p>
              <span className="text-[10px] text-slate-500 shrink-0 tabular-nums">
                Based on {postMortem.closedTradeCount} closed trade{postMortem.closedTradeCount === 1 ? '' : 's'} · {postMortem.analyzedAt.slice(0, 16).replace('T', ' ')} UTC
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-emerald-400">Working Edges</div>
                <ul className="space-y-1.5 text-slate-300">
                  {postMortem.workingEdges.length > 0 ? (
                    postMortem.workingEdges.map((item, i) => (
                      <li key={i} className="leading-relaxed text-[11px]">
                        · {item}
                      </li>
                    ))
                  ) : (
                    <li className="text-slate-500 text-[11px]">No clear positive pattern yet.</li>
                  )}
                </ul>
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-rose-400">Recurring Leaks</div>
                <ul className="space-y-1.5 text-slate-300">
                  {postMortem.recurringLeaks.length > 0 ? (
                    postMortem.recurringLeaks.map((item, i) => (
                      <li key={i} className="leading-relaxed text-[11px]">
                        · {item}
                      </li>
                    ))
                  ) : (
                    <li className="text-slate-500 text-[11px]">No recurring leaks flagged.</li>
                  )}
                </ul>
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] font-semibold text-cyan-300">Next-Trade Rules</div>
                <ul className="space-y-1.5 text-slate-300">
                  {postMortem.nextTradeRules.length > 0 ? (
                    postMortem.nextTradeRules.map((item, i) => (
                      <li key={i} className="leading-relaxed text-[11px]">
                        · {item}
                      </li>
                    ))
                  ) : (
                    <li className="text-slate-500 text-[11px]">Log more theses &amp; lessons for sharper rules.</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        ) : !reviewError ? (
          <div className="bg-[#09101a] border border-[#182638] rounded-lg px-4 py-3 text-xs font-mono text-slate-400">
            Click <span className="text-cyan-300">Run AI Edge Review</span> for an on-demand synthesis of your closed-trade theses, exit reasons, holding periods, and recurring leaks. (Does not override the statistical 30-trade Field-Correlation lock above.)
          </div>
        ) : null}
      </div>
    </div>
  );
};
