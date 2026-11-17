import React, { useState } from 'react';
import {
  SlidersHorizontal,
  Eye,
  EyeOff,
  Sparkles,
  Layers,
  ChevronDown,
  Check,
} from 'lucide-react';
import { ViewVisibilityState, DEFAULT_VISIBILITY } from '../types';

interface VisibilityBarProps {
  visibility: ViewVisibilityState;
  onChange: (newVisibility: ViewVisibilityState) => void;
  activeTab?: 'OVERVIEW' | 'POSITIONS' | 'ANALYTICS' | 'LEDGER';
}

export const VisibilityBar: React.FC<VisibilityBarProps> = ({
  visibility,
  onChange,
  activeTab = 'ANALYTICS',
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleKey = (key: keyof ViewVisibilityState) => {
    onChange({
      ...visibility,
      [key]: !visibility[key],
    });
  };

  // Preset 1: Show All
  const handleShowAll = () => {
    const allOn: ViewVisibilityState = {
      kpi_portfolio_value: true,
      kpi_cost_vs_real: true,
      kpi_cushion: true,
      kpi_income: true,
      kpi_yoc: true,
      kpi_realized_pnl: true,
      chart_allocation: true,
      chart_basis_comparison: true,
      chart_waterfall: true,
      chart_cushion_ranking: true,
      chart_income_timeline: true,
      section_standalone_options: true,
      analytics_step_down: true,
      analytics_portfolio_deposits: true,
      analytics_monthly_income: true,
      analytics_standalone_pnl: true,
      analytics_open_expiries: true,
      analytics_allocation_fx: true,
      kpi_xirr: true,
      kpi_rom: true,
      kpi_apr: true,
      kpi_theta: true,
    };
    onChange(allOn);
  };

  // Preset 2: Core Only
  const handleCoreOnly = () => {
    const coreOnly: ViewVisibilityState = {
      kpi_portfolio_value: true,
      kpi_cost_vs_real: true,
      kpi_cushion: true,
      kpi_income: true,
      kpi_yoc: false,
      kpi_realized_pnl: false,
      chart_allocation: false,
      chart_basis_comparison: true,
      chart_waterfall: true,
      chart_cushion_ranking: false,
      chart_income_timeline: false,
      section_standalone_options: false,
      analytics_step_down: true,
      analytics_portfolio_deposits: true,
      analytics_monthly_income: true,
      analytics_standalone_pnl: false,
      analytics_open_expiries: true,
      analytics_allocation_fx: true,
      kpi_xirr: true,
      kpi_rom: false,
      kpi_apr: true,
      kpi_theta: true,
    };
    onChange(coreOnly);
  };

  // Preset 3: Hide All
  const handleHideAll = () => {
    const allOff: ViewVisibilityState = {
      kpi_portfolio_value: false,
      kpi_cost_vs_real: false,
      kpi_cushion: false,
      kpi_income: false,
      kpi_yoc: false,
      kpi_realized_pnl: false,
      chart_allocation: false,
      chart_basis_comparison: false,
      chart_waterfall: false,
      chart_cushion_ranking: false,
      chart_income_timeline: false,
      section_standalone_options: false,
      analytics_step_down: false,
      analytics_portfolio_deposits: false,
      analytics_monthly_income: false,
      analytics_standalone_pnl: false,
      analytics_open_expiries: false,
      analytics_allocation_fx: false,
      kpi_xirr: false,
      kpi_rom: false,
      kpi_apr: false,
      kpi_theta: false,
    };
    onChange(allOff);
  };

  // Dedicated pills as requested in the user prompt
  const analyticsPills: Array<{ key: keyof ViewVisibilityState; label: string; group: 'Chart' | 'KPI' }> = [
    { key: 'analytics_step_down', label: 'Real Entry Step-Down', group: 'Chart' },
    { key: 'analytics_portfolio_deposits', label: 'Portfolio Value & Deposits', group: 'Chart' },
    { key: 'analytics_monthly_income', label: 'Monthly Income (Divs + CC)', group: 'Chart' },
    { key: 'analytics_open_expiries', label: 'Open Option Expiries & DTE', group: 'Chart' },
    { key: 'analytics_allocation_fx', label: 'Allocation & FX Exposure', group: 'Chart' },
    { key: 'analytics_standalone_pnl', label: 'Standalone Options P&L', group: 'Chart' },
    { key: 'kpi_xirr', label: 'XIRR', group: 'KPI' },
    { key: 'kpi_rom', label: 'Return on Margin', group: 'KPI' },
    { key: 'kpi_apr', label: 'Annualized APR %', group: 'KPI' },
    { key: 'kpi_theta', label: 'Theta Decay', group: 'KPI' },
  ];

  const overviewPills: Array<{ key: keyof ViewVisibilityState; label: string; group: 'Overview' }> = [
    { key: 'kpi_portfolio_value', label: 'Portfolio Value', group: 'Overview' },
    { key: 'kpi_cost_vs_real', label: 'Raw vs Real Basis', group: 'Overview' },
    { key: 'kpi_cushion', label: 'Downside Cushion', group: 'Overview' },
    { key: 'kpi_income', label: 'Income Inflow', group: 'Overview' },
    { key: 'chart_basis_comparison', label: 'Basis Comparison', group: 'Overview' },
    { key: 'chart_waterfall', label: 'Waterfall Reduction', group: 'Overview' },
  ];

  const displayPills = activeTab === 'OVERVIEW' ? [...overviewPills, ...analyticsPills.slice(0, 4)] : analyticsPills;
  const activeCount = displayPills.filter((p) => visibility[p.key]).length;

  return (
    <div className="bg-[#0b1320] border-b border-[#182638] px-4 sm:px-6 lg:px-8 py-2.5">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        {/* Left: Section Title & Presets */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              ANALYTICS &amp; KPI VIEWS
            </span>
            <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
              {activeCount}/{displayPills.length} Active
            </span>
          </div>

          <div className="h-3.5 w-px bg-slate-800 hidden sm:block" />

          {/* Preset Buttons */}
          <div className="flex items-center gap-1 text-[11px] font-mono">
            <button
              onClick={handleShowAll}
              className="px-2 py-0.5 rounded text-slate-400 hover:text-emerald-300 hover:bg-[#121f31] transition-colors"
            >
              Show All
            </button>
            <span className="text-slate-700">|</span>
            <button
              onClick={handleCoreOnly}
              className="px-2 py-0.5 rounded text-slate-400 hover:text-cyan-300 hover:bg-[#121f31] transition-colors font-semibold"
            >
              Core Only
            </button>
            <span className="text-slate-700">|</span>
            <button
              onClick={handleHideAll}
              className="px-2 py-0.5 rounded text-slate-400 hover:text-rose-300 hover:bg-[#121f31] transition-colors"
            >
              Hide All
            </button>
          </div>
        </div>

        {/* Right: Dark Slate Pills with Glowing Green Dots */}
        <div className="flex items-center gap-1.5 overflow-x-auto py-0.5 max-w-full">
          {displayPills.slice(0, 6).map((p) => {
            const active = visibility[p.key];
            return (
              <button
                key={p.key}
                onClick={() => toggleKey(p.key)}
                className={`text-[11px] font-mono px-2.5 py-1 rounded-full border transition-all flex items-center gap-1.5 shrink-0 shadow-sm ${
                  active
                    ? 'bg-[#0f1d2c] border-emerald-500/40 text-emerald-300 shadow-emerald-500/10'
                    : 'bg-[#090f17] border-[#182638] text-slate-500 hover:text-slate-400'
                }`}
              >
                {/* Glowing Green Dot */}
                <span
                  className={`w-2 h-2 rounded-full transition-all ${
                    active
                      ? 'bg-emerald-400 shadow-[0_0_8px_#00dc82]'
                      : 'bg-slate-700'
                  }`}
                />
                <span className="font-medium">{p.label}</span>
              </button>
            );
          })}

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-[11px] font-mono px-2 py-1 rounded bg-[#101b2a] hover:bg-[#16263a] text-slate-400 hover:text-slate-200 border border-[#1e2f44] flex items-center gap-1 shrink-0 ml-1"
          >
            <span>{isExpanded ? 'Less' : 'More'}</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {/* Expanded Pill Drawer for All Modules */}
      {isExpanded && (
        <div className="max-w-7xl mx-auto mt-2.5 pt-2.5 border-t border-[#172537] grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 animate-in fade-in duration-150">
          {displayPills.map((p) => {
            const active = visibility[p.key];
            return (
              <button
                key={p.key}
                onClick={() => toggleKey(p.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono text-left flex items-center justify-between border transition-all ${
                  active
                    ? 'bg-[#0f2133] border-emerald-500/50 text-emerald-200 shadow-sm'
                    : 'bg-[#080d15] border-[#162334] text-slate-500 hover:text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      active
                        ? 'bg-emerald-400 shadow-[0_0_8px_#00dc82]'
                        : 'bg-slate-700'
                    }`}
                  />
                  <span className="truncate">{p.label}</span>
                </div>
                {active ? (
                  <Eye className="w-3.5 h-3.5 text-emerald-400 shrink-0 ml-1.5" />
                ) : (
                  <EyeOff className="w-3.5 h-3.5 text-slate-600 shrink-0 ml-1.5" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
