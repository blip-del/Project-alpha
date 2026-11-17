/**
 * Options Analyzer Terminal -> Dedicated Portfolio Performance Tracker
 * Real Entry Price & Two-Bucket Engine with Offline IBKR Parser
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Transaction,
  BucketType,
  ViewVisibilityState,
  DEFAULT_VISIBILITY,
  StockQuote,
  PositionMark,
  BrokerCashSummary,
} from './types';
import {
  getDemoPortfolioTransactions,
  exportPortfolioToJson,
  importPortfolioFromJson,
} from './utils/ibkrParser';
import { calculatePortfolioState, getFxMultiplier } from './utils/portfolioEngine';
import { fetchPortfolioQuotes } from './services/optionsService';
import { Header } from './components/Header';
import { VisibilityBar } from './components/VisibilityBar';
import { OverviewTab } from './components/OverviewTab';
import { PositionsTab } from './components/PositionsTab';
import { AnalyticsTab } from './components/AnalyticsTab';
import { LedgerImportTab } from './components/LedgerImportTab';
import {
  LayoutDashboard,
  Layers,
  LineChart,
  FileSpreadsheet,
} from 'lucide-react';

export default function App() {
  // Navigation: 4 main tabs
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'POSITIONS' | 'ANALYTICS' | 'LEDGER'>('OVERVIEW');

  // Base Currency: 'EUR' | 'USD'
  const [baseCurrency, setBaseCurrency] = useState<'EUR' | 'USD'>(() => {
    try {
      return (localStorage.getItem('ais_portfolio_base_currency') as 'EUR' | 'USD') || 'EUR';
    } catch {
      return 'EUR';
    }
  });

  // Track whether currently loaded portfolio is the initial demo
  const [isDemoPortfolio, setIsDemoPortfolio] = useState<boolean>(() => {
    try {
      const flag = localStorage.getItem('ais_portfolio_is_demo');
      if (flag !== null) return flag === 'true';
      const saved = localStorage.getItem('ais_portfolio_transactions');
      return !saved || JSON.parse(saved).length === 0;
    } catch {
      return true;
    }
  });

  // Persistent Transactions
  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_transactions');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Failed to load saved transactions:', e);
    }
    return getDemoPortfolioTransactions();
  });

  // Persistent FX Rates & IBKR OpenPosition Marks
  const [fxRates, setFxRates] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_fx_rates');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [positionMarks, setPositionMarks] = useState<Record<string, PositionMark>>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_marks');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [endingCashBase, setEndingCashBase] = useState<number | undefined>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_ending_cash');
      return saved ? Number(saved) : undefined;
    } catch {
      return undefined;
    }
  });

  const [endingCashCurrency, setEndingCashCurrency] = useState<'EUR' | 'USD'>(() => {
    try {
      return (localStorage.getItem('ais_portfolio_ending_cash_cur') as 'EUR' | 'USD') || 'EUR';
    } catch {
      return 'EUR';
    }
  });

  const [depositsBase, setDepositsBase] = useState<number | undefined>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_deposits');
      return saved ? Number(saved) : undefined;
    } catch {
      return undefined;
    }
  });

  const [withdrawalsBase, setWithdrawalsBase] = useState<number | undefined>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_withdrawals');
      return saved ? Number(saved) : undefined;
    } catch {
      return undefined;
    }
  });

  const [netDepositsBase, setNetDepositsBase] = useState<number | undefined>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_net_deposits');
      return saved ? Number(saved) : undefined;
    } catch {
      return undefined;
    }
  });

  // Persistent 1-Click Bucket Overrides
  const [bucketOverrides, setBucketOverrides] = useState<Record<string, BucketType>>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_bucket_overrides');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Persistent View & KPI Visibility
  const [visibility, setVisibility] = useState<ViewVisibilityState>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_visibility');
      return saved ? { ...DEFAULT_VISIBILITY, ...JSON.parse(saved) } : DEFAULT_VISIBILITY;
    } catch {
      return DEFAULT_VISIBILITY;
    }
  });

  // Live Stock Quotes
  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [isRefreshingQuotes, setIsRefreshingQuotes] = useState(false);

  // Sync state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_transactions', JSON.stringify(transactions));
      localStorage.setItem('ais_portfolio_is_demo', String(isDemoPortfolio));
    } catch (e) {
      console.warn('Failed saving transactions:', e);
    }
  }, [transactions, isDemoPortfolio]);

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_fx_rates', JSON.stringify(fxRates));
      localStorage.setItem('ais_portfolio_marks', JSON.stringify(positionMarks));
      if (endingCashBase !== undefined) {
        localStorage.setItem('ais_portfolio_ending_cash', String(endingCashBase));
        localStorage.setItem('ais_portfolio_ending_cash_cur', endingCashCurrency);
      } else {
        localStorage.removeItem('ais_portfolio_ending_cash');
        localStorage.removeItem('ais_portfolio_ending_cash_cur');
      }
      if (depositsBase !== undefined) localStorage.setItem('ais_portfolio_deposits', String(depositsBase));
      else localStorage.removeItem('ais_portfolio_deposits');
      if (withdrawalsBase !== undefined) localStorage.setItem('ais_portfolio_withdrawals', String(withdrawalsBase));
      else localStorage.removeItem('ais_portfolio_withdrawals');
      if (netDepositsBase !== undefined) localStorage.setItem('ais_portfolio_net_deposits', String(netDepositsBase));
      else localStorage.removeItem('ais_portfolio_net_deposits');
    } catch (e) {
      console.warn('Failed saving FX/marks:', e);
    }
  }, [fxRates, positionMarks, endingCashBase, endingCashCurrency, depositsBase, withdrawalsBase, netDepositsBase]);

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_bucket_overrides', JSON.stringify(bucketOverrides));
    } catch (e) {
      console.warn('Failed saving bucket overrides:', e);
    }
  }, [bucketOverrides]);

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_base_currency', baseCurrency);
    } catch (e) {
      console.warn('Failed saving currency:', e);
    }
  }, [baseCurrency]);

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_visibility', JSON.stringify(visibility));
    } catch (e) {
      console.warn('Failed saving visibility:', e);
    }
  }, [visibility]);

  // Fetch live market quotes with exchange-aware European suffix mapping
  const refreshQuotes = useCallback(async () => {
    const underlyingMeta = new Map<string, { currency: string; exchange?: string; isStk: boolean }>();
    for (const tx of transactions) {
      const und = tx.underlying || tx.symbol;
      if (!und) continue;
      const existing = underlyingMeta.get(und);
      const isStk = tx.assetCategory === 'STK';
      if (!existing) {
        underlyingMeta.set(und, { currency: tx.currency, exchange: tx.listingExchange, isStk });
      } else {
        const nextExchange =
          isStk && tx.listingExchange
            ? tx.listingExchange
            : existing.exchange || tx.listingExchange;
        const nextCurrency = isStk ? tx.currency : existing.currency;
        underlyingMeta.set(und, {
          currency: nextCurrency,
          exchange: nextExchange,
          isStk: existing.isStk || isStk,
        });
      }
    }

    const yahooToAppSymbol = new Map<string, string>();
    const querySymbols: string[] = [];

    for (const [und, meta] of underlyingMeta.entries()) {
      const mark = positionMarks[und];
      const ex = (mark?.underlyingListingExchange || mark?.listingExchange || meta.exchange || '').toUpperCase();
      if (meta.currency === 'EUR') {
        if (ex === 'SBF' || ex === 'MONEP') {
          yahooToAppSymbol.set(`${und}.PA`, und);
          querySymbols.push(`${und}.PA`);
        } else if (ex === 'BVME' || ex === 'IDEM') {
          yahooToAppSymbol.set(`${und}.MI`, und);
          querySymbols.push(`${und}.MI`);
        } else if (ex === 'AEB') {
          yahooToAppSymbol.set(`${und}.AS`, und);
          querySymbols.push(`${und}.AS`);
        } else {
          // Skip unmapped EUR tickers so we don't overwrite with colliding US ticker (e.g. SAN)
          continue;
        }
      } else {
        yahooToAppSymbol.set(und, und);
        querySymbols.push(und);
      }
    }

    const fxSymbol = 'EURUSD=X';
    const allQuerySymbols = Array.from(new Set([...querySymbols, fxSymbol]));

    setIsRefreshingQuotes(true);
    try {
      const live = await fetchPortfolioQuotes(allQuerySymbols);
      if (live && Object.keys(live).length > 0) {
        const mapped: Record<string, StockQuote> = {};
        for (const [ySym, quote] of Object.entries(live)) {
          if (ySym === fxSymbol) {
            if (quote.regularMarketPrice > 0) {
              const eurToUsd = quote.regularMarketPrice;
              setFxRates((prev) => ({
                ...prev,
                'EUR->USD': eurToUsd,
                'USD->EUR': 1 / eurToUsd,
              }));
            }
            continue;
          }
          const appSym = yahooToAppSymbol.get(ySym) || ySym;
          mapped[appSym] = { ...quote, symbol: appSym };
        }
        if (Object.keys(mapped).length > 0) {
          setQuotes((prev) => ({ ...prev, ...mapped }));
        }
      }
    } catch (err) {
      console.warn('Failed refreshing quotes:', err);
    } finally {
      setIsRefreshingQuotes(false);
    }
  }, [transactions, positionMarks]);

  useEffect(() => {
    refreshQuotes();
  }, [refreshQuotes]);

  // Calculate chronological portfolio state using Two-Bucket engine
  const portfolioState = useMemo(() => {
    return calculatePortfolioState(
      transactions,
      bucketOverrides,
      quotes,
      baseCurrency,
      fxRates,
      positionMarks
    );
  }, [transactions, bucketOverrides, quotes, baseCurrency, fxRates, positionMarks]);

  const endingCashInDisplayCurrency = useMemo(() => {
    if (endingCashBase === undefined) return undefined;
    return endingCashBase * getFxMultiplier(endingCashCurrency, baseCurrency, fxRates);
  }, [endingCashBase, endingCashCurrency, baseCurrency, fxRates]);

  const cashSummaryInDisplayCurrency: BrokerCashSummary | undefined = useMemo(() => {
    if (
      endingCashBase === undefined &&
      depositsBase === undefined &&
      withdrawalsBase === undefined &&
      netDepositsBase === undefined
    ) {
      return undefined;
    }
    const fx = getFxMultiplier(endingCashCurrency, baseCurrency, fxRates);
    return {
      endingCashBase: endingCashBase !== undefined ? endingCashBase * fx : undefined,
      depositsBase: depositsBase !== undefined ? depositsBase * fx : undefined,
      withdrawalsBase: withdrawalsBase !== undefined ? withdrawalsBase * fx : undefined,
      netDepositsBase: netDepositsBase !== undefined ? netDepositsBase * fx : undefined,
      currency: baseCurrency,
    };
  }, [endingCashBase, depositsBase, withdrawalsBase, netDepositsBase, endingCashCurrency, baseCurrency, fxRates]);

  // Handlers
  const handleToggleBucket = (transactionId: string) => {
    setBucketOverrides((prev) => {
      const tx = transactions.find((t) => t.id === transactionId);
      const current = prev[transactionId] || tx?.bucket || tx?.defaultBucket || 'LINKED';
      const next: BucketType = current === 'LINKED' ? 'STANDALONE' : 'LINKED';
      return {
        ...prev,
        [transactionId]: next,
      };
    });
  };

  const handleToggleCampaignBucket = (transactionIds: string[], currentBucket: BucketType) => {
    const next: BucketType = currentBucket === 'LINKED' ? 'STANDALONE' : 'LINKED';
    setBucketOverrides((prev) => {
      const updated = { ...prev };
      for (const id of transactionIds) {
        updated[id] = next;
      }
      return updated;
    });
  };

  const handleToggleCurrency = () => {
    setBaseCurrency((prev) => (prev === 'EUR' ? 'USD' : 'EUR'));
  };

  const handleImportTransactions = (
    newTransactions: Transaction[],
    detectedBaseCurrency?: 'EUR' | 'USD',
    meta?: {
      fxRates?: Record<string, number>;
      positionMarks?: Record<string, PositionMark>;
      endingCashBase?: number;
      depositsBase?: number;
      withdrawalsBase?: number;
      netDepositsBase?: number;
      replaceDemo?: boolean;
    }
  ) => {
    if ((isDemoPortfolio || meta?.replaceDemo) && newTransactions.length > 0) {
      // Replace demo portfolio cleanly on first real IBKR import
      setTransactions(newTransactions);
      setBucketOverrides({});
      setIsDemoPortfolio(false);
      setQuotes({});
    } else {
      setTransactions((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const fresh = newTransactions.filter((t) => !existingIds.has(t.id));
        const merged = [...prev, ...fresh];
        merged.sort((a, b) => (new Date(a.dateTime).getTime() || 0) - (new Date(b.dateTime).getTime() || 0));
        return merged;
      });
      setIsDemoPortfolio(false);
    }

    if (meta?.fxRates && Object.keys(meta.fxRates).length > 0) {
      setFxRates((prev) => ({ ...prev, ...meta.fxRates }));
    }
    if (meta?.positionMarks && Object.keys(meta.positionMarks).length > 0) {
      setPositionMarks(meta.positionMarks);
    }
    if (meta?.endingCashBase !== undefined) {
      setEndingCashBase(meta.endingCashBase);
      if (detectedBaseCurrency) setEndingCashCurrency(detectedBaseCurrency);
    }
    if (meta?.depositsBase !== undefined) {
      setDepositsBase(meta.depositsBase);
      if (detectedBaseCurrency) setEndingCashCurrency(detectedBaseCurrency);
    }
    if (meta?.withdrawalsBase !== undefined) {
      setWithdrawalsBase(meta.withdrawalsBase);
    }
    if (meta?.netDepositsBase !== undefined) {
      setNetDepositsBase(meta.netDepositsBase);
      if (detectedBaseCurrency) setEndingCashCurrency(detectedBaseCurrency);
    }
    if (detectedBaseCurrency) {
      setBaseCurrency(detectedBaseCurrency);
    }
  };

  const handleLoadDemo = () => {
    const demo = getDemoPortfolioTransactions();
    setTransactions(demo);
    setBucketOverrides({});
    setFxRates({});
    setPositionMarks({});
    setEndingCashBase(undefined);
    setDepositsBase(undefined);
    setWithdrawalsBase(undefined);
    setNetDepositsBase(undefined);
    setIsDemoPortfolio(true);
    setQuotes({});
  };

  const handleClearPortfolio = () => {
    setTransactions([]);
    setBucketOverrides({});
    setFxRates({});
    setPositionMarks({});
    setEndingCashBase(undefined);
    setDepositsBase(undefined);
    setWithdrawalsBase(undefined);
    setNetDepositsBase(undefined);
    setIsDemoPortfolio(false);
    setQuotes({});
  };

  const handleExportJson = () => {
    const jsonStr = exportPortfolioToJson(transactions, bucketOverrides, baseCurrency, {
      endingCashBase: endingCashInDisplayCurrency,
      depositsBase: cashSummaryInDisplayCurrency?.depositsBase,
      withdrawalsBase: cashSummaryInDisplayCurrency?.withdrawalsBase,
      netDepositsBase: cashSummaryInDisplayCurrency?.netDepositsBase,
    });
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apex-portfolio-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportJsonFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const res = importPortfolioFromJson(text);
        if (res.error) {
          console.error('Import Error:', res.error);
          return;
        }
        setTransactions(res.transactions);
        setBucketOverrides(res.bucketOverrides);
        setBaseCurrency(res.baseCurrency);
        setEndingCashCurrency(res.baseCurrency);
        setIsDemoPortfolio(false);
        setPositionMarks({});
        setEndingCashBase(res.endingCashBase);
        setDepositsBase(res.depositsBase);
        setWithdrawalsBase(res.withdrawalsBase);
        setNetDepositsBase(res.netDepositsBase);
      } catch (err: any) {
        console.error('Failed reading file:', err.message);
      }
    };
    reader.readAsText(file);
  };

  // Build ticker tape symbols from active positions & open standalone options
  const tapeTickers = useMemo(() => {
    const syms = new Set<string>();
    portfolioState.positions.forEach((p) => syms.add(p.ticker));
    portfolioState.standalonePositions
      .filter((s) => s.status === 'OPEN')
      .forEach((s) => syms.add(s.underlying));
    return Array.from(syms).slice(0, 8);
  }, [portfolioState.positions, portfolioState.standalonePositions]);

  return (
    <div className="min-h-screen bg-[#080d14] text-[#e2e8f0] flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-300">
      {/* 1. Header */}
      <Header
        baseCurrency={baseCurrency}
        onToggleCurrency={handleToggleCurrency}
        onRefreshQuotes={refreshQuotes}
        isRefreshing={isRefreshingQuotes}
        onLoadDemo={handleLoadDemo}
        onOpenImport={() => setActiveTab('LEDGER')}
        onExportJson={handleExportJson}
        quotes={quotes}
        tapeTickers={tapeTickers}
        positions={portfolioState.positions}
        positionMarks={positionMarks}
      />

      {/* 2. Main Navigation Tabs (4 Tabs) */}
      <div className="bg-[#0a111b] border-b border-[#182638] px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <nav className="flex space-x-1 sm:space-x-2 py-2 overflow-x-auto">
            <button
              onClick={() => setActiveTab('OVERVIEW')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeTab === 'OVERVIEW'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#121f31] border border-transparent'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5 text-emerald-400" />
              <span>Overview</span>
            </button>

            <button
              onClick={() => setActiveTab('POSITIONS')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeTab === 'POSITIONS'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#121f31] border border-transparent'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <span>Positions &amp; Campaigns</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#16273c] text-slate-300">
                {portfolioState.positions.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('ANALYTICS')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeTab === 'ANALYTICS'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#121f31] border border-transparent'
              }`}
            >
              <LineChart className="w-3.5 h-3.5 text-purple-400" />
              <span>Analytics</span>
            </button>

            <button
              onClick={() => setActiveTab('LEDGER')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeTab === 'LEDGER'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#121f31] border border-transparent'
              }`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
              <span>Trade Ledger &amp; Import</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#16273c] text-slate-300">
                {transactions.length}
              </span>
            </button>
          </nav>

          <div className="hidden md:flex items-center gap-3 text-xs font-mono text-slate-400">
            {isDemoPortfolio && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                DEMO PORTFOLIO
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>2-Bucket Engine:</span>
              <span className="text-emerald-300 font-bold">[🔗 Linked]</span>
              <span className="text-slate-600">/</span>
              <span className="text-cyan-300 font-bold">[⚡ Standalone]</span>
            </span>
          </div>
        </div>
      </div>

      {/* 3. Customizable Metric & View Visibility Bar */}
      <VisibilityBar visibility={visibility} onChange={setVisibility} activeTab={activeTab} />

      {/* 4. Tab Content Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'OVERVIEW' && (
          <OverviewTab
            summary={portfolioState.summary}
            positions={portfolioState.positions}
            standalonePositions={portfolioState.standalonePositions}
            visibility={visibility}
            baseCurrency={baseCurrency}
            fxRates={fxRates}
            endingCashBase={endingCashInDisplayCurrency}
            cashSummary={cashSummaryInDisplayCurrency}
            onNavigateToPositions={() => setActiveTab('POSITIONS')}
          />
        )}

        {activeTab === 'POSITIONS' && (
          <PositionsTab
            positions={portfolioState.positions}
            closedPositions={portfolioState.closedPositions}
            standalonePositions={portfolioState.standalonePositions}
            bucketOverrides={bucketOverrides}
            onToggleBucket={handleToggleBucket}
            onToggleCampaignBucket={handleToggleCampaignBucket}
            baseCurrency={baseCurrency}
            fxRates={fxRates}
            visibility={visibility}
          />
        )}

        {activeTab === 'ANALYTICS' && (
          <AnalyticsTab
            summary={portfolioState.summary}
            positions={portfolioState.positions}
            standalonePositions={portfolioState.standalonePositions}
            transactions={transactions}
            quotes={quotes}
            fxRates={fxRates}
            positionMarks={positionMarks}
            endingCashBase={endingCashInDisplayCurrency}
            netDepositsBase={cashSummaryInDisplayCurrency?.netDepositsBase}
            baseCurrency={baseCurrency}
            visibility={visibility}
          />
        )}

        {activeTab === 'LEDGER' && (
          <LedgerImportTab
            transactions={transactions}
            isDemoPortfolio={isDemoPortfolio}
            onImportTransactions={handleImportTransactions}
            onClearPortfolio={handleClearPortfolio}
            onLoadDemo={handleLoadDemo}
            onExportJson={handleExportJson}
            onImportJsonFile={handleImportJsonFile}
            bucketOverrides={bucketOverrides}
            onToggleBucket={handleToggleBucket}
            baseCurrency={baseCurrency}
          />
        )}
      </main>

      {/* 5. Minimalist Footer */}
      <footer className="border-t border-[#142030] bg-[#070c14] py-3 text-center text-xs font-mono text-slate-500">
        APEX // Portfolio Performance Tracker • Chronological Real Entry Price Engine • Interactive Brokers Flex XML / CSV Native
      </footer>
    </div>
  );
}
