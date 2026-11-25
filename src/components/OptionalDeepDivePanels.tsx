import React, { useState, useMemo } from 'react';
import {
  Shield,
  Coins,
  Clock,
} from 'lucide-react';
import {
  StockPosition,
  StandaloneOptionPosition,
  Transaction,
  StockQuote,
  PositionMark,
  OptionalPanelsState,
  UnifiedTickerSummary,
  JournalTradeOverride,
  JournalSettings,
} from '../types';
import {
  computeStepDownData,
  computeMonthlyCashflows,
  computeActiveOptions,
  StepDownPoint,
} from '../utils/analyticsEngine';
import { FilteredJournalPanel } from './FilteredJournalPanel';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts';

interface OptionalDeepDivePanelsProps {
  panels: OptionalPanelsState;
  positions: StockPosition[];
  closedPositions?: StockPosition[];
  standalonePositions: StandaloneOptionPosition[];
  unifiedTickers: UnifiedTickerSummary[];
  transactions: Transaction[];
  quotes: Record<string, StockQuote>;
  quotesFetchedAt?: string;
  fxRates: Record<string, number>;
  positionMarks: Record<string, PositionMark>;
  baseCurrency: 'EUR' | 'USD';
  netLiqValueBase: number;
  onRefreshQuotes: () => Promise<void> | void;
  journalOverrides: Record<string, JournalTradeOverride>;
  onChangeJournalOverrides: React.Dispatch<React.SetStateAction<Record<string, JournalTradeOverride>>>;
  journalSettings: JournalSettings;
  onChangeJournalSettings: React.Dispatch<React.SetStateAction<JournalSettings>>;
  focusClosedTradeId?: string | null;
  onClearFocusTrade?: () => void;
}

export const OptionalDeepDivePanels: React.FC<OptionalDeepDivePanelsProps> = ({
  panels,
  positions,
  closedPositions = [],
  standalonePositions,
  unifiedTickers,
  transactions,
  quotes,
  quotesFetchedAt,
  fxRates,
  positionMarks,
  baseCurrency,
  netLiqValueBase,
  onRefreshQuotes,
  journalOverrides,
  onChangeJournalOverrides,
  journalSettings,
  onChangeJournalSettings,
  focusClosedTradeId,
  onClearFocusTrade,
}) => {
  const availableTickers = useMemo(() => positions.map((p) => p.ticker), [positions]);
  const [selectedTicker, setSelectedTicker] = useState<string>(availableTickers[0] || '');

  const selectedPosition = useMemo(() => {
    return positions.find((p) => p.ticker === selectedTicker) || positions[0];
  }, [positions, selectedTicker]);

  const stepDownData = useMemo(() => {
    if (!panels.stepDown || !selectedPosition) return [];
    return computeStepDownData(selectedPosition, quotes);
  }, [panels.stepDown, selectedPosition, quotes]);

  const monthlyCashflow = useMemo(() => {
    if (!panels.monthlyCashflow) {
      return { monthlyRecords: [], averageMonthlyInflow: 0, totalCashflow: 0, topMonthLabel: 'N/A', topMonthAmount: 0 };
    }
    return computeMonthlyCashflows(transactions, baseCurrency, fxRates);
  }, [panels.monthlyCashflow, transactions, baseCurrency, fxRates]);

  const activeOptions = useMemo(() => {
    if (!panels.expiryMatrix) return [];
    return computeActiveOptions(positions, standalonePositions, quotes, positionMarks, baseCurrency, fxRates, closedPositions);
  }, [panels.expiryMatrix, positions, closedPositions, standalonePositions, quotes, positionMarks, baseCurrency, fxRates]);

  if (!panels.stepDown && !panels.monthlyCashflow && !panels.expiryMatrix && !panels.filteredJournal) {
    return null;
  }

  const currencySymbol = baseCurrency === 'EUR' ? '€' : '$';
  const fmtMoney = (val: number, cur?: string) => {
    const s = cur ? (cur === 'EUR' ? '€' : '$') : currencySymbol;
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    return `${sign}${s}${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* 1. BASIS STEP-DOWN CHART */}
      {panels.stepDown && selectedPosition && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#182638] pb-3">
            <div>
              <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                <Shield className="w-5 h-5 text-emerald-400" />
                Chronological Real Entry Price Step-Down
              </h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                How covered calls, CSPs, and net dividends step down cost basis over time.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
              {availableTickers.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedTicker(t)}
                  className={`px-3 py-1 rounded-md border transition-all font-bold ${
                    selectedPosition.ticker === t
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                      : 'bg-[#091019] border-[#182638] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {(() => {
            const pSym = selectedPosition.currency === 'EUR' ? '€' : '$';
            const fmtSh = (v: number) => (v > 0 && v < 2 ? v.toFixed(3) : v.toFixed(2));
            return (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={stepDownData} margin={{ top: 10, right: 36, left: 0, bottom: 5 }}>
                    <XAxis
                      dataKey="date"
                      padding={{ left: 10, right: 16 }}
                      stroke="#475569"
                      tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }}
                    />
                    <YAxis
                      stroke="#475569"
                      tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }}
                      tickFormatter={(v) => `${pSym}${v}`}
                      domain={['auto', 'auto']}
                    />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (!active || !payload || !payload.length) return null;
                        const data: StepDownPoint = payload[0].payload;
                        return (
                          <div className="bg-[#091019] border border-[#1e2f44] rounded-lg p-3 text-xs font-mono shadow-xl space-y-1 max-w-sm">
                            <div className="flex items-center justify-between border-b border-[#182638] pb-1">
                              <span className="font-bold text-white">{data.date}</span>
                              <span className="text-[10px] px-1.5 rounded bg-slate-800 text-slate-300">{data.impactType}</span>
                            </div>
                            <p className="text-[11px] text-emerald-300 font-semibold pt-1">{data.eventDesc}</p>
                            <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-slate-400">
                              <div>Raw Avg: <span className="text-slate-200 font-bold">{pSym}{fmtSh(data.rawAvgCost)}</span></div>
                              <div>Real Entry: <span className="text-emerald-400 font-bold">{pSym}{fmtSh(data.realEntryPrice)}</span></div>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Line type="monotone" dataKey="spotPrice" stroke="#94a3b8" strokeWidth={1.5} dot={{ r: 2.5, fill: '#94a3b8' }} name="Spot" isAnimationActive={false} />
                    <Line type="stepAfter" dataKey="rawAvgCost" stroke="#06b6d4" strokeWidth={2} strokeDasharray="4 4" dot={false} name="Raw Avg" isAnimationActive={false} />
                    <Line type="stepAfter" dataKey="realEntryPrice" stroke="#10b981" strokeWidth={3} dot={{ r: 3.5, fill: '#10b981' }} name="Real Entry" isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })()}
        </div>
      )}

      {/* 2. MONTHLY CASHFLOW CHART */}
      {panels.monthlyCashflow && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#182638] pb-3">
            <div>
              <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                <Coins className="w-5 h-5 text-cyan-400" />
                Monthly Cashflow &amp; Income Harvest
              </h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Stacked monthly breakdown of Net Dividends, Linked Wheel Premiums, and Standalone Options P&amp;L.
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs font-mono">
              <div className="bg-[#091019] border border-[#172538] px-3 py-1 rounded-lg">
                <span className="text-[10px] text-slate-500 uppercase block">Total Cashflow</span>
                <span className="font-bold text-emerald-400">{fmtMoney(monthlyCashflow.totalCashflow)}</span>
              </div>
              <div className="bg-[#091019] border border-[#172538] px-3 py-1 rounded-lg">
                <span className="text-[10px] text-slate-500 uppercase block">Monthly Avg</span>
                <span className="font-bold text-cyan-400">{fmtMoney(monthlyCashflow.averageMonthlyInflow)}/mo</span>
              </div>
            </div>
          </div>

          <div className="h-60 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyCashflow.monthlyRecords} stackOffset="sign" margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                <XAxis dataKey="label" stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }} />
                <YAxis stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }} tickFormatter={(v) => `${currencySymbol}${v}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#090f17', borderColor: '#1e293b', borderRadius: '8px', fontFamily: 'monospace', fontSize: '12px' }}
                />
                <ReferenceLine y={0} stroke="#334155" />
                <Bar dataKey="netDividends" stackId="a" fill="#06b6d4" name="Net Dividends" isAnimationActive={false} />
                <Bar dataKey="linkedPremiums" stackId="a" fill="#10b981" name="Linked Option Premiums" isAnimationActive={false} />
                <Bar dataKey="standalonePnl" stackId="a" fill="#a855f7" name="Standalone Options P&L" radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* 3. OPEN EXPIRY & THETA MATRIX */}
      {panels.expiryMatrix && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#182638] pb-3">
            <div>
              <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                <Clock className="w-5 h-5 text-purple-400" />
                Open Expiry &amp; Theta Matrix
              </h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                DTE countdown, strike OTM/ITM cushion, unrealized P&amp;L, and daily theta velocity across all open option contracts.
              </p>
            </div>
            <div className="text-xs font-mono text-slate-300">
              Extrinsic Remaining:{' '}
              <span className="text-emerald-400 font-bold">
                {fmtMoney(activeOptions.reduce((s, o) => s + o.extrinsicRemaining, 0))}
              </span>
            </div>
          </div>

          {activeOptions.length === 0 ? (
            <div className="py-6 text-center text-xs font-mono text-slate-500">
              No active option contracts currently open.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-[#182638] text-slate-400 text-[10px] uppercase tracking-wider">
                    <th className="pb-2">Underlying &amp; Contract</th>
                    <th className="pb-2">Side &amp; Bucket</th>
                    <th className="pb-2">Strike vs Spot</th>
                    <th className="pb-2">DTE (Expiry)</th>
                    <th className="pb-2 text-center">Strike Cushion</th>
                    <th className="pb-2 text-right">Unrealized P&amp;L</th>
                    <th className="pb-2 text-right">Extrinsic / Theta</th>
                    <th className="pb-2 text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#131f2f]">
                  {activeOptions.map((opt) => {
                    const optSym = opt.currency === 'EUR' ? '€' : '$';
                    return (
                      <tr key={opt.id} className="hover:bg-[#0a121c] transition-colors">
                        <td className="py-2.5 font-bold text-white">
                          <div className="flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700 text-[10px]">
                              {opt.underlying}
                            </span>
                            <span className="text-slate-300 truncate max-w-[190px]">{opt.contractSymbol}</span>
                          </div>
                        </td>
                        <td className="py-2.5">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              opt.action === 'SHORT'
                                ? 'bg-emerald-500/10 text-emerald-300'
                                : 'bg-purple-500/10 text-purple-300'
                            }`}
                          >
                            {opt.contracts}x {opt.action} {opt.type}
                          </span>
                          <span className="text-[10px] text-slate-500 block mt-0.5">
                            {opt.bucket === 'LINKED' ? '[🔗 Linked]' : '[⚡ Standalone]'}
                          </span>
                        </td>
                        <td className="py-2.5 text-slate-300">
                          <span className="font-bold text-white">{optSym}{opt.strike.toFixed(2)}</span>
                          <span className="text-[10px] text-slate-500 block">Spot: {optSym}{opt.spotPrice.toFixed(2)}</span>
                        </td>
                        <td className="py-2.5">
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                            {opt.dte} DTE
                          </span>
                          <span className="text-[10px] text-slate-500 ml-1.5">{opt.expiry}</span>
                        </td>
                        <td className="py-2.5 text-center">
                          <span className={`font-bold ${opt.strikeCushionPct >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {opt.action === 'SHORT'
                              ? opt.strikeCushionPct >= 0
                                ? `+${opt.strikeCushionPct}% OTM`
                                : `${opt.strikeCushionPct}% ITM`
                              : opt.strikeCushionPct >= 0
                              ? `+${opt.strikeCushionPct}% ITM`
                              : `${opt.strikeCushionPct}% OTM`}
                          </span>
                        </td>
                        <td className="py-2.5 text-right font-bold">
                          <span className={opt.unrealizedPnlBase >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {opt.unrealizedPnlBase >= 0 ? '+' : ''}
                            {fmtMoney(opt.unrealizedPnlBase)}
                          </span>
                          <span className="text-[10px] text-slate-500 block font-normal">
                            {opt.profitCapturedPct >= 0 ? '+' : ''}
                            {opt.profitCapturedPct}% mark
                          </span>
                        </td>
                        <td className="py-2.5 text-right text-slate-200">
                          <div>{fmtMoney(opt.extrinsicRemaining)}</div>
                          <div className="text-[10px] text-slate-500">+{currencySymbol}{opt.thetaPerDay.toFixed(2)}/d</div>
                        </td>
                        <td className="py-2.5 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                              opt.statusTag === 'TESTED'
                                ? 'bg-rose-500/15 border-rose-500/40 text-rose-300'
                                : opt.statusTag === 'ROLL_CANDIDATE'
                                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                : opt.statusTag === 'SWEET_SPOT'
                                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                                : 'bg-slate-800 border-slate-700 text-slate-300'
                            }`}
                          >
                            {opt.statusLabel}
                          </span>
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

      {/* 4. FILTERED JOURNAL DEEP-DIVE PANEL */}
      {panels.filteredJournal && (
        <FilteredJournalPanel
          unifiedTickers={unifiedTickers}
          quotes={quotes}
          quotesFetchedAt={quotesFetchedAt}
          positionMarks={positionMarks}
          fxRates={fxRates}
          baseCurrency={baseCurrency}
          netLiqValueBase={netLiqValueBase}
          onRefreshQuotes={onRefreshQuotes}
          overrides={journalOverrides}
          onChangeOverrides={onChangeJournalOverrides}
          settings={journalSettings}
          onChangeSettings={onChangeJournalSettings}
          focusClosedTradeId={focusClosedTradeId}
          onClearFocusTrade={onClearFocusTrade}
        />
      )}
    </div>
  );
};
