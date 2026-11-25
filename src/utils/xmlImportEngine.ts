/**
 * Safe Incremental IBKR XML / CSV / JSON Import & Merge Engine
 *
 * Guarantees that future IBKR Flex XML drops update ledger & snapshot data
 * accurately without breaking, overwriting, or orphaning manual user entries:
 * - Lossless migration of legacy unstable campaign IDs -> stable flat-to-flat trade-cycle IDs
 * - Transaction deduplication + in-place broker-field upsert (preserving IDs & bucket overrides)
 * - Cross-source dividend/tax deduplication (ChangeInDividendAccrual <-> CashTransactions)
 * - Date-aware snapshot guard (older XMLs never downgrade live marks, cash, or FX)
 * - Partial-period deposit guard (rolling 30-day XMLs never wipe lifetime Net Deposited)
 * - Automatic newly-closed trade detection + stale manualPriceOverride cleanup
 * - Pre-import rollback snapshot for 1-click Undo
 */

import {
  Transaction,
  BucketType,
  PositionMark,
  StockQuote,
  JournalTradeOverride,
  UnifiedTickerSummary,
  CashTransferEvent,
  StatementSnapshotMeta,
  ImportMergeDiff,
  ImportNewlyClosedTrade,
  ImportUndoSnapshot,
} from '../types';
import { calculatePortfolioState } from './portfolioEngine';

export interface PortfolioImportState {
  transactions: Transaction[];
  fxRates: Record<string, number>;
  positionMarks: Record<string, PositionMark>;
  endingCashBase?: number;
  endingCashCurrency: 'EUR' | 'USD';
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  cashByCurrency?: Record<string, number>;
  bucketOverrides: Record<string, BucketType>;
  journalOverrides: Record<string, JournalTradeOverride>;
  lastStatementMeta?: StatementSnapshotMeta;
  baseCurrency: 'EUR' | 'USD';
  quotes: Record<string, StockQuote>;
}

export interface ParsedImportPayload {
  format: 'XML' | 'CSV' | 'JSON';
  transactions: Transaction[];
  bucketOverrides?: Record<string, BucketType>;
  fxRates?: Record<string, number>;
  positionMarks?: Record<string, PositionMark>;
  endingCashBase?: number;
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  cashByCurrency?: Record<string, number>;
  statementFromDate?: string;
  statementToDate?: string;
  whenGenerated?: string;
  cashTransfers?: CashTransferEvent[];
  journalBackup?: {
    overrides?: Record<string, JournalTradeOverride>;
    settings?: any;
  };
  lastStatementMeta?: StatementSnapshotMeta;
  sectionsFound: string[];
  baseCurrency?: 'EUR' | 'USD';
}

export interface PortfolioMergeResult {
  nextState: Omit<PortfolioImportState, 'quotes'>;
  diff: ImportMergeDiff;
  undoSnapshot: ImportUndoSnapshot;
}

function getMinMaxTxDates(txs: Transaction[]): { minDate?: string; maxDate?: string } {
  let minDate: string | undefined;
  let maxDate: string | undefined;
  for (const t of txs) {
    const d = (t.date || t.dateTime || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }
  return { minDate, maxDate };
}

function daysAbsDiff(dateA: string, dateB: string): number {
  const a = new Date(dateA.slice(0, 10) + 'T00:00:00Z').getTime();
  const b = new Date(dateB.slice(0, 10) + 'T00:00:00Z').getTime();
  if (isNaN(a) || isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((a - b) / 86400000));
}

function isRealBrokerTradeId(tx: Transaction): boolean {
  const tid = (tx.tradeId || '').trim();
  if (!tid || tid === tx.id) return false;
  if (
    tid.startsWith('tx-') ||
    tid.startsWith('div-') ||
    tid.startsWith('tax-') ||
    tid.startsWith('split-')
  ) {
    return false;
  }
  return true;
}

function buildBrokerTradeKey(tx: Transaction): string | null {
  if (!isRealBrokerTradeId(tx)) return null;
  return `${tx.assetCategory}|${tx.symbol}|${tx.tradeId}|${tx.quantity}`;
}

function isAccrualFallbackDividend(tx: Transaction): boolean {
  const tid = tx.tradeId || '';
  return tid.startsWith('div-') || tid.startsWith('tax-');
}

/**
 * Migrate any legacy unstable journal override keys (e.g. camp-stk-CAPR, camp-SYM-LINKED, standalone-SYM)
 * to their new stable flat-to-flat trade-cycle IDs without losing any user fields.
 */
export function migrateLegacyJournalOverrides(
  overrides: Record<string, JournalTradeOverride>,
  unifiedTickers: UnifiedTickerSummary[]
): { overrides: Record<string, JournalTradeOverride>; migratedCount: number } {
  const next: Record<string, JournalTradeOverride> = { ...overrides };
  let migratedCount = 0;

  for (const ut of unifiedTickers) {
    for (const camp of ut.campaigns) {
      if (camp.kind === 'DIVIDENDS') continue;
      if (!camp.legacyIds || camp.legacyIds.length === 0) continue;

      for (const legacyId of camp.legacyIds) {
        if (legacyId === camp.id) continue;
        const legacyData = next[legacyId];
        if (!legacyData) continue;

        if (!next[camp.id]) {
          next[camp.id] = { ...legacyData };
        } else {
          // Merge missing fields from legacy without overwriting newer stable-key edits
          next[camp.id] = { ...legacyData, ...next[camp.id] };
        }
        delete next[legacyId];
        migratedCount++;
      }
    }
  }

  return { overrides: next, migratedCount };
}

/**
 * Upsert richer broker fields from an incoming duplicate transaction into an existing ledger row
 * without modifying its deduplication ID or user bucket override.
 */
function enrichExistingTransaction(existing: Transaction, incoming: Transaction): { tx: Transaction; changed: boolean } {
  let changed = false;
  const updated: Transaction = { ...existing };

  if (!updated.openCloseIndicator && incoming.openCloseIndicator) {
    updated.openCloseIndicator = incoming.openCloseIndicator;
    changed = true;
  }
  if (updated.realizedPnl === undefined && incoming.realizedPnl !== undefined) {
    updated.realizedPnl = incoming.realizedPnl;
    changed = true;
  }
  if (!updated.listingExchange && incoming.listingExchange) {
    updated.listingExchange = incoming.listingExchange;
    changed = true;
  }
  if ((!updated.fxRateToBase || updated.fxRateToBase === 1) && incoming.fxRateToBase && incoming.fxRateToBase !== 1 && updated.currency !== 'EUR') {
    updated.fxRateToBase = incoming.fxRateToBase;
    changed = true;
  }
  if (!updated.optionDetails && incoming.optionDetails) {
    updated.optionDetails = incoming.optionDetails;
    changed = true;
  }
  if (incoming.notes && (!updated.notes || incoming.notes.length > updated.notes.length)) {
    updated.notes = incoming.notes;
    changed = true;
  }
  if (!isRealBrokerTradeId(updated) && isRealBrokerTradeId(incoming)) {
    updated.tradeId = incoming.tradeId;
    changed = true;
  }

  return { tx: updated, changed };
}

/**
 * Merge a parsed IBKR XML / CSV / JSON statement safely into the current portfolio state.
 * Pure function: produces nextState, structured ImportMergeDiff, and a 1-click ImportUndoSnapshot.
 */
export function mergePortfolioImport(
  current: PortfolioImportState,
  incoming: ParsedImportPayload,
  sourceLabel: string,
  now: Date = new Date()
): PortfolioMergeResult {
  // 1. Capture exact pre-import rollback snapshot
  const undoSnapshot: ImportUndoSnapshot = {
    createdAt: now.toISOString(),
    sourceLabel,
    transactions: current.transactions.map((t) => ({ ...t })),
    fxRates: { ...current.fxRates },
    positionMarks: { ...current.positionMarks },
    endingCashBase: current.endingCashBase,
    endingCashCurrency: current.endingCashCurrency,
    depositsBase: current.depositsBase,
    withdrawalsBase: current.withdrawalsBase,
    netDepositsBase: current.netDepositsBase,
    cashByCurrency: current.cashByCurrency ? { ...current.cashByCurrency } : undefined,
    bucketOverrides: { ...current.bucketOverrides },
    journalOverrides: Object.fromEntries(
      Object.entries(current.journalOverrides).map(([k, v]) => [k, { ...v }])
    ),
    lastStatementMeta: current.lastStatementMeta
      ? {
          ...current.lastStatementMeta,
          knownCashTransferIds: current.lastStatementMeta.knownCashTransferIds
            ? [...current.lastStatementMeta.knownCashTransferIds]
            : undefined,
        }
      : undefined,
  };

  // 2. Snapshot pre-import open campaigns so we can detect OPEN -> CLOSED transitions
  const beforePortfolio = calculatePortfolioState(
    current.transactions,
    current.bucketOverrides,
    current.quotes,
    current.baseCurrency,
    current.fxRates,
    current.positionMarks
  );
  const beforeOpenIds = new Set<string>();
  const beforeAllIds = new Set<string>();
  for (const ut of beforePortfolio.unifiedTickers) {
    for (const camp of ut.campaigns) {
      if (camp.kind === 'DIVIDENDS') continue;
      beforeAllIds.add(camp.id);
      camp.legacyIds?.forEach((lid) => beforeAllIds.add(lid));
      if (camp.status === 'OPEN') {
        beforeOpenIds.add(camp.id);
        camp.legacyIds?.forEach((lid) => beforeOpenIds.add(lid));
      }
    }
  }

  // 3. Merge & deduplicate transactions with broker-field upsert & cross-source dividend dedup
  const mergedTransactions: Transaction[] = current.transactions.map((t) => ({ ...t }));
  const indexById = new Map<string, number>();
  const indexByBrokerKey = new Map<string, number>();

  mergedTransactions.forEach((tx, idx) => {
    indexById.set(tx.id, idx);
    const bk = buildBrokerTradeKey(tx);
    if (bk) indexByBrokerKey.set(bk, idx);
  });

  let newTransactionsCount = 0;
  let duplicatesSkipped = 0;
  let enrichedUpdatedCount = 0;
  let crossSourceDividendsSkipped = 0;

  for (const inc of incoming.transactions) {
    // 3A. Exact ID match
    const existingIdxById = indexById.get(inc.id);
    if (existingIdxById !== undefined) {
      const { tx, changed } = enrichExistingTransaction(mergedTransactions[existingIdxById], inc);
      if (changed) {
        mergedTransactions[existingIdxById] = tx;
        enrichedUpdatedCount++;
      } else {
        duplicatesSkipped++;
      }
      continue;
    }

    // 3B. Broker tradeID match (handles CSV <-> XML migration where timestamp formatting differed)
    const bk = buildBrokerTradeKey(inc);
    if (bk && indexByBrokerKey.has(bk)) {
      const idx = indexByBrokerKey.get(bk)!;
      const { tx, changed } = enrichExistingTransaction(mergedTransactions[idx], inc);
      if (changed) {
        mergedTransactions[idx] = tx;
        enrichedUpdatedCount++;
      } else {
        duplicatesSkipped++;
      }
      continue;
    }

    // 3C. Cross-source Dividend / Withholding Tax dedup (ChangeInDividendAccrual <-> CashTransactions)
    if (inc.assetCategory === 'DIV' || inc.assetCategory === 'TAX') {
      const incAmt = Math.abs(inc.price || inc.netCashFlow || 0);
      const matchIdx = mergedTransactions.findIndex((ex) => {
        if (ex.assetCategory !== inc.assetCategory) return false;
        if (ex.underlying !== inc.underlying) return false;
        const exAmt = Math.abs(ex.price || ex.netCashFlow || 0);
        if (Math.abs(exAmt - incAmt) > 0.02) return false;
        return daysAbsDiff(ex.date, inc.date) <= 3;
      });

      if (matchIdx !== -1) {
        crossSourceDividendsSkipped++;
        // If existing was from accrual fallback and incoming is official CashTransactions, upgrade metadata in-place
        const existingDiv = mergedTransactions[matchIdx];
        if (isAccrualFallbackDividend(existingDiv) && !isAccrualFallbackDividend(inc)) {
          mergedTransactions[matchIdx] = {
            ...existingDiv,
            tradeId: inc.tradeId || existingDiv.tradeId,
            notes: inc.notes && inc.notes.length > (existingDiv.notes?.length || 0) ? inc.notes : existingDiv.notes,
          };
          enrichedUpdatedCount++;
        }
        continue;
      }
    }

    // 3D. Genuinely new transaction
    const nextIdx = mergedTransactions.length;
    mergedTransactions.push({ ...inc });
    indexById.set(inc.id, nextIdx);
    if (bk) indexByBrokerKey.set(bk, nextIdx);
    newTransactionsCount++;
  }

  mergedTransactions.sort(
    (a, b) => (new Date(a.dateTime).getTime() || 0) - (new Date(b.dateTime).getTime() || 0)
  );

  // Merge bucket overrides (user existing overrides always win over incoming defaults)
  const nextBucketOverrides: Record<string, BucketType> = {
    ...(incoming.bucketOverrides || {}),
    ...current.bucketOverrides,
  };

  // 4. Date-Aware Snapshot Guard & Partial-Period Deposit Protection
  const existingDates = getMinMaxTxDates(current.transactions);
  const incomingDates = getMinMaxTxDates(incoming.transactions);

  const prevSnapshotDate =
    current.lastStatementMeta?.toDate ||
    (Object.keys(current.positionMarks).length > 0 ? existingDates.maxDate : undefined);
  const incomingToDate =
    incoming.statementToDate ||
    incoming.lastStatementMeta?.toDate ||
    incomingDates.maxDate;
  const incomingFromDate =
    incoming.statementFromDate ||
    incoming.lastStatementMeta?.fromDate ||
    incomingDates.minDate;

  const isOlderStatement = Boolean(
    prevSnapshotDate && incomingToDate && incomingToDate < prevSnapshotDate
  );

  let nextFxRates = { ...current.fxRates };
  let nextPositionMarks = { ...current.positionMarks };
  let nextEndingCashBase = current.endingCashBase;
  let nextEndingCashCurrency = current.endingCashCurrency;
  let nextDepositsBase = current.depositsBase;
  let nextWithdrawalsBase = current.withdrawalsBase;
  let nextNetDepositsBase = current.netDepositsBase;
  let nextCashByCurrency = current.cashByCurrency ? { ...current.cashByCurrency } : undefined;
  let nextBaseCurrency = current.baseCurrency;
  let nextStatementMeta = current.lastStatementMeta;

  let snapshotUpdated = false;
  let snapshotGuardReason: string | undefined;
  let depositsPreservedReason: string | undefined;

  const knownTransferIds = new Set<string>(current.lastStatementMeta?.knownCashTransferIds || []);

  if (isOlderStatement) {
    snapshotUpdated = false;
    snapshotGuardReason = `Older statement (${incomingToDate} < ${prevSnapshotDate}): historical trades merged, while current marks, cash, and deposits were preserved.`;
  } else {
    snapshotUpdated = true;

    if (incoming.baseCurrency && current.transactions.length === 0) {
      nextBaseCurrency = incoming.baseCurrency;
    }
    if (incoming.fxRates && Object.keys(incoming.fxRates).length > 0) {
      nextFxRates = { ...nextFxRates, ...incoming.fxRates };
    }
    if (incoming.positionMarks && Object.keys(incoming.positionMarks).length > 0) {
      nextPositionMarks = { ...incoming.positionMarks };
    }
    if (incoming.endingCashBase !== undefined) {
      nextEndingCashBase = incoming.endingCashBase;
      if (incoming.baseCurrency) nextEndingCashCurrency = incoming.baseCurrency;
    }
    if (incoming.cashByCurrency && Object.keys(incoming.cashByCurrency).length > 0) {
      nextCashByCurrency = { ...incoming.cashByCurrency };
    }

    // Check if incoming XML is a partial-window drop (fromDate strictly later than earliest known ledger date)
    const isPartialPeriod = Boolean(
      current.netDepositsBase !== undefined &&
        incomingFromDate &&
        existingDates.minDate &&
        incomingFromDate > existingDates.minDate
    );

    if (isPartialPeriod) {
      // Protect lifetime Net Deposited; apply only newly-dated CashTransaction deposit/withdrawal deltas if present
      let appliedDelta = 0;
      let appliedCount = 0;
      if (incoming.cashTransfers && incoming.cashTransfers.length > 0) {
        for (const xfer of incoming.cashTransfers) {
          if (knownTransferIds.has(xfer.id)) continue;
          if (prevSnapshotDate && xfer.date <= prevSnapshotDate) {
            knownTransferIds.add(xfer.id);
            continue;
          }
          knownTransferIds.add(xfer.id);
          appliedDelta += xfer.amountBase;
          appliedCount++;
          if (xfer.amountBase > 0) {
            nextDepositsBase = (nextDepositsBase || 0) + xfer.amountBase;
          } else {
            nextWithdrawalsBase = (nextWithdrawalsBase || 0) + Math.abs(xfer.amountBase);
          }
          nextNetDepositsBase = (nextNetDepositsBase || 0) + xfer.amountBase;
        }
      }
      const curSym = nextEndingCashCurrency === 'EUR' ? '€' : '$';
      depositsPreservedReason =
        appliedCount > 0
          ? `Partial-period statement (from ${incomingFromDate}): lifetime Net Deposited preserved with ${appliedDelta >= 0 ? '+' : '-'}${curSym}${Math.abs(appliedDelta).toFixed(0)} from ${appliedCount} new transfer(s).`
          : `Partial-period statement (from ${incomingFromDate}): lifetime Net Deposited preserved (not overwritten by window subtotal).`;
    } else {
      // Full-history statement or first import: accept broker CashReport deposit totals
      if (incoming.depositsBase !== undefined) {
        nextDepositsBase = incoming.depositsBase;
        if (incoming.baseCurrency) nextEndingCashCurrency = incoming.baseCurrency;
      }
      if (incoming.withdrawalsBase !== undefined) {
        nextWithdrawalsBase = incoming.withdrawalsBase;
      }
      if (incoming.netDepositsBase !== undefined) {
        nextNetDepositsBase = incoming.netDepositsBase;
        if (incoming.baseCurrency) nextEndingCashCurrency = incoming.baseCurrency;
      }
      if (incoming.cashTransfers) {
        incoming.cashTransfers.forEach((x) => knownTransferIds.add(x.id));
      }
    }

    nextStatementMeta = {
      fromDate: incomingFromDate || current.lastStatementMeta?.fromDate,
      toDate: incomingToDate || current.lastStatementMeta?.toDate,
      whenGenerated: incoming.whenGenerated || current.lastStatementMeta?.whenGenerated,
      importedAt: now.toISOString(),
      sourceLabel,
      format: incoming.format,
      isFullHistory: !isPartialPeriod,
      knownCashTransferIds: Array.from(knownTransferIds),
    };
  }

  // 5. Recompute post-merge portfolio & migrate legacy journal overrides losslessly
  const afterPortfolio = calculatePortfolioState(
    mergedTransactions,
    nextBucketOverrides,
    current.quotes,
    nextBaseCurrency,
    nextFxRates,
    nextPositionMarks
  );

  // Merge any journal overrides from an incoming JSON backup (existing manual edits take precedence)
  const combinedJournalRaw: Record<string, JournalTradeOverride> = {
    ...(incoming.journalBackup?.overrides || {}),
    ...current.journalOverrides,
  };

  const migrated = migrateLegacyJournalOverrides(combinedJournalRaw, afterPortfolio.unifiedTickers);
  const nextJournalOverrides: Record<string, JournalTradeOverride> = { ...migrated.overrides };

  // 6. Detect newly closed trades, newly opened trades & clear stale manualPriceOverride entries
  const newlyClosedTrades: ImportNewlyClosedTrade[] = [];
  let newlyOpenedTradesCount = 0;
  let staleManualPricesCleared = 0;

  for (const ut of afterPortfolio.unifiedTickers) {
    for (const camp of ut.campaigns) {
      if (camp.kind === 'DIVIDENDS') continue;

      const wasOpen =
        beforeOpenIds.has(camp.id) ||
        Boolean(camp.legacyIds?.some((lid) => beforeOpenIds.has(lid)));
      const existedBefore =
        beforeAllIds.has(camp.id) ||
        Boolean(camp.legacyIds?.some((lid) => beforeAllIds.has(lid)));

      const ov = nextJournalOverrides[camp.id];

      if (camp.status === 'CLOSED' && wasOpen) {
        const needsLesson = !ov?.exitReason || !ov?.lesson?.trim();
        newlyClosedTrades.push({
          id: camp.id,
          ticker: ut.ticker,
          title: camp.title,
          instrument: camp.kind === 'STOCK_LOT' ? 'STOCK' : 'OPTION',
          needsLesson,
        });

        // Clear any open-position manual price override now that the broker closed the trade
        if (ov && ov.manualPriceOverride !== undefined) {
          const cleaned = { ...ov };
          delete cleaned.manualPriceOverride;
          delete cleaned.manualPriceTimestamp;
          nextJournalOverrides[camp.id] = cleaned;
          staleManualPricesCleared++;
        }
      } else if (camp.status === 'OPEN') {
        if (!existedBefore && current.transactions.length > 0) {
          newlyOpenedTradesCount++;
        }
        // Clear stale manual price override if a newer XML snapshot brought a fresh mark for this symbol
        if (snapshotUpdated && ov && ov.manualPriceOverride !== undefined) {
          const hasFreshMark =
            camp.kind === 'STOCK_LOT'
              ? Boolean(incoming.positionMarks?.[ut.ticker]?.markPrice)
              : Boolean(incoming.positionMarks?.[camp.contractSymbol]?.markPrice);
          const manualDate = ov.manualPriceTimestamp?.slice(0, 10);
          const markIsNewer = !manualDate || (incomingToDate ? incomingToDate >= manualDate : true);

          if (hasFreshMark && markIsNewer) {
            const cleaned = { ...ov };
            delete cleaned.manualPriceOverride;
            delete cleaned.manualPriceTimestamp;
            nextJournalOverrides[camp.id] = cleaned;
            staleManualPricesCleared++;
          }
        }
      }
    }
  }

  const manualOverridesPreserved =
    Object.keys(nextJournalOverrides).length + Object.keys(nextBucketOverrides).length;

  const diff: ImportMergeDiff = {
    sourceLabel,
    format: incoming.format,
    statementFromDate: incomingFromDate,
    statementToDate: incomingToDate,
    newTransactionsCount,
    duplicatesSkipped,
    enrichedUpdatedCount,
    crossSourceDividendsSkipped,
    snapshotUpdated,
    snapshotGuardReason,
    depositsPreservedReason,
    newlyClosedTrades,
    newlyOpenedTradesCount,
    staleManualPricesCleared,
    manualOverridesPreserved,
    migratedOverridesCount: migrated.migratedCount,
    sectionsFound: incoming.sectionsFound,
  };

  return {
    nextState: {
      transactions: mergedTransactions,
      fxRates: nextFxRates,
      positionMarks: nextPositionMarks,
      endingCashBase: nextEndingCashBase,
      endingCashCurrency: nextEndingCashCurrency,
      depositsBase: nextDepositsBase,
      withdrawalsBase: nextWithdrawalsBase,
      netDepositsBase: nextNetDepositsBase,
      cashByCurrency: nextCashByCurrency,
      bucketOverrides: nextBucketOverrides,
      journalOverrides: nextJournalOverrides,
      lastStatementMeta: nextStatementMeta,
      baseCurrency: nextBaseCurrency,
    },
    diff,
    undoSnapshot,
  };
}
