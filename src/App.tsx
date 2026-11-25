/**
 * APEX // CHRONO-TRACKER
 * Unified Ticker-Centric Portfolio Tracker & Two-Bucket Real Entry Engine
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Transaction,
  BucketType,
  StockQuote,
  PositionMark,
  BrokerCashSummary,
  OptionalPanelsState,
  DEFAULT_OPTIONAL_PANELS,
  JournalTradeOverride,
  JournalSettings,
  DEFAULT_JOURNAL_SETTINGS,
  DEFAULT_JOURNAL_SAVED_VIEWS,
  StatementSnapshotMeta,
  ImportMergeDiff,
  ImportUndoSnapshot,
} from './types';
import {
  exportPortfolioToJson,
  importPortfolioFromJson,
} from './utils/ibkrParser';
import { calculatePortfolioState, getFxMultiplier } from './utils/portfolioEngine';
import {
  mergePortfolioImport,
  migrateLegacyJournalOverrides,
  ParsedImportPayload,
} from './utils/xmlImportEngine';
import { computeCapitalAllocation } from './utils/analyticsEngine';
import { fetchPortfolioQuotes } from './services/optionsService';
import { Header } from './components/Header';
import { TopKpiStrip } from './components/TopKpiStrip';
import { UnifiedTickerMatrix } from './components/UnifiedTickerMatrix';
import { OptionalDeepDivePanels } from './components/OptionalDeepDivePanels';
import { LedgerImportTab } from './components/LedgerImportTab';
import {
  LayoutGrid,
  FileSpreadsheet,
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<'PORTFOLIO' | 'LEDGER'>('PORTFOLIO');

  const [baseCurrency, setBaseCurrency] = useState<'EUR' | 'USD'>(() => {
    try {
      return (localStorage.getItem('ais_portfolio_base_currency') as 'EUR' | 'USD') || 'EUR';
    } catch {
      return 'EUR';
    }
  });

  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    try {
      const legacyDemoFlag = localStorage.getItem('ais_portfolio_is_demo');
      if (legacyDemoFlag !== null) {
        localStorage.removeItem('ais_portfolio_is_demo');
        if (legacyDemoFlag === 'true') {
          localStorage.removeItem('ais_portfolio_transactions');
          return [];
        }
      }
      const saved = localStorage.getItem('ais_portfolio_transactions');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.warn('Failed to load saved transactions:', e);
    }
    return [];
  });

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

  const [cashByCurrency, setCashByCurrency] = useState<Record<string, number> | undefined>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_cash_by_cur');
      return saved ? JSON.parse(saved) : undefined;
    } catch {
      return undefined;
    }
  });

  const [bucketOverrides, setBucketOverrides] = useState<Record<string, BucketType>>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_bucket_overrides');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [optionalPanels, setOptionalPanels] = useState<OptionalPanelsState>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_panels_v2');
      return saved ? { ...DEFAULT_OPTIONAL_PANELS, ...JSON.parse(saved) } : DEFAULT_OPTIONAL_PANELS;
    } catch {
      return DEFAULT_OPTIONAL_PANELS;
    }
  });

  const [journalOverrides, setJournalOverrides] = useState<Record<string, JournalTradeOverride>>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_journal_overrides_v1');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const [journalSettings, setJournalSettings] = useState<JournalSettings>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_journal_settings_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...DEFAULT_JOURNAL_SETTINGS,
          ...parsed,
          savedViews:
            Array.isArray(parsed.savedViews) && parsed.savedViews.length > 0
              ? parsed.savedViews
              : DEFAULT_JOURNAL_SAVED_VIEWS,
        };
      }
      return DEFAULT_JOURNAL_SETTINGS;
    } catch {
      return DEFAULT_JOURNAL_SETTINGS;
    }
  });

  const [lastStatementMeta, setLastStatementMeta] = useState<StatementSnapshotMeta | undefined>(() => {
    try {
      const saved = localStorage.getItem('ais_portfolio_statement_meta_v1');
      return saved ? JSON.parse(saved) : undefined;
    } catch {
      return undefined;
    }
  });

  const [lastImportDiff, setLastImportDiff] = useState<ImportMergeDiff | null>(null);
  const [lastImportUndo, setLastImportUndo] = useState<ImportUndoSnapshot | null>(null);
  const [focusClosedTradeId, setFocusClosedTradeId] = useState<string | null>(null);

  const [quotes, setQuotes] = useState<Record<string, StockQuote>>({});
  const [quotesFetchedAt, setQuotesFetchedAt] = useState<string | undefined>(undefined);
  const [isRefreshingQuotes, setIsRefreshingQuotes] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_transactions', JSON.stringify(transactions));
    } catch (e) {
      console.warn('Failed saving transactions:', e);
    }
  }, [transactions]);

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
      if (cashByCurrency && Object.keys(cashByCurrency).length > 0) {
        localStorage.setItem('ais_portfolio_cash_by_cur', JSON.stringify(cashByCurrency));
      } else {
        localStorage.removeItem('ais_portfolio_cash_by_cur');
      }
    } catch (e) {
      console.warn('Failed saving FX/marks:', e);
    }
  }, [fxRates, positionMarks, endingCashBase, endingCashCurrency, depositsBase, withdrawalsBase, netDepositsBase, cashByCurrency]);

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
      localStorage.setItem('ais_portfolio_panels_v2', JSON.stringify(optionalPanels));
    } catch (e) {
      console.warn('Failed saving optional panels:', e);
    }
  }, [optionalPanels]);

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_journal_overrides_v1', JSON.stringify(journalOverrides));
    } catch (e) {
      console.warn('Failed saving journal overrides:', e);
    }
  }, [journalOverrides]);

  useEffect(() => {
    try {
      localStorage.setItem('ais_portfolio_journal_settings_v1', JSON.stringify(journalSettings));
    } catch (e) {
      console.warn('Failed saving journal settings:', e);
    }
  }, [journalSettings]);

  useEffect(() => {
    try {
      if (lastStatementMeta) {
        localStorage.setItem('ais_portfolio_statement_meta_v1', JSON.stringify(lastStatementMeta));
      } else {
        localStorage.removeItem('ais_portfolio_statement_meta_v1');
      }
    } catch (e) {
      console.warn('Failed saving statement metadata:', e);
    }
  }, [lastStatementMeta]);

  // Fetch live market quotes with exchange-aware European suffix mapping
  const refreshQuotes = useCallback(async () => {
    if (transactions.length === 0) return;
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
      const mark =
        positionMarks[und] ||
        Object.values(positionMarks).find((m) => m.underlying === und && (m.underlyingListingExchange || m.listingExchange));
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
          setQuotesFetchedAt(new Date().toISOString());
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

  // One-time lossless migration of any legacy journal keys (camp-stk-*, camp-*-LINKED) -> stable trade-cycle IDs
  useEffect(() => {
    if (portfolioState.unifiedTickers.length === 0) return;
    if (Object.keys(journalOverrides).length === 0) return;
    const { overrides: migrated, migratedCount } = migrateLegacyJournalOverrides(
      journalOverrides,
      portfolioState.unifiedTickers
    );
    if (migratedCount > 0) {
      setJournalOverrides(migrated);
    }
  }, [portfolioState.unifiedTickers, journalOverrides]);

  const endingCashInDisplayCurrency = useMemo(() => {
    if (cashByCurrency && Object.keys(cashByCurrency).length > 0) {
      return Object.entries(cashByCurrency).reduce(
        (sum, [cur, amt]) => sum + amt * getFxMultiplier(cur, baseCurrency, fxRates),
        0
      );
    }
    if (endingCashBase === undefined) return undefined;
    return endingCashBase * getFxMultiplier(endingCashCurrency, baseCurrency, fxRates);
  }, [cashByCurrency, endingCashBase, endingCashCurrency, baseCurrency, fxRates]);

  const cashSummaryInDisplayCurrency: BrokerCashSummary | undefined = useMemo(() => {
    if (
      endingCashBase === undefined &&
      depositsBase === undefined &&
      withdrawalsBase === undefined &&
      netDepositsBase === undefined &&
      !cashByCurrency
    ) {
      return undefined;
    }
    const fx = getFxMultiplier(endingCashCurrency, baseCurrency, fxRates);
    return {
      endingCashBase: endingCashInDisplayCurrency,
      depositsBase: depositsBase !== undefined ? depositsBase * fx : undefined,
      withdrawalsBase: withdrawalsBase !== undefined ? withdrawalsBase * fx : undefined,
      netDepositsBase: netDepositsBase !== undefined ? netDepositsBase * fx : undefined,
      cashByCurrency,
      currency: baseCurrency,
    };
  }, [
    endingCashBase,
    endingCashInDisplayCurrency,
    depositsBase,
    withdrawalsBase,
    netDepositsBase,
    cashByCurrency,
    endingCashCurrency,
    baseCurrency,
    fxRates,
  ]);

  const allocation = useMemo(() => {
    return computeCapitalAllocation(
      portfolioState.positions,
      portfolioState.standalonePositions,
      transactions,
      baseCurrency,
      fxRates,
      endingCashInDisplayCurrency,
      cashByCurrency,
      portfolioState.closedPositions
    );
  }, [
    portfolioState.positions,
    portfolioState.closedPositions,
    portfolioState.standalonePositions,
    transactions,
    baseCurrency,
    fxRates,
    endingCashInDisplayCurrency,
    cashByCurrency,
  ]);

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

  const handleMergeImport = (payload: ParsedImportPayload, sourceLabel: string): ImportMergeDiff => {
    const result = mergePortfolioImport(
      {
        transactions,
        fxRates,
        positionMarks,
        endingCashBase,
        endingCashCurrency,
        depositsBase,
        withdrawalsBase,
        netDepositsBase,
        cashByCurrency,
        bucketOverrides,
        journalOverrides,
        lastStatementMeta,
        baseCurrency,
        quotes,
      },
      payload,
      sourceLabel
    );

    const { nextState, diff, undoSnapshot } = result;
    setTransactions(nextState.transactions);
    setFxRates(nextState.fxRates);
    setPositionMarks(nextState.positionMarks);
    setEndingCashBase(nextState.endingCashBase);
    setEndingCashCurrency(nextState.endingCashCurrency);
    setDepositsBase(nextState.depositsBase);
    setWithdrawalsBase(nextState.withdrawalsBase);
    setNetDepositsBase(nextState.netDepositsBase);
    setCashByCurrency(nextState.cashByCurrency);
    setBucketOverrides(nextState.bucketOverrides);
    setJournalOverrides(nextState.journalOverrides);
    setLastStatementMeta(nextState.lastStatementMeta);
    setBaseCurrency(nextState.baseCurrency);
    setLastImportUndo(undoSnapshot);
    setLastImportDiff(diff);

    return diff;
  };

  const handleUndoLastImport = () => {
    if (!lastImportUndo) return;
    setTransactions(lastImportUndo.transactions);
    setFxRates(lastImportUndo.fxRates);
    setPositionMarks(lastImportUndo.positionMarks);
    setEndingCashBase(lastImportUndo.endingCashBase);
    setEndingCashCurrency(lastImportUndo.endingCashCurrency);
    setDepositsBase(lastImportUndo.depositsBase);
    setWithdrawalsBase(lastImportUndo.withdrawalsBase);
    setNetDepositsBase(lastImportUndo.netDepositsBase);
    setCashByCurrency(lastImportUndo.cashByCurrency);
    setBucketOverrides(lastImportUndo.bucketOverrides);
    setJournalOverrides(lastImportUndo.journalOverrides);
    setLastStatementMeta(lastImportUndo.lastStatementMeta);
    setLastImportUndo(null);
    setLastImportDiff(null);
  };

  const handleOpenJournalClosedTrade = (tradeId: string) => {
    setOptionalPanels((prev) => ({ ...prev, filteredJournal: true }));
    setFocusClosedTradeId(tradeId);
    setActiveTab('PORTFOLIO');
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
    setCashByCurrency(undefined);
    setLastStatementMeta(undefined);
    setLastImportDiff(null);
    setLastImportUndo(null);
    setQuotes({});
  };

  const handleExportJson = () => {
    const jsonStr = exportPortfolioToJson(
      transactions,
      bucketOverrides,
      baseCurrency,
      {
        endingCashBase: endingCashInDisplayCurrency,
        depositsBase: cashSummaryInDisplayCurrency?.depositsBase,
        withdrawalsBase: cashSummaryInDisplayCurrency?.withdrawalsBase,
        netDepositsBase: cashSummaryInDisplayCurrency?.netDepositsBase,
        cashByCurrency,
      },
      {
        overrides: journalOverrides,
        settings: journalSettings,
      },
      lastStatementMeta
    );
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
        setPositionMarks({});
        setEndingCashBase(res.endingCashBase);
        setDepositsBase(res.depositsBase);
        setWithdrawalsBase(res.withdrawalsBase);
        setNetDepositsBase(res.netDepositsBase);
        setCashByCurrency(res.cashByCurrency);
        setLastStatementMeta(res.lastStatementMeta);
        setLastImportDiff(null);
        setLastImportUndo(null);
        if (res.journalBackup?.overrides) {
          setJournalOverrides(res.journalBackup.overrides);
        }
        if (res.journalBackup?.settings) {
          setJournalSettings({ ...DEFAULT_JOURNAL_SETTINGS, ...res.journalBackup.settings });
        }
      } catch (err: any) {
        console.error('Failed reading file:', err.message);
      }
    };
    reader.readAsText(file);
  };

  const activeTickers = useMemo(
    () => portfolioState.unifiedTickers.filter((t) => t.isActive),
    [portfolioState.unifiedTickers]
  );

  const tapeTickers = useMemo(
    () => activeTickers.map((t) => t.ticker).slice(0, 8),
    [activeTickers]
  );

  return (
    <div className="min-h-screen bg-[#080d14] text-[#e2e8f0] flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-300">
      {/* 1. Header & Compact Spot Tape */}
      <Header
        baseCurrency={baseCurrency}
        onToggleCurrency={handleToggleCurrency}
        onRefreshQuotes={refreshQuotes}
        isRefreshing={isRefreshingQuotes}
        onOpenImport={() => setActiveTab('LEDGER')}
        onExportJson={handleExportJson}
        quotes={quotes}
        tapeTickers={tapeTickers}
        positions={portfolioState.positions}
        unifiedTickers={portfolioState.unifiedTickers}
        positionMarks={positionMarks}
      />

      {/* 2. Clean 2-Tab Navigation Bar */}
      <div className="bg-[#0a111b] border-b border-[#182638] px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <nav className="flex space-x-2 py-2 overflow-x-auto">
            <button
              onClick={() => setActiveTab('PORTFOLIO')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeTab === 'PORTFOLIO'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#121f31] border border-transparent'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5 text-emerald-400" />
              <span>Portfolio Matrix</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#16273c] text-slate-300">
                {activeTickers.length}
              </span>
            </button>

            <button
              onClick={() => setActiveTab('LEDGER')}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-mono font-medium transition-all ${
                activeTab === 'LEDGER'
                  ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 shadow-sm font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#121f31] border border-transparent'
              }`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-cyan-400" />
              <span>Trade Ledger &amp; Import</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[#16273c] text-slate-300">
                {transactions.length}
              </span>
            </button>
          </nav>

          <div className="hidden md:flex items-center gap-3 text-xs font-mono text-slate-400">
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

      {/* 3. Main Content Body */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-5">
        {activeTab === 'PORTFOLIO' ? (
          <>
            {/* Always-Visible Reconciled 5-KPI Command Strip */}
            {transactions.length > 0 && (
              <TopKpiStrip
                summary={portfolioState.summary}
                cashSummary={cashSummaryInDisplayCurrency}
                endingCashBase={endingCashInDisplayCurrency}
                allocation={allocation}
                baseCurrency={baseCurrency}
                activeTickerCount={activeTickers.length}
                totalTickerCount={portfolioState.unifiedTickers.length}
              />
            )}

            {/* Primary Unified Ticker Matrix + Expandable Campaign Comparison */}
            <UnifiedTickerMatrix
              tickers={portfolioState.unifiedTickers}
              baseCurrency={baseCurrency}
              panels={optionalPanels}
              onChangePanels={setOptionalPanels}
              onToggleCampaignBucket={handleToggleCampaignBucket}
              onToggleBucket={handleToggleBucket}
              onOpenImport={() => setActiveTab('LEDGER')}
            />

            {/* Optional Deep-Dive Panels (All OFF by Default) */}
            <OptionalDeepDivePanels
              panels={optionalPanels}
              positions={portfolioState.positions}
              closedPositions={portfolioState.closedPositions}
              standalonePositions={portfolioState.standalonePositions}
              unifiedTickers={portfolioState.unifiedTickers}
              transactions={transactions}
              quotes={quotes}
              quotesFetchedAt={quotesFetchedAt}
              fxRates={fxRates}
              positionMarks={positionMarks}
              baseCurrency={baseCurrency}
              netLiqValueBase={
                portfolioState.summary.totalMarketValue +
                (endingCashInDisplayCurrency ?? allocation.freeCashBuffer ?? 0)
              }
              onRefreshQuotes={refreshQuotes}
              journalOverrides={journalOverrides}
              onChangeJournalOverrides={setJournalOverrides}
              journalSettings={journalSettings}
              onChangeJournalSettings={setJournalSettings}
              focusClosedTradeId={focusClosedTradeId}
              onClearFocusTrade={() => setFocusClosedTradeId(null)}
            />
          </>
        ) : (
          <LedgerImportTab
            transactions={transactions}
            onMergeImport={handleMergeImport}
            onClearPortfolio={handleClearPortfolio}
            onExportJson={handleExportJson}
            onImportJsonFile={handleImportJsonFile}
            bucketOverrides={bucketOverrides}
            onToggleBucket={handleToggleBucket}
            baseCurrency={baseCurrency}
            lastStatementMeta={lastStatementMeta}
            lastImportDiff={lastImportDiff}
            onDismissImportDiff={() => setLastImportDiff(null)}
            canUndoImport={Boolean(lastImportUndo)}
            onUndoLastImport={handleUndoLastImport}
            journalOverrideCount={Object.keys(journalOverrides).length}
            onOpenJournalClosedTrade={handleOpenJournalClosedTrade}
          />
        )}
      </main>

      {/* 4. Minimalist Footer */}
      <footer className="border-t border-[#142030] bg-[#070c14] py-3 text-center text-xs font-mono text-slate-500">
        APEX // Unified Ticker Portfolio Tracker • Chronological Real Entry Price Engine • IBKR Flex XML / CSV Native
      </footer>
    </div>
  );
}
