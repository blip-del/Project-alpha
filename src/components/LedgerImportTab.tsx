import React, { useState, useRef } from 'react';
import {
  Upload,
  Download,
  Trash2,
  Search,
  Filter,
  CheckCircle,
  AlertTriangle,
  FileText,
  Link2,
  Zap,
  ArrowUpDown,
  FileCode,
  ShieldCheck,
  Copy,
  Check,
  ClipboardPaste,
} from 'lucide-react';
import { Transaction, AssetCategory, BucketType, PositionMark } from '../types';
import { parseUniversalIBKRInput, AI_EXTRACTION_PROMPT } from '../utils/ibkrParser';

interface LedgerImportTabProps {
  transactions: Transaction[];
  onImportTransactions: (
    newTransactions: Transaction[],
    baseCurrency?: 'EUR' | 'USD',
    meta?: {
      fxRates?: Record<string, number>;
      positionMarks?: Record<string, PositionMark>;
      endingCashBase?: number;
      depositsBase?: number;
      withdrawalsBase?: number;
      netDepositsBase?: number;
      cashByCurrency?: Record<string, number>;
    }
  ) => void;
  onClearPortfolio: () => void;
  onExportJson: () => void;
  onImportJsonFile: (file: File) => void;
  bucketOverrides: Record<string, BucketType>;
  onToggleBucket: (transactionId: string) => void;
  baseCurrency: 'EUR' | 'USD';
}

export const LedgerImportTab: React.FC<LedgerImportTabProps> = ({
  transactions,
  onImportTransactions,
  onClearPortfolio,
  onExportJson,
  onImportJsonFile,
  bucketOverrides,
  onToggleBucket,
  baseCurrency,
}) => {
  const [dragActive, setDragActive] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [bucketFilter, setBucketFilter] = useState<string>('ALL');
  const [tickerFilter, setTickerFilter] = useState<string>('ALL');
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [pastedText, setPastedText] = useState('');
  const [promptCopied, setPromptCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const currencySymbol = baseCurrency === 'EUR' ? '€' : '$';

  const [confirmClear, setConfirmClear] = useState(false);

  const processRawText = (text: string, sourceLabel: string) => {
    if (!text || !text.trim()) {
      setImportNotice('⚠️ Input is empty.');
      return;
    }

    const existingIds = new Set(transactions.map((t) => t.id));
    const res = parseUniversalIBKRInput(text, existingIds);

    if (res.errors.length > 0 && res.transactions.length === 0) {
      setImportNotice(`❌ Error parsing ${res.format} (${sourceLabel}): ${res.errors[0]}`);
      return;
    }

    if (res.transactions.length === 0 && res.duplicatesSkipped === 0) {
      setImportNotice(
        `⚠️ No eligible transactions found in ${res.format} (${sourceLabel}). Check that Trades, Dividends, or JSON transactions are included.`
      );
      return;
    }

    onImportTransactions(res.transactions, res.baseCurrency, {
      fxRates: res.fxRates,
      positionMarks: res.positionMarks,
      endingCashBase: res.endingCashBase,
      depositsBase: res.depositsBase,
      withdrawalsBase: res.withdrawalsBase,
      netDepositsBase: res.netDepositsBase,
      cashByCurrency: res.cashByCurrency,
    });
    setImportNotice(
      `✅ [${res.format}] Imported ${res.transactions.length} transactions (${res.duplicatesSkipped} duplicates skipped). Sections: ${res.sectionsFound.slice(0, 4).join(', ')}.`
    );
  };

  // Handle CSV / XML / JSON file read via FileReader
  const handleStatementFile = (file: File) => {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        processRawText(text, file.name);
      } catch (err: any) {
        setImportNotice(`❌ Error reading file: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  const handleImportPasted = () => {
    processRawText(pastedText, 'Pasted Data');
    setPastedText('');
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(AI_EXTRACTION_PROMPT);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2500);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleStatementFile(e.dataTransfer.files[0]);
    }
  };

  // Distinct tickers in transactions for filtering
  const distinctTickers = Array.from(new Set(transactions.map((t) => t.underlying || t.symbol))).filter(Boolean);

  // Filter transactions
  const filtered = transactions.filter((tx) => {
    const sym = (tx.symbol || '').toLowerCase();
    const und = (tx.underlying || '').toLowerCase();
    const desc = (tx.notes || '').toLowerCase();
    const q = searchQuery.toLowerCase();

    const matchesSearch = !q || sym.includes(q) || und.includes(q) || desc.includes(q);
    if (!matchesSearch) return false;

    if (categoryFilter !== 'ALL' && tx.assetCategory !== categoryFilter) return false;
    if (bucketFilter !== 'ALL' && tx.bucket !== bucketFilter) return false;
    if (tickerFilter !== 'ALL' && tx.underlying !== tickerFilter) return false;

    return true;
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* ------------------------------------------------------------- */}
      {/* SECTION 1: OFFLINE IBKR UNIVERSAL IMPORTER & TOOLBAR */}
      {/* ------------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Drag and drop dropzone */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all flex flex-col items-center justify-center min-h-[160px] ${
              dragActive
                ? 'border-emerald-400 bg-emerald-500/10'
                : 'border-[#1e2f44] hover:border-emerald-500/40 bg-[#0d1520]'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xml,.json,.txt"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleStatementFile(e.target.files[0]);
                }
              }}
            />

            <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mb-2.5">
              <Upload className="w-6 h-6" />
            </div>

            <h4 className="text-sm font-bold text-white font-sans">
              Drop IBKR Flex XML, Activity CSV, or AI-Converted JSON
            </h4>
            <p className="text-xs text-slate-400 font-mono mt-1 max-w-lg">
              Supports <span className="text-emerald-300">.xml</span> (IBKR Flex Queries), <span className="text-cyan-300">.csv</span> (Activity Statements), and <span className="text-purple-300">.json</span> (AI output or backup). Runs 100% offline with automatic deduplication.
            </p>

            <span className="mt-2 text-[11px] font-mono text-emerald-400 underline">
              or click to browse (.xml, .csv, .json, .txt)
            </span>
          </div>

          {/* Quick Paste & AI Prompt Bar */}
          <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
              <ClipboardPaste className="w-4 h-4 text-cyan-400" />
              <span>Have a PDF/Text statement? Convert with another AI &amp; paste JSON directly:</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyPrompt}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#132236] hover:bg-[#1a2d44] border border-[#233a57] text-xs font-mono text-cyan-300 transition-colors"
              >
                {promptCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{promptCopied ? 'Prompt Copied!' : 'Copy AI JSON Prompt'}</span>
              </button>
              <button
                onClick={() => setShowPasteBox((v) => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 text-xs font-mono text-emerald-300 transition-colors font-semibold"
              >
                <ClipboardPaste className="w-3.5 h-3.5" />
                <span>{showPasteBox ? 'Hide Paste Box' : 'Paste JSON / XML / CSV'}</span>
              </button>
            </div>
          </div>

          {showPasteBox && (
            <div className="bg-[#0d1520] border border-emerald-500/30 rounded-xl p-4 space-y-3 animate-in fade-in duration-150">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-emerald-300 font-semibold">
                  Paste Raw JSON, IBKR Flex XML, or CSV Text
                </span>
                <span className="text-slate-500">Auto-detects format &amp; deduplicates</span>
              </div>
              <textarea
                value={pastedText}
                onChange={(e) => setPastedText(e.target.value)}
                rows={6}
                placeholder='Paste {"baseCurrency": "EUR", "transactions": [...]} or <FlexQueryResponse>...</FlexQueryResponse>'
                className="w-full bg-[#070c13] border border-[#1e2f44] rounded-lg p-3 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setPastedText('')}
                  className="px-3 py-1.5 rounded-lg bg-[#0b131e] border border-[#1e2f44] text-xs font-mono text-slate-400 hover:text-slate-200"
                >
                  Clear
                </button>
                <button
                  onClick={handleImportPasted}
                  disabled={!pastedText.trim()}
                  className="px-4 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-xs font-mono font-bold text-emerald-300 disabled:opacity-40 transition-colors"
                >
                  Import Pasted Data
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Action quick buttons */}
        <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 flex flex-col justify-between space-y-3">
          <div>
            <h4 className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider mb-2">
              Portfolio State &amp; Backups
            </h4>
            <p className="text-[11px] text-slate-400 font-mono mb-3">
              Export your full portfolio with bucket overrides or restore a saved JSON backup.
            </p>

            <div className="space-y-2">
              {/* Export JSON */}
              <button
                onClick={onExportJson}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#132236] hover:bg-[#1a2d44] border border-[#233a57] text-slate-200 text-xs font-mono transition-colors"
              >
                <Download className="w-4 h-4 text-cyan-400" />
                <span>Export JSON Backup</span>
              </button>

              {/* Import JSON Backup */}
              <input
                ref={jsonInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    onImportJsonFile(e.target.files[0]);
                  }
                }}
              />
              <button
                onClick={() => jsonInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#0e1927] hover:bg-[#152336] border border-[#1d2f47] text-slate-300 text-xs font-mono transition-colors"
              >
                <FileCode className="w-4 h-4 text-purple-400" />
                <span>Restore JSON Backup</span>
              </button>
            </div>
          </div>

          <button
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                setTimeout(() => setConfirmClear(false), 4000);
                return;
              }
              onClearPortfolio();
              setConfirmClear(false);
              setImportNotice('Portfolio cleared.');
            }}
            className={`w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-[11px] font-mono transition-colors ${
              confirmClear
                ? 'bg-rose-500/30 hover:bg-rose-500/40 text-white border-rose-500 font-bold'
                : 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border-rose-500/30'
            }`}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{confirmClear ? 'Click Again to Confirm Clear' : 'Clear Portfolio'}</span>
          </button>
        </div>
      </div>

      {/* Notice alert */}
      {importNotice && (
        <div className="bg-[#0d1a29] border border-cyan-500/40 rounded-xl p-3.5 flex items-center justify-between text-xs font-mono text-cyan-200 animate-in fade-in">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{importNotice}</span>
          </div>
          <button
            onClick={() => setImportNotice(null)}
            className="text-slate-400 hover:text-white text-xs px-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* SECTION 2: TRANSACTION LEDGER TABLE WITH FILTERS & BUCKET PILLS */}
      {/* ------------------------------------------------------------- */}
      <div className="bg-[#0d1520] border border-[#1c2838] rounded-xl p-5 shadow-sm space-y-4">
        {/* Ledger Header & Filters */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#182638] pb-4">
          <div>
            <h3 className="text-sm font-bold text-white font-sans flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400" />
              Interactive Brokers Transaction Ledger
            </h3>
            <p className="text-xs text-slate-400 font-mono mt-0.5">
              Showing {filtered.length} of {transactions.length} transactions chronologically.
            </p>
          </div>

          {/* Filter bars */}
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
            {/* Search */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5 pointer-events-none" />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-[#080d14] border border-[#1e2f44] rounded-lg pl-8 pr-3 py-1 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>

            {/* Asset Category Filter */}
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="bg-[#080d14] border border-[#1e2f44] rounded-lg px-2.5 py-1 text-xs text-slate-300 focus:outline-none"
            >
              <option value="ALL">All Categories</option>
              <option value="STK">Stocks (STK)</option>
              <option value="OPT">Options (OPT)</option>
              <option value="DIV">Dividends (DIV)</option>
              <option value="TAX">Withholding Tax (TAX)</option>
              <option value="CORP_ACTION">Splits / Corp</option>
            </select>

            {/* Bucket Filter */}
            <select
              value={bucketFilter}
              onChange={(e) => setBucketFilter(e.target.value)}
              className="bg-[#080d14] border border-[#1e2f44] rounded-lg px-2.5 py-1 text-xs text-slate-300 focus:outline-none"
            >
              <option value="ALL">All Buckets</option>
              <option value="LINKED">Bucket A: [🔗 Linked]</option>
              <option value="STANDALONE">Bucket B: [⚡ Standalone]</option>
            </select>

            {/* Ticker Filter */}
            <select
              value={tickerFilter}
              onChange={(e) => setTickerFilter(e.target.value)}
              className="bg-[#080d14] border border-[#1e2f44] rounded-lg px-2.5 py-1 text-xs text-slate-300 focus:outline-none"
            >
              <option value="ALL">All Tickers</option>
              {distinctTickers.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Transactions Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead>
              <tr className="border-b border-[#182638] text-slate-400 text-[10px] uppercase tracking-wider">
                <th className="pb-2.5">Date &amp; Time</th>
                <th className="pb-2.5">Underlying</th>
                <th className="pb-2.5">Symbol / Contract</th>
                <th className="pb-2.5">Category</th>
                <th className="pb-2.5">Action</th>
                <th className="pb-2.5 text-right">Qty</th>
                <th className="pb-2.5 text-right">Price</th>
                <th className="pb-2.5 text-right">Net Cash Impact</th>
                <th className="pb-2.5 text-center">Currency</th>
                <th className="pb-2.5 text-center">Bucket Override</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#131f2f]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400 font-mono text-xs">
                    {transactions.length === 0
                      ? 'No transactions loaded yet. Upload an IBKR Flex XML, Activity CSV, or JSON statement above to initialize your ledger.'
                      : 'No transactions match the current search or filter criteria.'}
                  </td>
                </tr>
              ) : filtered.map((tx) => {
                const isLinked = tx.bucket === 'LINKED';
                const isOption = tx.assetCategory === 'OPT';

                return (
                  <tr key={tx.id} className="hover:bg-[#0a121c] transition-colors">
                    <td className="py-2.5 text-slate-400 text-[11px] whitespace-nowrap">
                      {tx.dateTime}
                    </td>
                    <td className="py-2.5 font-bold text-white">
                      {tx.underlying}
                    </td>
                    <td className="py-2.5 text-slate-300 font-medium truncate max-w-[200px]" title={tx.symbol}>
                      {tx.symbol}
                    </td>
                    <td className="py-2.5">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#111e2e] text-slate-300 border border-[#1d3047]">
                        {tx.assetCategory}
                      </span>
                    </td>
                    <td className="py-2.5">
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          tx.action === 'BUY'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : tx.action === 'SELL'
                            ? 'bg-rose-500/10 text-rose-400'
                            : tx.action === 'DIV'
                            ? 'bg-cyan-500/10 text-cyan-400'
                            : tx.action === 'TAX'
                            ? 'bg-amber-500/10 text-amber-400'
                            : 'bg-purple-500/10 text-purple-400'
                        }`}
                      >
                        {tx.action}
                      </span>
                    </td>
                    <td className="py-2.5 text-right font-medium text-slate-200">
                      {tx.assetCategory === 'CORP_ACTION' ? `${tx.quantity}:1` : tx.quantity}
                    </td>
                    <td className="py-2.5 text-right text-slate-300">
                      {tx.price !== 0 ? `${tx.currency === 'EUR' ? '€' : '$'}${Math.abs(tx.price).toFixed(tx.price < 2 ? 3 : 2)}` : '-'}
                    </td>
                    <td className="py-2.5 text-right font-bold">
                      <span className={tx.netCashFlow >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {tx.netCashFlow >= 0 ? '+' : '-'}{tx.currency === 'EUR' ? '€' : '$'}{Math.abs(tx.netCashFlow).toFixed(2)}
                      </span>
                    </td>
                    <td className="py-2.5 text-center text-slate-400 text-[11px]">
                      {tx.currency}
                    </td>
                    <td className="py-2.5 text-center">
                      {/* 1-Click Bucket Toggle Pill */}
                      {isOption ? (
                        <button
                          onClick={() => onToggleBucket(tx.id)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border transition-all ${
                            isLinked
                              ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
                              : 'bg-cyan-500/15 hover:bg-cyan-500/25 border-cyan-500/40 text-cyan-300'
                          }`}
                          title="Click to toggle between Bucket A (Linked to Basis) and Bucket B (Standalone Trade)"
                        >
                          {isLinked ? (
                            <>
                              <Link2 className="w-2.5 h-2.5 text-emerald-400" />
                              <span>[🔗 Linked]</span>
                            </>
                          ) : (
                            <>
                              <Zap className="w-2.5 h-2.5 text-cyan-400" />
                              <span>[⚡ Standalone]</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-500 font-mono">
                          [🔗 Basis]
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
