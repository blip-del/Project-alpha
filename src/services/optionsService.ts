import { StockQuote } from '../types';

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
