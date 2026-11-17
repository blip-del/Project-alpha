import React, { useState } from 'react';
import {
  TrendingUp,
  Shield,
  Layers,
  DollarSign,
  PieChart as PieChartIcon,
  Percent,
  ArrowRight,
  Wallet,
} from 'lucide-react';
import {
  StockPosition,
  PortfolioSummary,
  ViewVisibilityState,
  StandaloneOptionPosition,
  BrokerCashSummary,
} from '../types';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  PieChart,
  Pie,
} from 'recharts';

import { getFxMultiplier } from '../utils/portfolioEngine';

interface OverviewTabProps {
  summary: PortfolioSummary;
  positions: StockPosition[];
  standalonePositions: StandaloneOptionPosition[];
  visibility: ViewVisibilityState;
  baseCurrency: 'EUR' | 'USD';
  fxRates?: Record<string, number>;
  endingCashBase?: number;
  cashSummary?: BrokerCashSummary;
  onNavigateToPositions: () => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  summary,
  positions,
  standalonePositions,
  visibility,
  baseCurrency,
  fxRates = {},
  endingCashBase,
  cashSummary,
  onNavigateToPositions,
}) => {
  const [basisChartMode, setBasisChartMode] = useState<'NORMALIZED' | 'TOTAL' | 'PER_SHARE'>('NORMALIZED');
  const currencySymbol = baseCurrency === 'EUR' ? '€' : '$';

  // Format currency helpers
  const fmtMoney = (val: number) => {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    return `${sign}${currencySymbol}${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const fmtCompact = (val: number) => {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    return `${sign}${currencySymbol}${abs.toLocaleString('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    })}`;
  };

  // Cushion safety level
  const cushionPct = summary.weightedDownsideCushionPct;
  const isSafeCushion = cushionPct >= 20;
  const isModerateCushion = cushionPct >= 10 && cushionPct < 20;

  // Chart data for Asset Allocation (all values converted to baseCurrency)
  const allocationColors = ['#00dc82', '#38bdf8', '#a855f7', '#f59e0b', '#ec4899', '#6366f1'];
  const allocationData = positions.map((p, idx) => {
    const fx = getFxMultiplier(p.currency, baseCurrency, fxRates);
    return {
      name: p.ticker,
      value: Math.max(1, Math.round(p.marketValue * fx)),
      color: allocationColors[idx % allocationColors.length],
      shares: p.currentShares,
      cushion: p.downsideCushionPct,
    };
  });

  if (summary.totalOpenOptionsValue > 10) {
    allocationData.push({
      name: 'Open Opts',
      value: Math.round(summary.totalOpenOptionsValue),
      color: '#a855f7',
      shares: summary.openOptionCount,
      cushion: 0,
    });
  }

  // Chart data for Basis Reduction Waterfall
  const waterfallData = [
    {
      name: 'Gross Raw Basis',
      amount: summary.totalRawCostBasis,
      fill: '#64748b',
      desc: 'Original Capital Outlay',
    },
    {
      name: 'Net Dividends',
      amount: summary.totalNetDividends,
      fill: '#38bdf8',
      desc: 'Total Dividends minus Tax',
    },
    {
      name: 'Option Premiums',
      amount: summary.totalLinkedOptionPremiums,
      fill: '#00dc82',
      desc: 'Covered Calls & CSP Credits',
    },
    {
      name: 'Real Effective Basis',
      amount: summary.totalAdjustedCostBasis,
      fill: '#10b981',
      desc: 'True Capital at Risk',
    },
  ];

  // Chart data for Spot vs Raw vs Real Entry Price
  const basisComparisonData = positions.map((p) => {
    const fx = getFxMultiplier(p.currency, baseCurrency, fxRates);
    const spotBase = p.spotPrice * fx;
    const rawBase = p.rawAvgEntry * fx;
    const realBase = p.realEntryPrice * fx;

    const spotVsRawPct = p.rawAvgEntry > 0 ? ((p.spotPrice - p.rawAvgEntry) / p.rawAvgEntry) * 100 : 0;
    const spotVsRealPct = p.realEntryPrice > 0 ? ((p.spotPrice - p.realEntryPrice) / p.realEntryPrice) * 100 : 100;

    const spotMetric =
      basisChartMode === 'NORMALIZED'
        ? p.rawAvgEntry > 0 ? Number(((p.spotPrice / p.rawAvgEntry) * 100).toFixed(1)) : 0
        : basisChartMode === 'TOTAL'
        ? Number((p.marketValue * fx).toFixed(2))
        : Number(spotBase.toFixed(2));

    const rawMetric =
      basisChartMode === 'NORMALIZED'
        ? 100
        : basisChartMode === 'TOTAL'
        ? Number((p.rawCostPool * fx).toFixed(2))
        : Number(rawBase.toFixed(2));

    const realMetric =
      basisChartMode === 'NORMALIZED'
        ? p.rawAvgEntry > 0 ? Number(Math.max(0, (p.realEntryPrice / p.rawAvgEntry) * 100).toFixed(1)) : 0
        : basisChartMode === 'TOTAL'
        ? Number((p.adjustedCostPool * fx).toFixed(2))
        : Number(realBase.toFixed(2));

    return {
      ticker: p.ticker,
      currency: p.currency,
      shares: p.currentShares,
      spotMetric,
      rawMetric,
      realMetric,
      spotNative: p.spotPrice,
      rawNative: p.rawAvgEntry,
      realNative: p.realEntryPrice,
      spotBase,
      rawBase,
      realBase,
      marketValueBase: p.marketValue * fx,
      rawPoolBase: p.rawCostPool * fx,
      realPoolBase: p.adjustedCostPool * fx,
      unrealizedRawBase: p.unrealizedPnlRaw * fx,
      unrealizedRealBase: p.unrealizedPnlReal * fx,
      spotVsRawPct,
      spotVsRealPct,
      reductionPct: Number(p.basisReductionPct.toFixed(1)),
      cushionPct: Number(p.downsideCushionPct.toFixed(1)),
    };
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* ------------------------------------------------------------- */}
      {/* TOP KPI CARDS GRID */}
      {/* ------------------------------------------------------------- */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3.5">
        {/* KPI 1: Total Portfolio Value (Net Liquidation Value when cash is present) */}
        {visibility.kpi_portfolio_value && (() => {
          const hasCash = endingCashBase !== undefined;
          const displayNetLiq = hasCash ? summary.totalMarketValue + endingCashBase! : summary.totalMarketValue;
          return (
            <div className="min-w-0 overflow-hidden bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#27394f] transition-colors shadow-sm">
              <div>
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[11px] font-mono uppercase tracking-wider font-semibold">
                    {hasCash ? 'Account Net Liq' : 'Portfolio Value'}
                  </span>
                  <span className="p-1 rounded bg-[#132236] text-cyan-400">
                    <DollarSign className="w-3.5 h-3.5" />
                  </span>
                </div>
                <div className="text-2xl font-bold font-mono text-white tracking-tight">
                  {fmtMoney(displayNetLiq)}
                </div>
                {hasCash && (
                  <div className="text-[11px] font-mono text-slate-400 mt-1">
                    Holdings {fmtMoney(summary.totalMarketValue)} • Cash {fmtMoney(endingCashBase!)}
                  </div>
                )}
              </div>
              <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-1.5 text-[11px] font-mono">
                <span className="text-slate-400 whitespace-nowrap">{summary.openStockCount} Stk • {summary.openOptionCount} Opt</span>
                <span
                  className={`font-semibold whitespace-nowrap shrink-0 ${
                    summary.totalUnrealizedPnlReal >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {summary.totalUnrealizedPnlReal >= 0 ? '+' : ''}
                  {summary.totalUnrealizedPnlRealPct.toFixed(1)}% Real P&amp;L
                </span>
              </div>
            </div>
          );
        })()}

        {/* KPI 2: Raw vs Real Basis */}
        {visibility.kpi_cost_vs_real && (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#27394f] transition-colors shadow-sm">
            <div>
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold">
                  Real Entry Basis
                </span>
                <span className="p-1 rounded bg-emerald-500/10 text-emerald-400">
                  <Shield className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="text-2xl font-bold font-mono text-emerald-400 tracking-tight">
                {fmtMoney(summary.totalAdjustedCostBasis)}
              </div>
            </div>
            <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-1.5 text-[11px] font-mono">
              <span className="text-slate-500 line-through whitespace-nowrap truncate" title={`Raw: ${fmtMoney(summary.totalRawCostBasis)}`}>
                Raw: {fmtCompact(summary.totalRawCostBasis)}
              </span>
              <span className="text-emerald-300 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 whitespace-nowrap shrink-0">
                -{fmtMoney(summary.totalNetBasisReduction)}
              </span>
            </div>
          </div>
        )}

        {/* KPI 3: Downside Cushion */}
        {visibility.kpi_cushion && (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#27394f] transition-colors shadow-sm">
            <div>
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold">
                  Downside Cushion
                </span>
                <span className="p-1 rounded bg-sky-500/10 text-sky-400">
                  <Shield className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="text-2xl font-bold font-mono tracking-tight text-sky-400">
                {cushionPct >= 0 ? '+' : ''}{cushionPct.toFixed(1)}%
              </div>
            </div>
            <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-1.5 text-[11px] font-mono">
              <span className="text-slate-400 whitespace-nowrap truncate">vs Real Entry</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-sky-500/15 text-sky-300 border border-sky-500/30 whitespace-nowrap shrink-0">
                {isSafeCushion ? 'High Safety' : isModerateCushion ? 'Moderate' : cushionPct >= 0 ? 'Positive' : 'Protected'}
              </span>
            </div>
          </div>
        )}

        {/* KPI 4: Cash Income & Harvest */}
        {visibility.kpi_income && (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#27394f] transition-colors shadow-sm">
            <div>
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold">
                  Cash Income Inflow
                </span>
                <span className="p-1 rounded bg-cyan-500/10 text-cyan-400">
                  <TrendingUp className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="text-2xl font-bold font-mono text-cyan-400 tracking-tight">
                {fmtMoney(summary.totalNetDividends + summary.totalLinkedOptionPremiums)}
              </div>
            </div>
            <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-1.5 text-[11px] font-mono text-slate-400">
              <span className="whitespace-nowrap">Div: {fmtCompact(summary.totalNetDividends)}</span>
              <span className="whitespace-nowrap">Prem: {fmtCompact(summary.totalLinkedOptionPremiums)}</span>
            </div>
          </div>
        )}

        {/* KPI 5: Yield on Cost (YoC %) */}
        {visibility.kpi_yoc && (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#27394f] transition-colors shadow-sm">
            <div>
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span className="text-[11px] font-mono uppercase tracking-wider font-semibold">
                  Yield on Cost (YoC)
                </span>
                <span className="p-1 rounded bg-purple-500/10 text-purple-400">
                  <Percent className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="text-2xl font-bold font-mono text-purple-300 tracking-tight">
                {summary.overallYoCPct.toFixed(1)}%
              </div>
            </div>
            <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-1.5 text-[11px] font-mono">
              <span className="text-slate-400 whitespace-nowrap">Cash ROI</span>
              <span className="text-purple-400 font-semibold whitespace-nowrap">On Raw Capital</span>
            </div>
          </div>
        )}

        {/* KPI 6: Realized P&L */}
        {visibility.kpi_realized_pnl && (() => {
          const totalRealized = summary.totalRealizedStockPnl + summary.totalStandaloneOptionsPnl;
          return (
            <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#27394f] transition-colors shadow-sm">
              <div>
                <div className="flex items-center justify-between text-slate-400 mb-1">
                  <span className="text-[11px] font-mono uppercase tracking-wider font-semibold">
                    Realized Gains
                  </span>
                  <span className={`p-1 rounded ${totalRealized >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                    <TrendingUp className="w-3.5 h-3.5" />
                  </span>
                </div>
                <div className={`text-2xl font-bold font-mono tracking-tight ${totalRealized >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {totalRealized >= 0 ? '+' : ''}{fmtMoney(totalRealized)}
                </div>
              </div>
              <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-1.5 text-[11px] font-mono text-slate-400">
                <span className="whitespace-nowrap">Stock: {fmtCompact(summary.totalRealizedStockPnl)}</span>
                <span className="whitespace-nowrap">Opt: {fmtCompact(summary.totalStandaloneOptionsPnl)}</span>
              </div>
            </div>
          );
        })()}
      </div>

      {/* ------------------------------------------------------------- */}
      {/* BROKER FUNDING: DEPOSITS, WITHDRAWALS & ALL-TIME RETURN */}
      {/* ------------------------------------------------------------- */}
      {cashSummary && (
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-4 font-mono text-xs">
            <div className="flex items-center gap-2 text-slate-300 font-semibold">
              <Wallet className="w-4 h-4 text-cyan-400" />
              <span className="font-sans text-xs uppercase tracking-wider text-slate-400">
                Broker Funding &amp; Cash Flow
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 flex-1 max-w-4xl">
              <div>
                <span className="text-[10px] text-slate-500 uppercase block">Deposits</span>
                <span className="text-sm font-bold text-emerald-400">
                  +{fmtMoney(cashSummary.depositsBase ?? cashSummary.netDepositsBase ?? 0)}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 uppercase block">Withdrawals</span>
                <span className="text-sm font-bold text-slate-300">
                  {fmtMoney(-(cashSummary.withdrawalsBase ?? 0))}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 uppercase block">Net Deposited</span>
                <span className="text-sm font-bold text-white">
                  {fmtMoney(cashSummary.netDepositsBase ?? ((cashSummary.depositsBase ?? 0) - (cashSummary.withdrawalsBase ?? 0)))}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-slate-500 uppercase block">Cash Balance</span>
                <span className="text-sm font-bold text-cyan-300">
                  {fmtMoney(cashSummary.endingCashBase ?? endingCashBase ?? 0)}
                </span>
              </div>
              {(() => {
                const netDep = cashSummary.netDepositsBase ?? ((cashSummary.depositsBase ?? 0) - (cashSummary.withdrawalsBase ?? 0));
                const cashBal = cashSummary.endingCashBase ?? endingCashBase ?? 0;
                const netLiq = summary.totalMarketValue + cashBal;
                const totalReturn = netLiq - netDep;
                const totalReturnPct = netDep > 0 ? (totalReturn / netDep) * 100 : 0;
                return (
                  <div>
                    <span className="text-[10px] text-slate-500 uppercase block">Net Liq vs Deposits</span>
                    <span className={`text-sm font-bold ${totalReturn >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {totalReturn >= 0 ? '+' : ''}{fmtMoney(totalReturn)} ({totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(1)}%)
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* CHARTS ROW 1: BASIS COMPARISON & ASSET ALLOCATION */}
      {/* ------------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Basis Comparison Bar Chart (2 cols) */}
        {visibility.chart_basis_comparison && (
          <div className="lg:col-span-2 bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-sm font-bold text-white font-sans flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-400" />
                  Live Spot vs Raw Avg Entry vs Real Entry Price
                </h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  {basisChartMode === 'NORMALIZED'
                    ? 'Indexed to Raw Avg Cost (100%) so every ticker stays visible regardless of share price.'
                    : basisChartMode === 'TOTAL'
                    ? `Total position capital in ${baseCurrency}: Raw Cost vs Real Basis vs Market Value.`
                    : `Per-share comparison converted to ${baseCurrency}.`}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* Scale Mode Pills */}
                <div className="flex items-center bg-[#080d14] border border-[#1a293c] rounded-lg p-0.5 text-[11px] font-mono">
                  <button
                    onClick={() => setBasisChartMode('NORMALIZED')}
                    className={`px-2 py-1 rounded-md transition-colors ${
                      basisChartMode === 'NORMALIZED'
                        ? 'bg-emerald-500/20 text-emerald-300 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    % of Cost
                  </button>
                  <button
                    onClick={() => setBasisChartMode('TOTAL')}
                    className={`px-2 py-1 rounded-md transition-colors ${
                      basisChartMode === 'TOTAL'
                        ? 'bg-emerald-500/20 text-emerald-300 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Total {currencySymbol}
                  </button>
                  <button
                    onClick={() => setBasisChartMode('PER_SHARE')}
                    className={`px-2 py-1 rounded-md transition-colors ${
                      basisChartMode === 'PER_SHARE'
                        ? 'bg-emerald-500/20 text-emerald-300 font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Per Share
                  </button>
                </div>

                {/* Legend */}
                <div className="flex items-center gap-3 text-xs font-mono">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-cyan-400" />
                    <span className="text-cyan-300">Spot</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-slate-500" />
                    <span className="text-slate-400">Raw Avg</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-400" />
                    <span className="text-emerald-300 font-bold">Real Entry</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={basisComparisonData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <XAxis dataKey="ticker" stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 12, fontFamily: 'monospace' }} />
                  <YAxis
                    stroke="#475569"
                    tick={{ fill: '#94a3b8', fontSize: 11, fontFamily: 'monospace' }}
                    tickFormatter={(v) => (basisChartMode === 'NORMALIZED' ? `${v}%` : `${currencySymbol}${v}`)}
                  />
                  <Tooltip
                    cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }}
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const d = payload[0].payload;
                      const nSym = d.currency === 'EUR' ? '€' : '$';
                      const fmtSh = (v: number) => (v > 0 && v < 2 ? v.toFixed(3) : v.toFixed(2));
                      return (
                        <div className="bg-[#090f17] border border-[#1e2f44] rounded-lg p-3 font-mono text-xs shadow-xl space-y-1.5 min-w-[240px]">
                          <div className="flex items-center justify-between border-b border-[#182638] pb-1">
                            <span className="font-bold text-white">{d.ticker}</span>
                            <span className="text-[10px] text-slate-400">{d.shares} shs • {d.currency}</span>
                          </div>
                          <div className="flex items-center justify-between text-cyan-300">
                            <span>Spot Price:</span>
                            <span className="font-bold">
                              {nSym}{fmtSh(d.spotNative)} ({fmtMoney(d.marketValueBase)})
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-slate-300">
                            <span>Raw Avg Cost:</span>
                            <span className="font-bold">
                              {nSym}{fmtSh(d.rawNative)} ({fmtMoney(d.rawPoolBase)})
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-emerald-400">
                            <span>Real Entry Price:</span>
                            <span className="font-bold">
                              {nSym}{fmtSh(d.realNative)} ({fmtMoney(d.realPoolBase)})
                            </span>
                          </div>
                          <div className="pt-1.5 border-t border-[#182638] space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">Spot vs Avg Cost:</span>
                              <span className={`font-bold ${d.spotVsRawPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {d.spotVsRawPct >= 0 ? '+' : ''}{d.spotVsRawPct.toFixed(1)}% ({d.unrealizedRawBase >= 0 ? '+' : ''}{fmtMoney(d.unrealizedRawBase)})
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-slate-400">Spot vs Real Entry:</span>
                              <span className={`font-bold ${d.spotVsRealPct >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
                                {d.spotVsRealPct >= 0 ? '+' : ''}{d.spotVsRealPct.toFixed(1)}% ({d.unrealizedRealBase >= 0 ? '+' : ''}{fmtMoney(d.unrealizedRealBase)})
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="spotMetric" fill="#38bdf8" radius={[4, 4, 0, 0]} name="Spot Price" />
                  <Bar dataKey="rawMetric" fill="#64748b" radius={[4, 4, 0, 0]} name="Raw Avg Cost" />
                  <Bar dataKey="realMetric" fill="#00dc82" radius={[4, 4, 0, 0]} name="Real Entry Price" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Portfolio Asset Allocation (1 col) */}
        {visibility.chart_allocation && (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white font-sans flex items-center gap-2">
                  <PieChartIcon className="w-4 h-4 text-cyan-400" />
                  Asset Allocation
                </h3>
                <span className="text-xs font-mono text-slate-400">{positions.length} stocks</span>
              </div>

              <div className="h-44 w-full relative">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={allocationData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={70}
                      paddingAngle={3}
                    >
                      {allocationData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} stroke="#080d14" strokeWidth={2} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#090f17', borderColor: '#1e293b', borderRadius: '8px', fontFamily: 'monospace', fontSize: '12px' }}
                      formatter={(val: any) => [fmtMoney(Number(val)), 'Market Value']}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-[10px] uppercase font-mono text-slate-400">Total</span>
                  <span className="text-xs font-bold font-mono text-white">{fmtCompact(summary.totalMarketValue)}</span>
                </div>
              </div>
            </div>

            {/* Position legend items */}
            <div className="space-y-1.5 pt-3 border-t border-[#172436] text-xs font-mono">
              {allocationData.map((item) => (
                <div key={item.name} className="flex items-center justify-between text-slate-300">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="font-bold text-white">{item.name}</span>
                    <span className="text-slate-500 text-[11px]">({item.shares} shs)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-200">{fmtMoney(item.value)}</span>
                    {item.name !== 'Open Opts' && (
                      <span className="text-[10px] text-sky-400 font-bold">
                        {item.cushion >= 0 ? '+' : ''}{item.cushion.toFixed(0)}% cushion
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      {/* CHARTS ROW 2: BASIS WATERFALL & DOWNSIDE CUSHION SPECTRUM */}
      {/* ------------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Waterfall Chart */}
        {visibility.chart_waterfall && (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-bold text-white font-sans flex items-center gap-2">
                  <Layers className="w-4 h-4 text-emerald-400" />
                  Portfolio Basis Reduction Waterfall
                </h3>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  How dividends and option premiums systematically knock dollars off your cost basis.
                </p>
              </div>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
                Total Saved: {fmtMoney(summary.totalNetBasisReduction)}
              </span>
            </div>

            <div className="grid grid-cols-4 gap-2 mt-4 pt-2">
              {waterfallData.map((w, idx) => (
                <div key={w.name} className="bg-[#080d14] border border-[#162436] rounded-lg p-3 text-center">
                  <span className="text-[10px] font-mono uppercase text-slate-400 block truncate">{w.name}</span>
                  <div className="text-base font-bold font-mono text-white mt-1" style={{ color: w.fill }}>
                    {fmtMoney(w.amount)}
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono mt-1 block truncate">{w.desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stock Performance & Downside Cushion Spectrum */}
        {visibility.chart_cushion_ranking && (
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white font-sans flex items-center gap-2">
                  <Shield className="w-4 h-4 text-sky-400" />
                  Stock Performance &amp; Cushion Matrix
                </h3>
                <span className="text-[11px] font-mono text-slate-400">vs Avg Cost &amp; vs Real Entry</span>
              </div>

              <div className="space-y-3 mt-3">
                {positions.map((p) => {
                  const cushion = p.downsideCushionPct;
                  const pSym = p.currency === 'EUR' ? '€' : '$';
                  const fmtSh = (v: number) => (v > 0 && v < 2 ? v.toFixed(3) : v.toFixed(2));
                  const spotVsRawPct = p.rawAvgEntry > 0 ? ((p.spotPrice - p.rawAvgEntry) / p.rawAvgEntry) * 100 : 0;
                  const spotVsRealPct = p.realEntryPrice > 0 ? ((p.spotPrice - p.realEntryPrice) / p.realEntryPrice) * 100 : 100;
                  const barWidth = cushion >= 0
                    ? Math.min(100, Math.max(6, cushion))
                    : Math.min(100, Math.max(6, p.basisReductionPct));

                  return (
                    <div key={p.ticker} className="space-y-1.5 font-mono text-xs bg-[#080d14] border border-[#152336] rounded-lg p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white">{p.ticker}</span>
                          <span className="text-slate-400 text-[11px]">
                            Avg <span className="text-slate-300">{pSym}{fmtSh(p.rawAvgEntry)}</span> • Real <span className="text-emerald-400 font-semibold">{pSym}{fmtSh(p.realEntryPrice)}</span> • Spot <span className="text-cyan-300 font-semibold">{pSym}{fmtSh(p.spotPrice)}</span>
                          </span>
                        </div>
                        <span className="font-bold text-sky-400 text-[11px]">
                          {cushion >= 0 ? '+' : ''}{cushion.toFixed(1)}% Cushion
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-slate-400">
                          Spot vs Avg:{' '}
                          <span className={`font-bold ${spotVsRawPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {spotVsRawPct >= 0 ? '+' : ''}{spotVsRawPct.toFixed(1)}% ({p.unrealizedPnlRaw >= 0 ? '+' : '-'}{pSym}{Math.abs(p.unrealizedPnlRaw).toFixed(0)})
                          </span>
                        </span>
                        <span className="text-slate-400">
                          Spot vs Real:{' '}
                          <span className={`font-bold ${spotVsRealPct >= 0 ? 'text-emerald-400' : 'text-sky-400'}`}>
                            {spotVsRealPct >= 0 ? '+' : ''}{spotVsRealPct.toFixed(1)}% ({p.unrealizedPnlReal >= 0 ? '+' : '-'}{pSym}{Math.abs(p.unrealizedPnlReal).toFixed(0)})
                          </span>
                        </span>
                      </div>

                      {/* Visual progress buffer bar */}
                      <div className="h-1.5 w-full rounded-full bg-[#0c1420] overflow-hidden border border-[#152336] relative">
                        <div
                          className="h-full rounded-full transition-all duration-500 bg-gradient-to-r from-blue-500 to-sky-400"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-[#172537] flex items-center justify-between">
              <span className="text-[11px] text-slate-400 font-mono">
                Inspect campaigns &amp; bucket allocations in detail:
              </span>
              <button
                onClick={onNavigateToPositions}
                className="flex items-center gap-1 text-xs font-mono text-emerald-400 hover:text-emerald-300 font-semibold"
              >
                <span>View Positions &amp; Campaigns</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
