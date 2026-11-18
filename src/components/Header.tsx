import React from 'react';
import {
  TrendingUp,
  RefreshCw,
  Download,
  Upload,
  Database,
  ShieldCheck,
  Globe,
} from 'lucide-react';
import { StockQuote, StockPosition, PositionMark, UnifiedTickerSummary } from '../types';

interface HeaderProps {
  baseCurrency: 'EUR' | 'USD';
  onToggleCurrency: () => void;
  onRefreshQuotes: () => void;
  isRefreshing: boolean;
  onOpenImport: () => void;
  onExportJson: () => void;
  quotes: Record<string, StockQuote>;
  tapeTickers?: string[];
  positions?: StockPosition[];
  unifiedTickers?: UnifiedTickerSummary[];
  positionMarks?: Record<string, PositionMark>;
}

export const Header: React.FC<HeaderProps> = ({
  baseCurrency,
  onToggleCurrency,
  onRefreshQuotes,
  isRefreshing,
  onOpenImport,
  onExportJson,
  quotes,
  tapeTickers = [],
  positions = [],
  unifiedTickers = [],
  positionMarks = {},
}) => {
  const displayTickers = tapeTickers.length > 0 ? tapeTickers : Object.keys(quotes).slice(0, 8);

  return (
    <header className="border-b border-[#1c2838] bg-[#090f18]">
      {/* Top Banner */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-wrap items-center justify-between gap-4">
        {/* Brand & Subtitle */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500/20 to-cyan-500/10 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-sm shadow-emerald-500/10">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-white text-base tracking-tight font-sans">
                APEX <span className="text-emerald-400 font-mono">//</span> CHRONO-TRACKER
              </span>
              <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                UNIFIED BASIS ENGINE
              </span>
            </div>
            <p className="text-xs text-slate-400 font-mono hidden sm:block">
              Interactive Brokers Flex XML / CSV &amp; Two-Bucket Cost Pool Engine
            </p>
          </div>
        </div>

        {/* Action Controls & Currency Toggle */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Base Currency Toggle */}
          <button
            onClick={onToggleCurrency}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#0d1624] hover:bg-[#121f33] border border-[#1e2f44] text-xs font-mono text-slate-300 transition-colors"
            title="Toggle Base Reporting Currency (EUR / USD)"
          >
            <Globe className="w-3.5 h-3.5 text-cyan-400" />
            <span className="text-slate-400">Base:</span>
            <span className="text-emerald-400 font-bold">{baseCurrency}</span>
          </button>

          {/* Refresh Quotes */}
          <button
            onClick={onRefreshQuotes}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#0d1624] hover:bg-[#121f33] border border-[#1e2f44] text-xs font-mono text-slate-300 transition-colors disabled:opacity-50"
            title="Fetch real-time spot quotes from live financial data feed"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-emerald-400 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          {/* Import CSV/XML */}
          <button
            onClick={onOpenImport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#132236] hover:bg-[#1a2e47] border border-[#233a59] text-xs font-mono text-slate-200 transition-colors"
            title="Import IBKR Flex XML, Activity CSV, or JSON"
          >
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            <span>Import IBKR</span>
          </button>

          {/* Export JSON */}
          <button
            onClick={onExportJson}
            className="p-1.5 rounded-md bg-[#0d1624] hover:bg-[#121f33] border border-[#1e2f44] text-slate-400 hover:text-slate-200 transition-colors"
            title="Export JSON Backup"
          >
            <Download className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Mini Ticker-Tape Bar */}
      <div className="bg-[#060a10] border-t border-[#131d2b] px-4 sm:px-6 py-1.5 overflow-x-auto text-[11px] font-mono flex items-center gap-5 text-slate-400">
        <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          SPOT FEED
        </span>
        <div className="flex items-center gap-6 shrink-0">
          {displayTickers.map((sym) => {
            const ut = unifiedTickers.find((u) => u.ticker === sym);
            const pos = positions.find((p) => p.ticker === sym);
            const mark = positionMarks[sym];
            const q = quotes[sym];
            const cur = ut?.currency || pos?.currency || mark?.currency || 'USD';
            const curSym = cur === 'EUR' ? '€' : '$';
            const price = ut?.spotPrice || pos?.spotPrice || q?.regularMarketPrice || mark?.markPrice || 0;
            const change = ut ? ut.spotChange : pos ? pos.spotChange : q?.regularMarketChange || 0;
            const changePct = ut ? ut.spotChangePct : pos ? pos.spotChangePct : q?.regularMarketChangePercent || 0;
            const isPos = change >= 0;

            return (
              <div key={sym} className="flex items-center gap-1.5">
                <span className="font-bold text-slate-200">{sym}</span>
                <span className="text-slate-300">
                  {price > 0 ? `${curSym}${price.toFixed(price < 2 ? 3 : 2)}` : '—'}
                </span>
                {price > 0 && (
                  <span className={`text-[10px] ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {isPos ? '+' : ''}{changePct.toFixed(2)}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="ml-auto text-[10px] text-slate-500 hidden md:block">
          Offline IBKR Statement Parser • Real-Time Basis Deduction
        </div>
      </div>
    </header>
  );
};
