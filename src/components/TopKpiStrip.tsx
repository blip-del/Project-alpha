import React from 'react';
import {
  DollarSign,
  Wallet,
  Globe,
  Activity,
  TrendingUp,
} from 'lucide-react';
import {
  PortfolioSummary,
  BrokerCashSummary,
  CapitalAllocation,
} from '../types';

interface TopKpiStripProps {
  summary: PortfolioSummary;
  cashSummary?: BrokerCashSummary;
  endingCashBase?: number;
  allocation: CapitalAllocation;
  baseCurrency: 'EUR' | 'USD';
  activeTickerCount: number;
  totalTickerCount: number;
}

export const TopKpiStrip: React.FC<TopKpiStripProps> = ({
  summary,
  cashSummary,
  endingCashBase,
  allocation,
  baseCurrency,
  activeTickerCount,
  totalTickerCount,
}) => {
  const sym = baseCurrency === 'EUR' ? '€' : '$';

  const fmtMoney = (val: number, curSymbol: string = sym, decimals: number = 2) => {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    return `${sign}${curSymbol}${abs.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  };

  const fmtSigned = (val: number, curSymbol: string = sym, decimals: number = 2) => {
    const abs = Math.abs(val);
    const sign = val > 0 ? '+' : val < 0 ? '-' : '';
    return `${sign}${curSymbol}${abs.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}`;
  };

  const cashTotal = cashSummary?.endingCashBase ?? endingCashBase ?? allocation.freeCashBuffer ?? 0;
  const hasCash = endingCashBase !== undefined || cashSummary?.endingCashBase !== undefined || allocation.freeCashBuffer > 0;
  const netLiqValue = summary.totalMarketValue + cashTotal;

  const netDeposited =
    cashSummary?.netDepositsBase ??
    (cashSummary?.depositsBase !== undefined
      ? cashSummary.depositsBase - (cashSummary.withdrawalsBase ?? 0)
      : undefined);

  const totalReturnVsDeposits = netDeposited !== undefined ? netLiqValue - netDeposited : summary.totalNetAllPnlBase;
  const totalReturnPct =
    netDeposited !== undefined && netDeposited > 0
      ? (totalReturnVsDeposits / netDeposited) * 100
      : summary.totalRawCostBasis > 0
      ? (summary.totalNetAllPnlBase / summary.totalRawCostBasis) * 100
      : 0;

  const reservedCollateral = summary.shortPutCollateralBase || 0;
  const availableToTrade = Math.max(0, cashTotal - reservedCollateral);

  const rawCashByCur = cashSummary?.cashByCurrency;
  const eurCashNative = rawCashByCur?.EUR;
  const usdCashNative = rawCashByCur?.USD;

  const openUnrealized = summary.totalActiveOpenPnlBase;
  const realizedTotal = summary.totalRealizedAllPnlBase;
  const openOptionsUnrealized = openUnrealized - summary.totalUnrealizedPnlRaw;
  const closedTradesRealized = realizedTotal - summary.totalNetDividends;

  const usdPct = Math.max(0, Math.min(100, allocation.usdPercent));
  const eurPct = Math.max(0, Math.min(100, allocation.eurPercent));

  return (
    <section
      aria-label="Global Portfolio KPI Strip"
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5"
    >
      {/* 1. NET LIQ VALUE */}
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#2a3f57] transition-colors shadow-sm min-w-0">
        <div>
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">
              Net Liq Value ({baseCurrency})
            </span>
            <span className="p-1 rounded bg-[#132236] text-cyan-400 shrink-0">
              <DollarSign className="w-3.5 h-3.5" />
            </span>
          </div>
          <div className="text-2xl font-bold font-mono text-white tracking-tight tabular-nums">
            {fmtMoney(netLiqValue)}
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-1.5 space-y-0.5 tabular-nums">
            <div className="flex items-center justify-between">
              <span>Holdings</span>
              <span className="text-slate-200">{fmtMoney(summary.totalMarketValue)}</span>
            </div>
            {hasCash && (
              <div className="flex items-center justify-between">
                <span>Cash</span>
                <span className="text-slate-200">{fmtMoney(cashTotal)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-2.5 pt-2 border-t border-[#162334] text-[11px] font-mono space-y-0.5 tabular-nums">
          <div className="flex items-center justify-between text-slate-400">
            <span>{netDeposited !== undefined ? 'Net Deposited' : 'Scope'}</span>
            <span className="text-slate-300">
              {netDeposited !== undefined ? fmtMoney(netDeposited, sym, 0) : `${activeTickerCount}/${totalTickerCount}`}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">Total Return</span>
            <span
              className={`font-bold ${
                totalReturnVsDeposits >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {fmtSigned(totalReturnVsDeposits, sym, 0)} ({totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(1)}%)
            </span>
          </div>
        </div>
      </div>

      {/* 2. AVAILABLE CASH & COLLATERAL */}
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#2a3f57] transition-colors shadow-sm min-w-0">
        <div>
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">
              Available Cash
            </span>
            <span className="p-1 rounded bg-cyan-500/10 text-cyan-400 shrink-0">
              <Wallet className="w-3.5 h-3.5" />
            </span>
          </div>
          <div className="text-2xl font-bold font-mono text-cyan-300 tracking-tight tabular-nums">
            {fmtMoney(availableToTrade)}
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-1.5 space-y-0.5 tabular-nums">
            {eurCashNative !== undefined && usdCashNative !== undefined ? (
              <>
                <div className="flex items-center justify-between">
                  <span>EUR Cash</span>
                  <span className="text-emerald-300">€{eurCashNative.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>USD Cash</span>
                  <span className="text-cyan-300">${usdCashNative.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between">
                <span>Broker Cash</span>
                <span className="text-slate-200">{fmtMoney(cashTotal)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
          <span className="text-slate-400">Put Collateral</span>
          <span className={`font-semibold ${reservedCollateral > 0 ? 'text-amber-300' : 'text-slate-300'}`}>
            {reservedCollateral > 0 ? fmtMoney(reservedCollateral) : `${sym}0.00`}
          </span>
        </div>
      </div>

      {/* 3. CURRENCY BUCKETS (FX EXPOSURE) */}
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#2a3f57] transition-colors shadow-sm min-w-0">
        <div>
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">
              Currency Buckets
            </span>
            <span className="p-1 rounded bg-purple-500/10 text-purple-400 shrink-0">
              <Globe className="w-3.5 h-3.5" />
            </span>
          </div>

          <div className="space-y-1 font-mono text-xs tabular-nums mt-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-cyan-400 uppercase font-bold">USD Bucket</span>
              <span className="text-white font-bold">
                {fmtMoney(allocation.usdAmount)}{' '}
                <span className="text-cyan-300 font-semibold">({usdPct.toFixed(1)}%)</span>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-emerald-400 uppercase font-bold">EUR Bucket</span>
              <span className="text-white font-bold">
                {fmtMoney(allocation.eurAmount)}{' '}
                <span className="text-emerald-300 font-semibold">({eurPct.toFixed(1)}%)</span>
              </span>
            </div>
          </div>

          <div className="h-2 w-full rounded-full bg-[#080d14] border border-[#1a283a] overflow-hidden flex mt-2.5">
            <div
              className="h-full bg-cyan-400 transition-all duration-300"
              style={{ width: `${usdPct}%` }}
              title={`USD Exposure: ${usdPct.toFixed(1)}%`}
            />
            <div
              className="h-full bg-emerald-400 transition-all duration-300"
              style={{ width: `${eurPct}%` }}
              title={`EUR Exposure: ${eurPct.toFixed(1)}%`}
            />
          </div>
        </div>

        <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400 tabular-nums">
          <span>FX Rate</span>
          <span className="text-slate-200 font-semibold">
            1 USD = {allocation.usdToEurRate.toFixed(4)} EUR
          </span>
        </div>
      </div>

      {/* 4. ACTIVE POSITIONS P&L */}
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#2a3f57] transition-colors shadow-sm min-w-0">
        <div>
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">
              Active Open P&amp;L
            </span>
            <span className={`p-1 rounded shrink-0 ${openUnrealized >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
              <Activity className="w-3.5 h-3.5" />
            </span>
          </div>
          <div
            className={`text-2xl font-bold font-mono tracking-tight tabular-nums ${
              openUnrealized >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {fmtSigned(openUnrealized)}
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-1.5 space-y-0.5 tabular-nums">
            <div className="flex items-center justify-between">
              <span>Equities Open</span>
              <span className={summary.totalUnrealizedPnlRaw >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                {fmtSigned(summary.totalUnrealizedPnlRaw)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Options Open</span>
              <span className={openOptionsUnrealized >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                {fmtSigned(openOptionsUnrealized)}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-2 text-[11px] font-mono text-slate-400">
          <span>Active Book</span>
          <span className="text-slate-200 font-semibold">
            {summary.openStockCount} Stk • {summary.openOptionCount} Opts
          </span>
        </div>
      </div>

      {/* 5. TOTAL REALIZED P&L */}
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-4 flex flex-col justify-between hover:border-[#2a3f57] transition-colors shadow-sm min-w-0">
        <div>
          <div className="flex items-center justify-between text-slate-400 mb-1.5">
            <span className="text-[10px] font-mono uppercase tracking-wider font-semibold">
              Total Realized P&amp;L
            </span>
            <span className={`p-1 rounded shrink-0 ${realizedTotal >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
              <TrendingUp className="w-3.5 h-3.5" />
            </span>
          </div>
          <div
            className={`text-2xl font-bold font-mono tracking-tight tabular-nums ${
              realizedTotal >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {fmtSigned(realizedTotal)}
          </div>
          <div className="text-[11px] font-mono text-slate-400 mt-1.5 space-y-0.5 tabular-nums">
            <div className="flex items-center justify-between">
              <span>Closed Trades</span>
              <span className={closedTradesRealized >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                {fmtSigned(closedTradesRealized)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Net Dividends</span>
              <span className="text-cyan-300">{fmtSigned(summary.totalNetDividends)}</span>
            </div>
          </div>
        </div>

        <div className="mt-2.5 pt-2 border-t border-[#162334] flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
          <span className="text-slate-400">Combined Net</span>
          <span className={`font-bold ${summary.totalNetAllPnlBase >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmtSigned(summary.totalNetAllPnlBase)}
          </span>
        </div>
      </div>
    </section>
  );
};
