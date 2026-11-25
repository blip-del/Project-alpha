import {
  StockQuote,
  SecTickerFilings,
  JournalTradeIntel,
  JournalPostMortemReview,
  JournalDerivedTrade,
} from '../types';

export async function fetchPortfolioQuotes(symbols: string[]): Promise<Record<string, StockQuote>> {
  if (!symbols || symbols.length === 0) return {};
  try {
    const cleanSyms = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)));
    const res = await fetch(`/api/portfolio-quotes?symbols=${encodeURIComponent(cleanSyms.join(','))}`);
    if (!res.ok) return {};
    const data = await res.json();
    return data.quotes || {};
  } catch (err) {
    console.warn('fetchPortfolioQuotes error:', err);
    return {};
  }
}

export async function fetchSecFilings(
  tickers: string[],
  forceRefresh = false
): Promise<{ fetchedAt: string; filingsByTicker: Record<string, SecTickerFilings> }> {
  const empty = { fetchedAt: new Date().toISOString(), filingsByTicker: {} };
  if (!tickers || tickers.length === 0) return empty;
  try {
    const clean = Array.from(
      new Set(
        tickers
          .map((t) => t.trim().toUpperCase())
          .filter((t) => /^[A-Z0-9.\-]{1,10}$/.test(t))
      )
    );
    if (clean.length === 0) return empty;
    const qs = `tickers=${encodeURIComponent(clean.join(','))}${forceRefresh ? '&refresh=1' : ''}`;
    const res = await fetch(`/api/sec-filings?${qs}`);
    if (!res.ok) return empty;
    const data = await res.json();
    return {
      fetchedAt: data.fetchedAt || new Date().toISOString(),
      filingsByTicker: data.filingsByTicker || {},
    };
  } catch (err) {
    console.warn('fetchSecFilings error:', err);
    return empty;
  }
}

export interface AnalyzeJournalTradePayload {
  ticker: string;
  companyName: string;
  instrument: 'STOCK' | 'OPTION';
  status: 'OPEN' | 'CLOSED';
  entryDate?: string;
  exitDate?: string;
  expiry?: string;
  thesis?: string;
  catalystType?: string;
  catalystDate?: string;
  manualFilingNote?: string;
  forceRefresh?: boolean;
}

export async function analyzeJournalTrade(
  payload: AnalyzeJournalTradePayload
): Promise<JournalTradeIntel> {
  const res = await fetch('/api/journal-intel/analyze-trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.intel) {
    throw new Error(data?.error || `AI analysis failed (HTTP ${res.status})`);
  }
  return data.intel as JournalTradeIntel;
}

export async function runJournalPostMortem(
  closedTrades: JournalDerivedTrade[]
): Promise<JournalPostMortemReview> {
  const res = await fetch('/api/journal-intel/post-mortem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      closedTrades: closedTrades.map((t) => ({
        ticker: t.ticker,
        instrument: t.instrument,
        catalystType: t.catalystType,
        holdingDays: t.holdingDays,
        currentR: t.currentR,
        pnlBase: t.pnlBase,
        exitReason: t.exitReason || 'unlogged',
        thesis: t.thesis || '',
        lesson: t.lesson || '',
        entryDate: t.entryDate,
        exitDate: t.exitDate || '',
        hasInsiderCluster: t.hasInsiderCluster,
      })),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.review) {
    throw new Error(data?.error || `AI post-mortem failed (HTTP ${res.status})`);
  }
  return data.review as JournalPostMortemReview;
}

export async function fetchTickerQuote(ticker: string): Promise<StockQuote | null> {
  const clean = ticker.trim().toUpperCase();
  try {
    const quotes = await fetchPortfolioQuotes([clean]);
    return quotes[clean] || null;
  } catch {
    return null;
  }
}

export async function searchTickers(query: string) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}
