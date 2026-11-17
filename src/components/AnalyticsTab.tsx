import React, { useState, useMemo } from 'react';
import {
  Shield,
  TrendingUp,
  Percent,
  Calendar,
  Layers,
  DollarSign,
  Clock,
  Coins,
  ArrowRight,
  Sparkles,
  Zap,
  Globe,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  ArrowUpRight,
  Flame,
  Activity,
  Target,
} from 'lucide-react';
import {
  StockPosition,
  StandaloneOptionPosition,
  PortfolioSummary,
  ViewVisibilityState,
  Transaction,
  StockQuote,
  PositionMark,
} from '../types';
import {
  computeStepDownData,
  computeMonthlyCashflows,
  computeActiveOptions,
  computeCapitalAllocation,
  computeAdvancedKPIs,
  StepDownPoint,
} from '../utils/analyticsEngine';
import { getFxMultiplier } from '../utils/portfolioEngine';
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
  AreaChart,
  Area,
} from 'recharts';

interface AnalyticsTabProps {
  summary: PortfolioSummary;
  positions: StockPosition[];
  standalonePositions?: StandaloneOptionPosition[];
  transactions?: Transaction[];
  quotes?: Record<string, StockQuote>;
  fxRates?: Record<string, number>;
  positionMarks?: Record<string, PositionMark>;
  endingCashBase?: number;
  netDepositsBase?: number;
  baseCurrency: 'EUR' | 'USD';
  visibility: ViewVisibilityState;
}

export const AnalyticsTab: React.FC<AnalyticsTabProps> = ({
  summary,
  positions,
  standalonePositions = [],
  transactions = [],
  quotes = {},
  fxRates = {},
  positionMarks = {},
  endingCashBase,
  netDepositsBase,
  baseCurrency,
  visibility,
}) => {
  // Selected ticker for Chronological Step-Down chart
  const availableTickers = useMemo(() => {
    return positions.map((p) => p.ticker);
  }, [positions]);

  const [selectedTicker, setSelectedTicker] = useState<string>(
    availableTickers[0] || ''
  );

  const selectedPosition = useMemo(() => {
    return positions.find((p) => p.ticker === selectedTicker) || positions[0];
  }, [positions, selectedTicker]);

  // Step-down line data for selected ticker
  const stepDownData = useMemo(() => {
    if (!selectedPosition) return [];
    return computeStepDownData(selectedPosition, quotes);
  }, [selectedPosition, quotes]);

  // Monthly cash flows in baseCurrency
  const {
    monthlyRecords,
    averageMonthlyInflow,
    totalCashflow,
    topMonthLabel,
    topMonthAmount,
  } = useMemo(() => {
    return computeMonthlyCashflows(transactions, baseCurrency, fxRates);
  }, [transactions, baseCurrency, fxRates]);

  // Active open options metrics
  const activeOptions = useMemo(() => {
    return computeActiveOptions(positions, standalonePositions, quotes, positionMarks, baseCurrency, fxRates);
  }, [positions, standalonePositions, quotes, positionMarks, baseCurrency, fxRates]);

  // Capital allocation
  const allocation = useMemo(() => {
    return computeCapitalAllocation(positions, standalonePositions, transactions, baseCurrency, fxRates, endingCashBase);
  }, [positions, standalonePositions, transactions, baseCurrency, fxRates, endingCashBase]);

  // Advanced KPIs (XIRR, RoM, APR, Theta)
  const advancedKPIs = useMemo(() => {
    return computeAdvancedKPIs(
      transactions,
      summary.totalMarketValue,
      summary.totalRawCostBasis,
      activeOptions,
      baseCurrency,
      fxRates
    );
  }, [transactions, summary.totalMarketValue, summary.totalRawCostBasis, activeOptions, baseCurrency, fxRates]);

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

  // Portfolio cumulative net cash deployed vs current portfolio value (converted to baseCurrency)
  const portfolioDepositData = useMemo(() => {
    let runningNetInvested = 0;
    const sorted = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const monthlyMap = new Map<string, number>();

    sorted.forEach((t) => {
      const m = t.date.slice(0, 7);
      if (!m || m.length !== 7) return;
      const fx = getFxMultiplier(t.currency, baseCurrency, fxRates, t.fxRateToBase);
      // Outflows increase net capital deployed; inflows reduce it
      runningNetInvested += -t.netCashFlow * fx;
      monthlyMap.set(m, Math.max(0, runningNetInvested));
    });

    const netLiqNow = summary.totalMarketValue + (endingCashBase ?? 0);
    const arr: Array<{ month: string; deposits: number; portfolioValue: number }> = [];
    const keys = Array.from(monthlyMap.keys()).sort();
    keys.forEach((m, idx) => {
      const ratio = keys.length > 1 ? idx / (keys.length - 1) : 1;
      const dep =
        netDepositsBase !== undefined && netDepositsBase > 0
          ? netDepositsBase
          : monthlyMap.get(m) || 0;
      const terminalRatio = dep > 0 ? netLiqNow / dep : 1;
      const interpolatedVal = idx === keys.length - 1 ? netLiqNow : dep * (1 + (terminalRatio - 1) * ratio);
      arr.push({
        month: m,
        deposits: Math.round(dep),
        portfolioValue: Math.round(interpolatedVal),
      });
    });

    if (arr.length > 0) {
      arr[arr.length - 1].portfolioValue = Math.round(netLiqNow);
      if (netDepositsBase !== undefined && netDepositsBase > 0) {
        arr[arr.length - 1].deposits = Math.round(netDepositsBase);
      }
    }
    return arr;
  }, [transactions, summary.totalMarketValue, endingCashBase, netDepositsBase, baseCurrency, fxRates]);

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* ------------------------------------------------------------- */}
      {/* ADVANCED QUANTITATIVE KPIS GRID */}
      {/* ------------------------------------------------------------- */}
      {(visibility.kpi_xirr || visibility.kpi_rom || visibility.kpi_apr || visibility.kpi_theta) && (
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {/* 1. XIRR */}
          {visibility.kpi_xirr && (
            <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-emerald-500/40 transition-colors shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  Portfolio XIRR
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                  Annualized
                </span>
              </div>
              <div className={`text-2xl font-bold font-mono tracking-tight ${advancedKPIs.xirrPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {advancedKPIs.xirrPct > 0 ? `+${advancedKPIs.xirrPct.toFixed(1)}%` : `${advancedKPIs.xirrPct.toFixed(1)}%`}
              </div>
              <div className="mt-2 pt-2 border-t border-[#162334] flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>Money-Weighted Return</span>
                <span className="text-emerald-300 font-semibold">Net of Cash Flows</span>
              </div>
            </div>
          )}

          {/* 2. Return on Margin (RoM) */}
          {visibility.kpi_rom && (
            <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-cyan-500/40 transition-colors shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5 text-cyan-400" />
                  Return on Margin (RoM)
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
                  Collateral
                </span>
              </div>
              <div className="text-2xl font-bold font-mono text-cyan-400 tracking-tight">
                +{advancedKPIs.returnOnMarginPct.toFixed(1)}%
              </div>
              <div className="mt-2 pt-2 border-t border-[#162334] flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>Annualized Premium Velocity</span>
                <span className="text-cyan-300 font-semibold">On Required Basis</span>
              </div>
            </div>
          )}

          {/* 3. Annualized APR % */}
          {visibility.kpi_apr && (
            <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-purple-500/40 transition-colors shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold flex items-center gap-1.5">
                  <TrendingUp className="w-3.5 h-3.5 text-purple-400" />
                  Active Options APR
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-purple-500/10 text-purple-300 border border-purple-500/30">
                  Run Rate
                </span>
              </div>
              <div className="text-2xl font-bold font-mono text-purple-300 tracking-tight">
                {advancedKPIs.annualizedAprPct.toFixed(1)}%
              </div>
              <div className="mt-2 pt-2 border-t border-[#162334] flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>Covered Calls &amp; CSPs</span>
                <span className="text-purple-400 font-semibold">{activeOptions.length} Open Legs</span>
              </div>
            </div>
          )}

          {/* 4. Theta Decay ($/day) */}
          {visibility.kpi_theta && (
            <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-amber-500/40 transition-colors shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold flex items-center gap-1.5">
                  <Flame className="w-3.5 h-3.5 text-amber-400" />
                  Theta Decay Velocity
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">
                  Time Decay
                </span>
              </div>
              <div className="text-2xl font-bold font-mono text-amber-300 tracking-tight">
                +{currencySymbol}{advancedKPIs.dailyThetaDollars}/day
              </div>
              <div className="mt-2 pt-2 border-t border-[#162334] flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>Extrinsic Burn Inflow</span>
                <span className="text-amber-400 font-semibold">24h Decay Rate</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 1. CHRONOLOGICAL REAL ENTRY PRICE STEP-DOWN CHART */}
      {/* ------------------------------------------------------------- */}
      {visibility.analytics_step_down && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#182638] pb-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                  <Shield className="w-5 h-5 text-emerald-400" />
                  Chronological Real Entry Price Step-Down
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 font-semibold">
                  TWO-BUCKET ENGINE
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Tracking how covered call rolls, cash-secured put credits, and net dividends permanently reduce cost basis over time.
              </p>
            </div>

            {/* Ticker Selector Pills */}
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-mono">
              <span className="text-slate-500 text-[11px] mr-1 hidden sm:inline">Ticker:</span>
              {availableTickers.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelectedTicker(t)}
                  className={`px-3 py-1 rounded-md border transition-all font-bold ${
                    selectedPosition?.ticker === t
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 shadow-sm shadow-emerald-500/10'
                      : 'bg-[#091019] border-[#182638] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Selected Ticker Key Metrics Bar */}
          {selectedPosition && (() => {
            const pSym = selectedPosition.currency === 'EUR' ? '€' : '$';
            const fmtSh = (v: number) => (v > 0 && v < 2 ? v.toFixed(3) : v.toFixed(2));
            const spotVsRawPct = selectedPosition.rawAvgEntry > 0
              ? ((selectedPosition.spotPrice - selectedPosition.rawAvgEntry) / selectedPosition.rawAvgEntry) * 100
              : 0;
            const spotVsRealPct = selectedPosition.realEntryPrice > 0
              ? ((selectedPosition.spotPrice - selectedPosition.realEntryPrice) / selectedPosition.realEntryPrice) * 100
              : 100;
            return (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 bg-[#080d14] border border-[#162436] rounded-xl p-3 text-xs font-mono">
                  <div>
                    <span className="text-[10px] text-slate-500 uppercase block">Current Spot</span>
                    <span className="text-sm font-bold text-cyan-300">{pSym}{fmtSh(selectedPosition.spotPrice)}</span>
                    <span className="text-[10px] text-slate-400 block">
                      Val: {fmtMoney(selectedPosition.marketValue, selectedPosition.currency)}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase block">Avg Cost</span>
                    <span className="text-sm font-bold text-slate-300">
                      {pSym}{fmtSh(selectedPosition.rawAvgEntry)}
                    </span>
                    <span className="text-[10px] text-slate-500 block">{selectedPosition.currentShares} shs</span>
                  </div>

                  <div className="bg-[#0d1825] px-2.5 py-1 rounded-lg border border-emerald-500/30">
                    <span className="text-[10px] uppercase text-emerald-400 font-semibold block flex items-center gap-1">
                      <Shield className="w-3 h-3" />
                      Real Entry Price
                    </span>
                    <span className="text-base font-bold text-emerald-400 font-mono">
                      {pSym}{fmtSh(selectedPosition.realEntryPrice)}
                    </span>
                    <span className="text-[10px] text-emerald-300 block">
                      -{pSym}{Math.abs(selectedPosition.basisReductionDollar).toFixed(2)} (-{selectedPosition.basisReductionPct.toFixed(1)}%)
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase block">Spot vs Avg Cost</span>
                    <span className={`text-base font-bold ${spotVsRawPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {spotVsRawPct >= 0 ? '+' : ''}{spotVsRawPct.toFixed(1)}%
                    </span>
                    <span className="text-[10px] text-slate-400 block font-mono">
                      {selectedPosition.unrealizedPnlRaw >= 0 ? '+' : ''}{fmtMoney(selectedPosition.unrealizedPnlRaw, selectedPosition.currency)}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase block">Spot vs Real Entry</span>
                    <span className={`text-base font-bold ${spotVsRealPct >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
                      {spotVsRealPct >= 0 ? '+' : ''}{spotVsRealPct.toFixed(1)}%
                    </span>
                    <span className="text-[10px] text-sky-300/80 block font-mono">
                      {selectedPosition.unrealizedPnlReal >= 0 ? '+' : ''}{fmtMoney(selectedPosition.unrealizedPnlReal, selectedPosition.currency)}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-500 uppercase block">Total Net Harvest</span>
                    <span className="text-sm font-bold text-cyan-300">
                      +{fmtMoney(selectedPosition.totalDividendsNet + selectedPosition.totalLinkedPremiums, selectedPosition.currency)}
                    </span>
                    <span className="text-[10px] text-purple-300 block">
                      {selectedPosition.yieldOnCostPct.toFixed(1)}% YoC
                    </span>
                  </div>
                </div>

                {/* Interactive Step-Down Chart */}
                <div className="h-72 w-full pt-2">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={stepDownData} margin={{ top: 15, right: 32, left: 0, bottom: 5 }}>
                      <XAxis dataKey="date" stroke="#475569" padding={{ left: 6, right: 12 }} tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }} />
                      <YAxis
                        stroke="#475569"
                        tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }}
                        tickFormatter={(v) => `${pSym}${v}`}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data: StepDownPoint = payload[0].payload;
                            return (
                              <div className="bg-[#091019] border border-[#1e2f44] rounded-lg p-3 text-xs font-mono shadow-xl space-y-1 max-w-sm">
                                <div className="flex items-center justify-between border-b border-[#182638] pb-1.5">
                                  <span className="font-bold text-white">{data.date}</span>
                                  <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                                    {data.impactType}
                                  </span>
                                </div>
                                <p className="text-[11px] text-emerald-300 font-semibold pt-1">{data.eventDesc}</p>
                                <div className="grid grid-cols-2 gap-2 pt-1.5 text-[11px] text-slate-400">
                                  <div>
                                    <span>Raw Avg Cost: </span>
                                    <span className="text-slate-300 font-bold">{pSym}{fmtSh(data.rawAvgCost)}</span>
                                  </div>
                                  <div>
                                    <span>Real Entry Price: </span>
                                    <span className="text-emerald-400 font-bold">{pSym}{fmtSh(data.realEntryPrice)}</span>
                                  </div>
                                  <div>
                                    <span>Spot Ref: </span>
                                    <span className="text-slate-200">{pSym}{fmtSh(data.spotPrice)}</span>
                                  </div>
                                  <div>
                                    <span>Cushion: </span>
                                    <span className="text-sky-300 font-bold">{data.cushionPct >= 0 ? '+' : ''}{data.cushionPct.toFixed(1)}%</span>
                                  </div>
                                </div>
                                <div className="pt-1 text-[10px] text-slate-500 border-t border-[#152335]">
                                  Saved so far: {pSym}{fmtSh(data.rawSavingPerShare)} per share on {data.shares} shares.
                                </div>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                {/* 1. Live/Historical Spot Price (Subtle slate/white line) */}
                <Line
                  type="monotone"
                  dataKey="spotPrice"
                  stroke="#94a3b8"
                  strokeWidth={1.5}
                  dot={{ r: 3, fill: '#94a3b8' }}
                  name="Historical/Spot Price"
                />
                {/* 2. Raw Average Cost (Cyan dashed step-line) */}
                <Line
                  type="stepAfter"
                  dataKey="rawAvgCost"
                  stroke="#38bdf8"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                  name="Raw Average Cost"
                />
                {/* 3. Real Entry Price (Glowing Emerald Step-Line) */}
                <Line
                  type="stepAfter"
                  dataKey="realEntryPrice"
                  stroke="#00dc82"
                  strokeWidth={3}
                  dot={{ r: 4, fill: '#00dc82', stroke: '#080d14', strokeWidth: 2 }}
                  name="Real Entry Price"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
              </>
            );
          })()}

          {/* Chart Legend & Explanation */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#162334] text-xs font-mono text-slate-400">
            <div className="flex items-center gap-5">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-slate-400" />
                <span>Historical Spot</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 border-t border-dashed border-cyan-400" />
                <span className="text-cyan-400">Raw Avg Cost Basis</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-1 bg-emerald-400 rounded-sm" />
                <span className="text-emerald-400 font-bold">Real Entry Price (Effective)</span>
              </div>
            </div>
            <div className="text-[11px] text-slate-500">
              Steps down on each dividend and option credit; holds firm on partial trims.
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 2. MONTHLY CASHFLOW & YIELD STACKED BAR CHART */}
      {/* ------------------------------------------------------------- */}
      {visibility.analytics_monthly_income && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                <Coins className="w-5 h-5 text-cyan-400" />
                Monthly Cashflow &amp; Yield Harvest
              </h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Stacked breakdown of cash realized per calendar month from Net Dividends, Covered Calls / CSPs, and Standalone Options.
              </p>
            </div>

            {/* Inflow Summary Badges */}
            <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
              <div className="bg-[#091019] border border-[#172538] px-3 py-1.5 rounded-lg">
                <span className="text-[10px] text-slate-500 uppercase block">Total Cashflow</span>
                <span className="text-sm font-bold text-emerald-400">+{fmtMoney(totalCashflow)}</span>
              </div>
              <div className="bg-[#091019] border border-[#172538] px-3 py-1.5 rounded-lg">
                <span className="text-[10px] text-slate-500 uppercase block">Average Monthly</span>
                <span className="text-sm font-bold text-cyan-400">~{fmtMoney(averageMonthlyInflow)}/mo</span>
              </div>
              <div className="bg-[#091019] border border-[#172538] px-3 py-1.5 rounded-lg">
                <span className="text-[10px] text-slate-500 uppercase block">Top Inflow Month</span>
                <span className="text-sm font-bold text-purple-300">{topMonthLabel} ({fmtMoney(topMonthAmount)})</span>
              </div>
            </div>
          </div>

          <div className="h-64 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyRecords} stackOffset="sign" margin={{ top: 15, right: 20, left: 0, bottom: 5 }}>
                <XAxis dataKey="label" stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }} />
                <YAxis stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }} tickFormatter={(v) => `${currencySymbol}${v}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#090f17', borderColor: '#1e293b', borderRadius: '8px', fontFamily: 'monospace', fontSize: '12px' }}
                  formatter={(val: any, name: any) => [
                    `${Number(val) < 0 ? '-' : ''}${currencySymbol}${Math.abs(Number(val)).toLocaleString()}`,
                    name === 'netDividends' ? 'Net Dividends (Cyan)' : name === 'linkedPremiums' ? 'Linked Wheel Premiums (Emerald)' : 'Standalone Realized P&L (Purple)'
                  ]}
                />
                <ReferenceLine y={0} stroke="#334155" />
                {/* Horizontal average target line */}
                <ReferenceLine
                  y={averageMonthlyInflow}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  label={{ value: `Avg: ${currencySymbol}${averageMonthlyInflow}`, fill: '#f59e0b', fontSize: 10, position: 'insideTopRight' }}
                />
                <Bar dataKey="netDividends" stackId="a" fill="#38bdf8" name="netDividends" radius={[0, 0, 0, 0]} />
                <Bar dataKey="linkedPremiums" stackId="a" fill="#00dc82" name="linkedPremiums" radius={[0, 0, 0, 0]} />
                <Bar dataKey="standalonePnl" stackId="a" fill="#a855f7" name="standalonePnl" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="flex items-center gap-6 pt-2 border-t border-[#162334] text-xs font-mono text-slate-400">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#38bdf8]" />
              <span>Net Dividends (Cyan)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#00dc82]" />
              <span>Linked Wheel Premiums (Emerald)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-[#a855f7]" />
              <span>Standalone Options P&amp;L (Purple)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 border-t border-dashed border-[#f59e0b]" />
              <span className="text-amber-400">Average Inflow Line</span>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 3. ACTIVE OPTIONS EXPIRATION & CUSHION MATRIX */}
      {/* ------------------------------------------------------------- */}
      {visibility.analytics_open_expiries && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#182638] pb-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                  <Clock className="w-5 h-5 text-emerald-400" />
                  Active Options Expiration &amp; Cushion Matrix
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
                  {activeOptions.length} Active Contracts
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Monitoring DTE velocity, strike cushion, extrinsic decay remaining, and roll recommendations.
              </p>
            </div>

            <div className="flex items-center gap-3 text-xs font-mono">
              <span className="text-slate-400">
                Total Extrinsic to Harvest: <span className="text-emerald-400 font-bold">{fmtMoney(activeOptions.reduce((s, o) => s + o.extrinsicRemaining, 0))}</span>
              </span>
            </div>
          </div>

          {activeOptions.length === 0 ? (
            <div className="text-center py-8 text-slate-500 font-mono text-xs">
              No active options currently open.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-[#182638] text-slate-400 text-[10px] uppercase tracking-wider">
                    <th className="pb-2.5">Underlying &amp; Contract</th>
                    <th className="pb-2.5">Type &amp; Action</th>
                    <th className="pb-2.5">Strike vs Spot</th>
                    <th className="pb-2.5">DTE (Expiry)</th>
                    <th className="pb-2.5 text-center">Strike Cushion</th>
                    <th className="pb-2.5 text-center">Profit Captured</th>
                    <th className="pb-2.5 text-right">Extrinsic Left</th>
                    <th className="pb-2.5 text-right">Annualized APR</th>
                    <th className="pb-2.5 text-center">Action Recommendation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#131f2f]">
                  {activeOptions.map((opt) => {
                    const isCall = opt.type === 'CALL';
                    const isSweetSpot = opt.dte >= 14 && opt.dte <= 45;
                    const isExpiringSoon = opt.dte < 14;
                    const optSym = opt.currency === 'EUR' ? '€' : '$';

                    return (
                      <tr key={opt.id} className="hover:bg-[#0a121c] transition-colors">
                        <td className="py-3 font-bold text-white">
                          <div className="flex items-center gap-2">
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700 text-[10px]">
                              {opt.underlying}
                            </span>
                            <span className="text-slate-300 truncate max-w-[190px]">{opt.contractSymbol}</span>
                          </div>
                        </td>

                        <td className="py-3">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              isCall ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                            }`}
                          >
                            {opt.action} {opt.type}
                          </span>
                        </td>

                        <td className="py-3 text-slate-300">
                          <span className="font-semibold text-white">{optSym}{opt.strike.toFixed(2)}</span>
                          <span className="text-slate-500 text-[10px] block">Spot: {optSym}{opt.spotPrice.toFixed(2)}</span>
                        </td>

                        <td className="py-3">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                isExpiringSoon
                                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                                  : isSweetSpot
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                  : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                              }`}
                            >
                              {opt.dte} DTE
                            </span>
                            <span className="text-[10px] text-slate-500 hidden sm:inline">({opt.expiry})</span>
                          </div>
                        </td>

                        <td className="py-3 text-center">
                          <span
                            className={`font-bold ${
                              opt.strikeCushionPct >= 0 ? 'text-emerald-400' : 'text-amber-400'
                            }`}
                          >
                            {opt.strikeCushionPct >= 0 ? `+${opt.strikeCushionPct}% OTM` : `${opt.strikeCushionPct}% ITM`}
                          </span>
                        </td>

                        <td className="py-3 text-center">
                          <div className="w-24 mx-auto space-y-1">
                            <div className="flex items-center justify-between text-[10px]">
                              <span className={`font-bold ${opt.profitCapturedPct < 0 ? 'text-amber-400' : 'text-slate-300'}`}>
                                {opt.profitCapturedPct}%
                              </span>
                              <span className="text-slate-500">
                                {opt.profitCapturedPct >= 70 ? 'Roll Ready' : opt.profitCapturedPct < 0 ? 'Tested' : 'Decaying'}
                              </span>
                            </div>
                            <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  opt.profitCapturedPct >= 70 ? 'bg-emerald-400' : opt.profitCapturedPct < 0 ? 'bg-amber-400' : 'bg-cyan-400'
                                }`}
                                style={{ width: `${Math.max(4, Math.min(100, opt.profitCapturedPct))}%` }}
                              />
                            </div>
                          </div>
                        </td>

                        <td className="py-3 text-right font-medium text-slate-200">
                          {currencySymbol}{opt.extrinsicRemaining.toFixed(2)}
                          <span className="text-slate-500 text-[10px] block">+{currencySymbol}{opt.thetaPerDay.toFixed(2)}/day</span>
                        </td>

                        <td className="py-3 text-right font-bold text-purple-300">
                          {opt.annualizedApr > 0 ? `${opt.annualizedApr.toFixed(1)}%` : '-'}
                        </td>

                        <td className="py-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
                              opt.statusTag === 'ROLL_CANDIDATE'
                                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                : opt.statusTag === 'SWEET_SPOT'
                                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                                : 'bg-amber-500/15 border-amber-500/40 text-amber-300'
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

      {/* ------------------------------------------------------------- */}
      {/* 4. PORTFOLIO ALLOCATION & CURRENCY SPLIT */}
      {/* ------------------------------------------------------------- */}
      {visibility.analytics_allocation_fx && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Capital Allocation Breakdown */}
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                  <Layers className="w-5 h-5 text-emerald-400" />
                  Portfolio Capital Allocation
                </h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  Deployment across Stock Equities, Cash Collateral (CSPs), Standalone Options, and Free Cash.
                </p>
              </div>
              <span className="text-xs font-mono font-bold text-slate-300">
                Total: {fmtMoney(allocation.totalCapital)}
              </span>
            </div>

            <div className="space-y-3 pt-1 font-mono text-xs">
              {/* Equity Holdings */}
              <div>
                <div className="flex items-center justify-between text-slate-300 mb-1">
                  <span className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-400" />
                    <span>Stock Holdings (Equity)</span>
                  </span>
                  <span className="font-bold text-white">
                    {fmtMoney(allocation.equityValue)} (
                    {((allocation.equityValue / allocation.totalCapital) * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-400 rounded-full"
                    style={{ width: `${(allocation.equityValue / allocation.totalCapital) * 100}%` }}
                  />
                </div>
              </div>

              {/* Cash Collateral (CSPs) */}
              <div>
                <div className="flex items-center justify-between text-slate-300 mb-1">
                  <span className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-sm bg-cyan-400" />
                    <span>Cash Collateral (Short Puts)</span>
                  </span>
                  <span className="font-bold text-white">
                    {fmtMoney(allocation.cashCollateral)} (
                    {((allocation.cashCollateral / allocation.totalCapital) * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-cyan-400 rounded-full"
                    style={{ width: `${(allocation.cashCollateral / allocation.totalCapital) * 100}%` }}
                  />
                </div>
              </div>

              {/* Standalone Options Outlay */}
              <div>
                <div className="flex items-center justify-between text-slate-300 mb-1">
                  <span className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-sm bg-purple-400" />
                    <span>Standalone Options (Bucket B)</span>
                  </span>
                  <span className="font-bold text-white">
                    {fmtMoney(allocation.standaloneOptionsValue)} (
                    {((allocation.standaloneOptionsValue / allocation.totalCapital) * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-purple-400 rounded-full"
                    style={{ width: `${Math.max(2, (allocation.standaloneOptionsValue / allocation.totalCapital) * 100)}%` }}
                  />
                </div>
              </div>

              {/* Free Cash / Margin Buffer */}
              <div>
                <div className="flex items-center justify-between text-slate-300 mb-1">
                  <span className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-sm bg-slate-400" />
                    <span>Available Cash / Free Margin Buffer</span>
                  </span>
                  <span className="font-bold text-white">
                    {fmtMoney(allocation.freeCashBuffer)} (
                    {((allocation.freeCashBuffer / allocation.totalCapital) * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-slate-400 rounded-full"
                    style={{ width: `${(allocation.freeCashBuffer / allocation.totalCapital) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Currency Split & FX Exposure */}
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                    <Globe className="w-5 h-5 text-cyan-400" />
                    Currency Split &amp; FX Exposure
                  </h3>
                  <p className="text-xs text-slate-400 font-mono mt-0.5">
                    Multi-currency assets tracked against Base Currency ({baseCurrency}).
                  </p>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                  BASE: {baseCurrency}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-4 mt-5">
                {/* USD Box */}
                <div className="bg-[#080d14] border border-[#182638] rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold text-white">USD Exposure ({baseCurrency})</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-400">
                      {allocation.usdPercent}%
                    </span>
                  </div>
                  <div className="text-xl font-bold font-mono text-white">
                    {fmtMoney(allocation.usdAmount)}
                  </div>
                  <p className="text-[10px] text-slate-500 font-mono">
                    US equities &amp; USD-denominated option contracts converted to {baseCurrency}.
                  </p>
                </div>

                {/* EUR Box */}
                <div className="bg-[#080d14] border border-[#182638] rounded-xl p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono font-bold text-white">EUR Exposure ({baseCurrency})</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.2 rounded bg-purple-500/10 text-purple-400">
                      {allocation.eurPercent}%
                    </span>
                  </div>
                  <div className="text-xl font-bold font-mono text-purple-300">
                    {fmtMoney(allocation.eurAmount)}
                  </div>
                  <p className="text-[10px] text-slate-500 font-mono">
                    European options/equities &amp; EUR cash buffer.
                  </p>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-[#162334] text-[11px] font-mono text-slate-400 flex items-center justify-between">
              <span>Automatic FX reconciliation from IBKR rates</span>
              <span className="text-emerald-400 font-semibold">
                1 USD = {(fxRates['USD->EUR'] || 0.9093).toFixed(4)} EUR
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 5. PORTFOLIO VALUE & NET DEPOSITS TIMELINE */}
      {/* ------------------------------------------------------------- */}
      {visibility.analytics_portfolio_deposits && portfolioDepositData.length > 0 && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-base font-bold text-white font-sans flex items-center gap-2">
                <Target className="w-5 h-5 text-emerald-400" />
                Portfolio Value vs. Cumulative Net Deposits
              </h3>
              <p className="text-xs text-slate-400 font-mono mt-0.5">
                Visualizing portfolio alpha and compounding: Value growth exceeding net cash deposits.
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs font-mono">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-slate-500" />
                <span className="text-slate-400">Cumulative Deposits</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-1 bg-emerald-400 rounded-sm" />
                <span className="text-emerald-400 font-bold">Portfolio Value</span>
              </div>
            </div>
          </div>

          <div className="h-64 w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={portfolioDepositData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="valGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00dc82" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#00dc82" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="month" stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }} />
                <YAxis stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }} tickFormatter={(v) => `${currencySymbol}${v}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#090f17', borderColor: '#1e293b', borderRadius: '8px', fontFamily: 'monospace', fontSize: '12px' }}
                  formatter={(val: any, name: any) => [
                    `${currencySymbol}${Number(val).toLocaleString()}`,
                    name === 'portfolioValue' ? 'Portfolio Value' : 'Net Deposits'
                  ]}
                />
                <Area type="monotone" dataKey="deposits" stroke="#64748b" strokeWidth={1.5} fill="transparent" name="deposits" />
                <Area type="monotone" dataKey="portfolioValue" stroke="#00dc82" strokeWidth={2.5} fillOpacity={1} fill="url(#valGrad)" name="portfolioValue" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
};
