import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import {
  stripSecXsltPrefix,
  parseForm4Xml,
  extractPlainTextFromFiling,
  sanitizeExternalUrl,
} from "./src/utils/secForm4Parser";

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory cache for options data (TTL: 90 seconds)
interface CacheEntry {
  timestamp: number;
  data: any;
}
const optionsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 90 * 1000;

// Yahoo Finance authenticated session (cookie + crumb)
let yahooSession = {
  cookie: "",
  crumb: "",
  timestamp: 0,
};
const YSESSION_TTL_MS = 60 * 60 * 1000; // refresh session every 1 hour

async function getYahooSession(): Promise<{ cookie: string; crumb: string }> {
  const now = Date.now();
  if (yahooSession.cookie && yahooSession.crumb && (now - yahooSession.timestamp) < YSESSION_TTL_MS) {
    return { cookie: yahooSession.cookie, crumb: yahooSession.crumb };
  }

  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  try {
    // 1. Get A3 session cookie from fc.yahoo.com
    const fcRes = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": userAgent }
    });
    const setCookie = fcRes.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0];

    // 2. Obtain crumb with this cookie
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": userAgent,
        "Cookie": cookie,
      }
    });

    if (crumbRes.ok) {
      const crumb = await crumbRes.text();
      if (crumb && !crumb.includes("<html>") && !crumb.includes("404")) {
        yahooSession = { cookie, crumb: crumb.trim(), timestamp: now };
        console.log("Yahoo Finance authentication initialized with live crumb:", crumb.trim());
        return { cookie, crumb: crumb.trim() };
      }
    }
  } catch (err) {
    console.warn("Failed to obtain Yahoo session crumb:", err);
  }

  return { cookie: yahooSession.cookie, crumb: yahooSession.crumb };
}

// Standard Normal CDF for Black-Scholes calculation
function normalCdf(x: number): number {
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;
  const p = 0.2316419;
  const c = 0.39894228;

  if (x >= 0.0) {
    const k = 1.0 / (1.0 + p * x);
    return 1.0 - c * Math.exp(-x * x / 2.0) * k *
      (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5))));
  } else {
    const k = 1.0 / (1.0 - p * x);
    return c * Math.exp(-x * x / 2.0) * k *
      (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5))));
  }
}

// Normal probability density function
function normalPdf(x: number): number {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

// Calculate Black-Scholes Greeks
function calculateGreeks(
  isCall: boolean,
  S: number, // underlying price
  K: number, // strike price
  T: number, // time in years (DTE / 365)
  r: number, // risk-free rate (approx 0.045)
  sigma: number // implied volatility (e.g. 0.35)
) {
  if (T <= 0 || sigma <= 0.001 || S <= 0 || K <= 0) {
    const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
    const delta = isCall ? (S > K ? 1.0 : 0.0) : (S < K ? -1.0 : 0.0);
    return { delta, gamma: 0, theta: 0, vega: 0, theoreticalPrice: intrinsic };
  }

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  let delta: number;
  let theoreticalPrice: number;
  if (isCall) {
    delta = normalCdf(d1);
    theoreticalPrice = S * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
  } else {
    delta = normalCdf(d1) - 1;
    theoreticalPrice = K * Math.exp(-r * T) * normalCdf(-d2) - S * normalCdf(-d1);
  }

  const gamma = normalPdf(d1) / (S * sigma * Math.sqrt(T));
  const vega = (S * normalPdf(d1) * Math.sqrt(T)) / 100; // 1% change in IV

  let theta: number;
  if (isCall) {
    theta = (- (S * normalPdf(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normalCdf(d2)) / 365;
  } else {
    theta = (- (S * normalPdf(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normalCdf(-d2)) / 365;
  }

  return {
    delta: Number(delta.toFixed(4)),
    gamma: Number(gamma.toFixed(4)),
    theta: Number(theta.toFixed(4)),
    vega: Number(vega.toFixed(4)),
    theoreticalPrice: Number(Math.max(0.01, theoreticalPrice).toFixed(2)),
  };
}

// Fallback data generator for high-reliability demo mode when Yahoo Finance is unreachable
function generateFallbackOptionChain(ticker: string, targetDateTimestamp?: number) {
  const symbol = ticker.toUpperCase();
  const basePrices: Record<string, { price: number; name: string; iv: number }> = {
    NVDA: { price: 217.49, name: "NVIDIA Corporation", iv: 0.36 },
    AAPL: { price: 232.15, name: "Apple Inc.", iv: 0.22 },
    TSLA: { price: 248.80, name: "Tesla, Inc.", iv: 0.48 },
    SPY: { price: 565.40, name: "SPDR S&P 500 ETF Trust", iv: 0.14 },
    MSFT: { price: 428.60, name: "Microsoft Corporation", iv: 0.24 },
    ORCL: { price: 150.06, name: "Oracle Corporation", iv: 0.32 },
    AMD: { price: 156.30, name: "Advanced Micro Devices, Inc.", iv: 0.41 },
    AMZN: { price: 188.50, name: "Amazon.com, Inc.", iv: 0.28 },
    META: { price: 520.10, name: "Meta Platforms, Inc.", iv: 0.33 },
    ASML: { price: 785.40, name: "ASML Holding N.V.", iv: 0.31 },
    SAP: { price: 198.60, name: "SAP SE", iv: 0.20 },
    QQQ: { price: 485.20, name: "Invesco QQQ Trust", iv: 0.18 },
  };

  const info = basePrices[symbol] || {
    price: 150.0,
    name: `${symbol} Equity`,
    iv: 0.30,
  };

  const S = info.price;
  const now = new Date();
  
  // Generate realistic expiration dates (weekly and monthly)
  const expirationDates: number[] = [];
  for (let days of [7, 14, 21, 30, 45, 60, 90, 120, 180, 365]) {
    const expDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    // set to Friday 4 PM UTC
    const dayOfWeek = expDate.getDay();
    const diff = (5 - dayOfWeek + 7) % 7;
    expDate.setDate(expDate.getDate() + diff);
    expDate.setHours(20, 0, 0, 0);
    const ts = Math.floor(expDate.getTime() / 1000);
    if (!expirationDates.includes(ts)) {
      expirationDates.push(ts);
    }
  }
  expirationDates.sort((a, b) => a - b);

  const selectedTimestamp = targetDateTimestamp && expirationDates.includes(targetDateTimestamp)
    ? targetDateTimestamp
    : expirationDates[3] || expirationDates[0];

  const nowSec = Math.floor(Date.now() / 1000);
  const dte = Math.max(1, Math.round((selectedTimestamp - nowSec) / 86400));
  const T = dte / 365;

  // Generate strike prices around S
  const step = S > 200 ? 5 : S > 50 ? 2.5 : 1;
  const minStrike = Math.floor((S * 0.8) / step) * step;
  const maxStrike = Math.ceil((S * 1.2) / step) * step;

  const strikes: number[] = [];
  for (let k = minStrike; k <= maxStrike; k += step) {
    strikes.push(Number(k.toFixed(2)));
  }

  const calls: any[] = [];
  const puts: any[] = [];

  strikes.forEach((K) => {
    // Volatility smile: IV increases for OTM strikes
    const moneyness = Math.log(K / S);
    const smileIv = info.iv + 0.15 * Math.pow(moneyness, 2);

    const callGreeks = calculateGreeks(true, S, K, T, 0.045, smileIv);
    const putGreeks = calculateGreeks(false, S, K, T, 0.045, smileIv);

    const callMid = Math.max(0.05, callGreeks.theoreticalPrice);
    const putMid = Math.max(0.05, putGreeks.theoreticalPrice);
    const spread = Math.max(0.05, Number((callMid * 0.03).toFixed(2)));

    // Generate call contract
    calls.push({
      contractSymbol: `${symbol}${new Date(selectedTimestamp * 1000).toISOString().slice(2, 10).replace(/-/g, "")}C${String(Math.round(K * 1000)).padStart(8, "0")}`,
      strike: K,
      currency: "USD",
      lastPrice: Number((callMid + (Math.random() * 0.1 - 0.05)).toFixed(2)),
      change: Number(((Math.random() - 0.5) * 0.8).toFixed(2)),
      percentChange: Number(((Math.random() - 0.5) * 8).toFixed(2)),
      volume: Math.floor(100 + Math.random() * 4500),
      openInterest: Math.floor(500 + Math.random() * 9500),
      bid: Number(Math.max(0.01, callMid - spread / 2).toFixed(2)),
      ask: Number((callMid + spread / 2).toFixed(2)),
      impliedVolatility: Number((smileIv * 100).toFixed(1)),
      inTheMoney: S > K,
      delta: callGreeks.delta,
      gamma: callGreeks.gamma,
      theta: callGreeks.theta,
      vega: callGreeks.vega,
    });

    // Generate put contract
    puts.push({
      contractSymbol: `${symbol}${new Date(selectedTimestamp * 1000).toISOString().slice(2, 10).replace(/-/g, "")}P${String(Math.round(K * 1000)).padStart(8, "0")}`,
      strike: K,
      currency: "USD",
      lastPrice: Number((putMid + (Math.random() * 0.1 - 0.05)).toFixed(2)),
      change: Number(((Math.random() - 0.5) * 0.8).toFixed(2)),
      percentChange: Number(((Math.random() - 0.5) * 8).toFixed(2)),
      volume: Math.floor(80 + Math.random() * 3800),
      openInterest: Math.floor(400 + Math.random() * 8500),
      bid: Number(Math.max(0.01, putMid - spread / 2).toFixed(2)),
      ask: Number((putMid + spread / 2).toFixed(2)),
      impliedVolatility: Number((smileIv * 100).toFixed(1)),
      inTheMoney: S < K,
      delta: putGreeks.delta,
      gamma: putGreeks.gamma,
      theta: putGreeks.theta,
      vega: putGreeks.vega,
    });
  });

  return {
    symbol,
    quote: {
      symbol,
      shortName: info.name,
      regularMarketPrice: S,
      regularMarketChange: 0.85,
      regularMarketChangePercent: 0.39,
      regularMarketDayHigh: Number((S * 1.015).toFixed(2)),
      regularMarketDayLow: Number((S * 0.985).toFixed(2)),
      regularMarketVolume: 42500000,
      fiftyTwoWeekHigh: Number((S * 1.25).toFixed(2)),
      fiftyTwoWeekLow: Number((S * 0.72).toFixed(2)),
      marketCap: 2800000000000,
      exchange: "NASDAQ",
    },
    expirationDates,
    selectedExpiration: selectedTimestamp,
    dte,
    strikes,
    options: [
      {
        expirationDate: selectedTimestamp,
        hasMiniOptions: false,
        calls,
        puts,
      },
    ],
    isFallback: true,
  };
}

// Fetch live options chain from Yahoo Finance with fallback support
async function fetchYahooOptionsChain(ticker: string, dateTimestamp?: number) {
  const cleanTicker = ticker.trim().toUpperCase();
  const cacheKey = `${cleanTicker}_${dateTimestamp || "default"}`;

  const cached = optionsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  try {
    const session = await getYahooSession();
    let url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(cleanTicker)}`;
    const params = new URLSearchParams();
    if (session.crumb) {
      params.append("crumb", session.crumb);
    }
    if (dateTimestamp) {
      params.append("date", String(dateTimestamp));
    }
    const queryString = params.toString();
    if (queryString) {
      url += `?${queryString}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const headers: Record<string, string> = {
      "User-Agent": userAgent,
      "Accept": "application/json",
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (session.cookie) {
      headers["Cookie"] = session.cookie;
    }

    const response = await fetch(url, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`Yahoo Finance returned status ${response.status} for ${cleanTicker}. Using calculated option model.`);
      const fallback = generateFallbackOptionChain(cleanTicker, dateTimestamp);
      optionsCache.set(cacheKey, { timestamp: Date.now(), data: fallback });
      return fallback;
    }

    const json: any = await response.json();
    const result = json?.optionChain?.result?.[0];

    if (!result || !result.quote) {
      console.warn(`Yahoo Finance returned empty result for ${cleanTicker}. Using fallback.`);
      const fallback = generateFallbackOptionChain(cleanTicker, dateTimestamp);
      optionsCache.set(cacheKey, { timestamp: Date.now(), data: fallback });
      return fallback;
    }

    const quote = result.quote;
    const S = quote.regularMarketPrice || quote.ask || 100;
    const expirationDates = result.expirationDates || [];
    const selectedExpiration = dateTimestamp || (result.options?.[0]?.expirationDate) || expirationDates[0];

    const nowSec = Math.floor(Date.now() / 1000);
    const dte = Math.max(1, Math.round((selectedExpiration - nowSec) / 86400));
    const T = dte / 365;

    // Process calls and puts, ensuring complete Greeks
    const rawOptions = result.options?.[0] || { calls: [], puts: [] };
    
    const processOption = (opt: any, isCall: boolean) => {
      const strike = opt.strike;
      let iv = opt.impliedVolatility || 0.3;
      if (iv > 5) iv = iv / 100; // normalize percentage if needed

      const greeks = calculateGreeks(isCall, S, strike, T, 0.045, iv > 0 ? iv : 0.3);

      return {
        contractSymbol: opt.contractSymbol,
        strike,
        currency: opt.currency || "USD",
        lastPrice: opt.lastPrice || 0,
        change: opt.change || 0,
        percentChange: opt.percentChange || 0,
        volume: opt.volume || 0,
        openInterest: opt.openInterest || 0,
        bid: opt.bid || 0,
        ask: opt.ask || 0,
        impliedVolatility: Number((iv * 100).toFixed(1)),
        inTheMoney: opt.inTheMoney !== undefined ? opt.inTheMoney : (isCall ? S > strike : S < strike),
        delta: opt.delta !== undefined ? opt.delta : greeks.delta,
        gamma: opt.gamma !== undefined ? opt.gamma : greeks.gamma,
        theta: opt.theta !== undefined ? opt.theta : greeks.theta,
        vega: opt.vega !== undefined ? opt.vega : greeks.vega,
      };
    };

    const calls = (rawOptions.calls || []).map((c: any) => processOption(c, true));
    const puts = (rawOptions.puts || []).map((p: any) => processOption(p, false));

    const processedData = {
      symbol: result.underlyingSymbol || cleanTicker,
      quote: {
        symbol: quote.symbol || cleanTicker,
        shortName: quote.shortName || quote.longName || cleanTicker,
        regularMarketPrice: S,
        regularMarketChange: quote.regularMarketChange || 0,
        regularMarketChangePercent: quote.regularMarketChangePercent || 0,
        regularMarketDayHigh: quote.regularMarketDayHigh || S,
        regularMarketDayLow: quote.regularMarketDayLow || S,
        regularMarketVolume: quote.regularMarketVolume || 0,
        fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh || S * 1.2,
        fiftyTwoWeekLow: quote.fiftyTwoWeekLow || S * 0.8,
        marketCap: quote.marketCap || 0,
        exchange: quote.exchange || "NYSE/NASDAQ",
      },
      expirationDates,
      selectedExpiration,
      dte,
      strikes: result.strikes || [],
      options: [
        {
          expirationDate: selectedExpiration,
          calls,
          puts,
        },
      ],
      isFallback: false,
    };

    optionsCache.set(cacheKey, { timestamp: Date.now(), data: processedData });
    return processedData;
  } catch (err) {
    console.error(`Error querying Yahoo Finance for ${cleanTicker}:`, err);
    const fallback = generateFallbackOptionChain(cleanTicker, dateTimestamp);
    optionsCache.set(cacheKey, { timestamp: Date.now(), data: fallback });
    return fallback;
  }
}

// Live spot quote fetcher using Yahoo Chart v8 API (supports stocks, European tickers .PA/.MI/.AS, and FX pairs like EURUSD=X)
async function fetchYahooSpotQuote(ticker: string): Promise<any | null> {
  const cleanTicker = ticker.trim().toUpperCase();
  const cacheKey = `spot_${cleanTicker}`;
  const cached = optionsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cleanTicker)}?interval=1d&range=5d`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": userAgent, Accept: "application/json" },
    });
    clearTimeout(timeoutId);

    if (res.ok) {
      const json: any = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta && typeof meta.regularMarketPrice === "number" && meta.regularMarketPrice > 0) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || meta.previousClose || price;
        const change = price - prevClose;
        const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
        const quote = {
          symbol: meta.symbol || cleanTicker,
          shortName: meta.shortName || meta.longName || cleanTicker,
          regularMarketPrice: price,
          regularMarketChange: Number(change.toFixed(4)),
          regularMarketChangePercent: Number(changePct.toFixed(2)),
          regularMarketDayHigh: meta.regularMarketDayHigh || price,
          regularMarketDayLow: meta.regularMarketDayLow || price,
          regularMarketVolume: meta.regularMarketVolume || 0,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || price,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow || price,
          marketCap: 0,
          exchange: meta.exchangeName || meta.fullExchangeName || "",
          currency: meta.currency || "USD",
        };
        optionsCache.set(cacheKey, { timestamp: Date.now(), data: quote });
        return quote;
      }
    }
  } catch (err) {
    console.warn(`Yahoo chart quote failed for ${cleanTicker}:`, err);
  }

  // Fallback to live Yahoo options quote (strictly ignoring synthetic mock fallback)
  try {
    const optData = await fetchYahooOptionsChain(cleanTicker);
    if (optData && !optData.isFallback && optData.quote?.regularMarketPrice > 0) {
      optionsCache.set(cacheKey, { timestamp: Date.now(), data: optData.quote });
      return optData.quote;
    }
  } catch {
    // Ignore
  }

  return null;
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Multi-ticker Portfolio Quotes endpoint (live quotes only — never injects synthetic $150 fallbacks)
app.get("/api/portfolio-quotes", async (req, res) => {
  try {
    const rawSymbols = String(req.query.symbols || "").trim();
    if (!rawSymbols) {
      return res.json({ quotes: {} });
    }
    const symbols = Array.from(new Set(rawSymbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)));
    const quotes: Record<string, any> = {};

    await Promise.all(
      symbols.map(async (sym) => {
        try {
          const quote = await fetchYahooSpotQuote(sym);
          if (quote && quote.regularMarketPrice > 0) {
            quotes[sym] = quote;
          }
        } catch (e) {
          console.warn(`Portfolio quote failed for ${sym}:`, e);
        }
      })
    );

    return res.json({ quotes });
  } catch (error: any) {
    console.error("API error in /api/portfolio-quotes:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch quotes" });
  }
});

// Options Chain endpoint
app.get("/api/options/:ticker", async (req, res) => {
  try {
    const { ticker } = req.params;
    const dateParam = req.query.date ? Number(req.query.date) : undefined;
    if (!ticker) {
      return res.status(400).json({ error: "Ticker symbol is required" });
    }

    const data = await fetchYahooOptionsChain(ticker, dateParam);
    return res.json(data);
  } catch (error: any) {
    console.error("API error fetching options:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch options data" });
  }
});

// Strike across DTEs comparison endpoint
app.get("/api/options/:ticker/strike-dte-comparison", async (req, res) => {
  try {
    const { ticker } = req.params;
    const rawStrike = req.query.strike ? Number(req.query.strike) : undefined;
    const optionType = (String(req.query.type || "CALL").toUpperCase() === "PUT" ? "PUT" : "CALL") as "CALL" | "PUT";
    const limit = Math.min(25, Math.max(3, req.query.limit ? Number(req.query.limit) : 10));

    if (!ticker) {
      return res.status(400).json({ error: "Ticker symbol is required" });
    }

    // 1. Fetch primary chain to retrieve quote, strikes, and list of all expiration dates
    const baseData = await fetchYahooOptionsChain(ticker);
    const quote = baseData.quote;
    const S = quote.regularMarketPrice || 100;
    const allExpirations: number[] = baseData.expirationDates || [];

    if (allExpirations.length === 0) {
      return res.status(404).json({ error: `No options expirations found for ${ticker}` });
    }

    // Take closest N expiration dates
    const targetExpirations = allExpirations.slice(0, limit);

    // Determine available strikes and default strike
    const availableStrikes: number[] = (baseData.strikes && baseData.strikes.length > 0)
      ? baseData.strikes
      : (baseData.options?.[0]?.calls.map((c: any) => c.strike) || [S]);

    let resolvedStrike = rawStrike;
    if (resolvedStrike === undefined || isNaN(resolvedStrike)) {
      resolvedStrike = availableStrikes.reduce((prev, curr) =>
        Math.abs(curr - S) < Math.abs(prev - S) ? curr : prev, availableStrikes[0] || S
      );
    }

    // 2. Fetch chains for all target expirations in parallel
    const chains = await Promise.all(
      targetExpirations.map((expDate) => fetchYahooOptionsChain(ticker, expDate))
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const rows = [];

    for (let i = 0; i < chains.length; i++) {
      const chain = chains[i];
      const expDate = targetExpirations[i];
      const optSet = chain.options?.[0] || { calls: [], puts: [] };
      const contracts = optionType === "CALL" ? optSet.calls : optSet.puts;

      if (!contracts || contracts.length === 0) continue;

      // Find contract for resolvedStrike (or closest strike available in this expiration)
      let match = contracts.find((c: any) => Math.abs(c.strike - resolvedStrike!) < 0.05);
      if (!match) {
        match = contracts.reduce((prev: any, curr: any) =>
          Math.abs(curr.strike - resolvedStrike!) < Math.abs(prev.strike - resolvedStrike!) ? curr : prev, contracts[0]
        );
      }

      if (match) {
        const dte = Math.max(1, Math.round((expDate - nowSec) / 86400));
        const expDateObj = new Date(expDate * 1000);
        const formattedDate = expDateObj.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: expDateObj.getFullYear() !== new Date().getFullYear() ? "2-digit" : undefined,
        });

        const B = match.bid > 0 ? match.bid : (match.lastPrice > 0 ? match.lastPrice : 0.05);
        const A = match.ask > 0 ? match.ask : (B > 0 ? Number((B * 1.05).toFixed(2)) : 0.1);
        const mid = Number(((B + A) / 2).toFixed(2));
        const spread = Number((Math.max(0, A - B)).toFixed(2));
        const K = match.strike;

        let capitalRequired = 0;
        let premiumCollected = Number((B * 100).toFixed(2));
        let premiumYieldPercent = 0;
        let premiumAnnualizedApr = 0;
        let maxProfitPerContract = 0;
        let maxReturnPercent = 0;
        let maxAnnualizedApr = 0;
        let breakEven = 0;
        let downsideBufferPercent = 0;

        if (optionType === "CALL") {
          // Covered Call: 100 shares at current market S, short 1 call at strike K
          capitalRequired = Math.max(1, Number(((S - B) * 100).toFixed(2)));
          // Premium yield on stock cost basis:
          premiumYieldPercent = Number(((B / S) * 100).toFixed(2));
          premiumAnnualizedApr = Number(((premiumYieldPercent * 365) / dte).toFixed(1));

          // If assigned at expiration at strike K:
          const profitPerShare = K >= S ? (K - S + B) : B;
          maxProfitPerContract = Number((profitPerShare * 100).toFixed(2));
          maxReturnPercent = Number(((profitPerShare / S) * 100).toFixed(2));
          maxAnnualizedApr = Number(((maxReturnPercent * 365) / dte).toFixed(1));

          breakEven = Number((S - B).toFixed(2));
          downsideBufferPercent = Number(((B / S) * 100).toFixed(2));
        } else {
          // Cash-Secured Put: Collateral required is K * 100
          capitalRequired = Number((K * 100).toFixed(2));
          // Return on Collateral:
          premiumYieldPercent = Number(((B / K) * 100).toFixed(2));
          premiumAnnualizedApr = Number(((premiumYieldPercent * 365) / dte).toFixed(1));

          maxProfitPerContract = Number((B * 100).toFixed(2));
          maxReturnPercent = premiumYieldPercent;
          maxAnnualizedApr = premiumAnnualizedApr;

          breakEven = Number((K - B).toFixed(2));
          downsideBufferPercent = Number((((S - (K - B)) / S) * 100).toFixed(2));
        }

        rows.push({
          expirationDate: expDate,
          formattedDate,
          dte,
          strike: K,
          contractSymbol: match.contractSymbol,
          bid: match.bid,
          ask: match.ask,
          mid,
          spread,
          lastPrice: match.lastPrice,
          volume: match.volume || 0,
          openInterest: match.openInterest || 0,
          impliedVolatility: match.impliedVolatility,
          delta: match.delta,
          theta: match.theta,
          gamma: match.gamma,
          vega: match.vega,
          inTheMoney: match.inTheMoney,
          capitalRequired,
          premiumCollected,
          premiumYieldPercent,
          premiumAnnualizedApr,
          maxProfitPerContract,
          maxReturnPercent,
          maxAnnualizedApr,
          breakEven,
          downsideBufferPercent,
        });
      }
    }

    // Sort rows by DTE ascending
    rows.sort((a, b) => a.dte - b.dte);

    // Identify Sweet Spot & Records
    let highestAprDte: number | undefined;
    let highestPremiumDte: number | undefined;
    let sweetSpotDte: number | undefined;
    let maxApr = -Infinity;
    let maxPrem = -Infinity;

    rows.forEach((r) => {
      if (r.premiumAnnualizedApr > maxApr) {
        maxApr = r.premiumAnnualizedApr;
        highestAprDte = r.dte;
      }
      if (r.premiumCollected > maxPrem) {
        maxPrem = r.premiumCollected;
        highestPremiumDte = r.dte;
      }
    });

    // Best velocity sweet spot: usually 21 to 45 DTE with optimal APR
    const sweetSpotCandidates = rows.filter((r) => r.dte >= 14 && r.dte <= 60);
    if (sweetSpotCandidates.length > 0) {
      const bestCandidate = [...sweetSpotCandidates].sort(
        (a, b) => b.premiumAnnualizedApr - a.premiumAnnualizedApr
      )[0];
      sweetSpotDte = bestCandidate.dte;
    } else {
      sweetSpotDte = highestAprDte;
    }

    return res.json({
      symbol: quote.symbol || ticker.toUpperCase(),
      quote,
      strategy: optionType === "CALL" ? "COVERED_CALL" : "CASH_SECURED_PUT",
      optionType,
      strike: resolvedStrike,
      availableStrikes,
      rows,
      highestAprDte,
      highestPremiumDte,
      sweetSpotDte,
    });
  } catch (error: any) {
    console.error("API error in strike-dte-comparison:", error);
    return res.status(500).json({ error: error.message || "Failed to compare DTEs" });
  }
});


// Ticker search/suggestions
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").toUpperCase().trim();
  const POPULAR_TICKERS = [
    { symbol: "NVDA", name: "NVIDIA Corporation", price: 217.49, category: "Semiconductors" },
    { symbol: "AAPL", name: "Apple Inc.", price: 232.15, category: "Mega-Cap Tech" },
    { symbol: "TSLA", name: "Tesla, Inc.", price: 248.80, category: "Automotive/EV" },
    { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", price: 565.40, category: "Indices & ETFs" },
    { symbol: "MSFT", name: "Microsoft Corporation", price: 428.60, category: "Software/Cloud" },
    { symbol: "ORCL", name: "Oracle Corporation", price: 150.06, category: "Enterprise Tech" },
    { symbol: "AMD", name: "Advanced Micro Devices", price: 156.30, category: "Semiconductors" },
    { symbol: "AMZN", name: "Amazon.com, Inc.", price: 188.50, category: "E-Commerce/Cloud" },
    { symbol: "META", name: "Meta Platforms, Inc.", price: 520.10, category: "Social Media" },
    { symbol: "GOOGL", name: "Alphabet Inc.", price: 178.20, category: "Tech & Search" },
    { symbol: "MSTR", name: "MicroStrategy Incorporated", price: 135.40, category: "Crypto Proxy" },
    { symbol: "QQQ", name: "Invesco QQQ Trust", price: 485.20, category: "Indices & ETFs" },
  ];

  if (!q) {
    return res.json(POPULAR_TICKERS);
  }

  const filtered = POPULAR_TICKERS.filter(
    (t) => t.symbol.includes(q) || t.name.toUpperCase().includes(q)
  );

  // If user searched for custom ticker not in quick list, add it as first match
  if (!filtered.some((t) => t.symbol === q) && /^[A-Z0-9.\-]{1,6}$/.test(q)) {
    filtered.unshift({ symbol: q, name: `${q} Stock`, price: 0, category: "Custom" });
  }

  return res.json(filtered);
});

// ----------------------------------------------------
// SEC EDGAR FILINGS PROXY (Form 4, 8-K, SC 13D, 10-Q)
// ----------------------------------------------------
const SEC_USER_AGENT = "ApexChronoTracker/1.0 (portfolio-journal@apex-tracker.local)";
const SEC_TICKER_MAP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SEC_FILING_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface SecCompanyEntry {
  cikStr: string;
  title: string;
}

let secTickerMapCache: { timestamp: number; map: Map<string, SecCompanyEntry> } = {
  timestamp: 0,
  map: new Map(),
};

const secFilingsCache = new Map<string, { timestamp: number; data: any }>();
const secSupplementalDocsCache = new Map<string, { timestamp: number; docs: Array<{ form: string; filingDate: string; description: string; secUrl: string; rawUrl: string }> }>();
const secExcerptCache = new Map<string, { timestamp: number; text: string }>();
const journalIntelCache = new Map<string, { timestamp: number; data: any }>();
const JOURNAL_INTEL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SEC_EXCERPT_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

let cachedGeminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return null;
  if (!cachedGeminiClient) {
    cachedGeminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return cachedGeminiClient;
}

const TARGET_SEC_FORMS = new Set([
  "4",
  "4/A",
  "8-K",
  "8-K/A",
  "SC 13D",
  "SC 13D/A",
  "SCHEDULE 13D",
  "SCHEDULE 13D/A",
  "10-Q",
  "10-Q/A",
  "6-K",
  "20-F",
]);

const SUPPLEMENTAL_AI_SEC_FORMS = new Set([
  "10-K",
  "10-K/A",
  "S-3",
  "S-3/A",
  "424B5",
  "F-3",
]);

const TRIGGER_SEC_FORMS = new Set([
  "4",
  "4/A",
  "8-K",
  "8-K/A",
  "SC 13D",
  "SC 13D/A",
  "SCHEDULE 13D",
  "SCHEDULE 13D/A",
]);

function buildSafeSecArchiveUrl(cikNumeric: string, accNoDash: string, safeDoc: string): string | null {
  if (!/^\d{1,10}$/.test(cikNumeric) || !/^\d{10,25}$/.test(accNoDash) || !safeDoc) return null;
  if (safeDoc.includes("..") || safeDoc.startsWith("/") || !/^[A-Za-z0-9._\-\/]+$/.test(safeDoc)) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accNoDash}/${safeDoc}`;
}

async function fetchSecDocumentText(secArchiveUrl: string, maxChars = 7500): Promise<string> {
  if (!secArchiveUrl.startsWith("https://www.sec.gov/Archives/edgar/data/")) return "";
  const now = Date.now();
  const cached = secExcerptCache.get(secArchiveUrl);
  if (cached && now - cached.timestamp < SEC_EXCERPT_CACHE_TTL_MS) {
    return cached.text.slice(0, maxChars);
  }
  try {
    const res = await fetch(secArchiveUrl, {
      headers: {
        "User-Agent": SEC_USER_AGENT,
        Accept: "text/html,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(6500),
    });
    if (!res.ok) return "";
    const raw = await res.text();
    const cleaned = extractPlainTextFromFiling(raw, 12000);
    secExcerptCache.set(secArchiveUrl, { timestamp: now, text: cleaned });
    return cleaned.slice(0, maxChars);
  } catch {
    return "";
  }
}

async function getSecTickerMap(): Promise<Map<string, SecCompanyEntry>> {
  const now = Date.now();
  if (secTickerMapCache.map.size > 0 && now - secTickerMapCache.timestamp < SEC_TICKER_MAP_TTL_MS) {
    return secTickerMapCache.map;
  }

  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: {
      "User-Agent": SEC_USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`SEC ticker index returned HTTP ${res.status}`);
  }

  const json = (await res.json()) as Record<string, { cik_str: number | string; ticker: string; title: string }>;
  const map = new Map<string, SecCompanyEntry>();
  for (const item of Object.values(json)) {
    if (!item || !item.ticker || item.cik_str === undefined) continue;
    const sym = String(item.ticker).toUpperCase().trim();
    const digits = String(item.cik_str).replace(/\D/g, "");
    if (!digits) continue;
    map.set(sym, {
      cikStr: digits.padStart(10, "0"),
      title: String(item.title || sym),
    });
  }

  secTickerMapCache = { timestamp: now, map };
  return map;
}

async function fetchSecTickerSubmissions(ticker: string, forceRefresh = false) {
  const now = Date.now();
  const cached = secFilingsCache.get(ticker);
  if (!forceRefresh && cached && now - cached.timestamp < SEC_FILING_CACHE_TTL_MS) {
    return cached.data;
  }

  const fetchedAt = new Date().toISOString();
  const tickerMap = await getSecTickerMap();
  const entry = tickerMap.get(ticker);

  if (!entry || !/^\d{10}$/.test(entry.cikStr)) {
    const result = {
      ticker,
      status: "NO_CIK",
      fetchedAt,
      source: "SEC EDGAR",
      filings: [],
    };
    secFilingsCache.set(ticker, { timestamp: now, data: result });
    return result;
  }

  const url = `https://data.sec.gov/submissions/CIK${entry.cikStr}.json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": SEC_USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    return {
      ticker,
      cik: entry.cikStr,
      companyName: entry.title,
      status: "ERROR",
      error: `SEC submissions returned HTTP ${res.status}`,
      fetchedAt,
      source: "SEC EDGAR",
      filings: [],
    };
  }

  const payload = (await res.json()) as any;
  const recent = payload?.filings?.recent;
  const forms: string[] = Array.isArray(recent?.form) ? recent.form : [];
  const filingDates: string[] = Array.isArray(recent?.filingDate) ? recent.filingDate : [];
  const reportDates: string[] = Array.isArray(recent?.reportDate) ? recent.reportDate : [];
  const accessionNumbers: string[] = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];
  const primaryDocs: string[] = Array.isArray(recent?.primaryDocument) ? recent.primaryDocument : [];
  const primaryDescs: string[] = Array.isArray(recent?.primaryDocDescription) ? recent.primaryDocDescription : [];

  const cikNumeric = String(parseInt(entry.cikStr, 10));
  const filings: any[] = [];
  const supplementalDocs: Array<{ form: string; filingDate: string; description: string; secUrl: string; rawUrl: string }> = [];
  const form4Jobs: Array<{ filingIndex: number; rawXmlUrl: string }> = [];
  const ninetyDaysAgoMs = now - 90 * 86400000;

  for (let i = 0; i < forms.length && (filings.length < 15 || supplementalDocs.length < 4); i++) {
    const rawForm = String(forms[i] || "").toUpperCase().trim();
    const isTarget = TARGET_SEC_FORMS.has(rawForm);
    const isSupplemental = SUPPLEMENTAL_AI_SEC_FORMS.has(rawForm);
    if (!isTarget && !isSupplemental) continue;

    const accession = String(accessionNumbers[i] || "").trim();
    const accNoDash = accession.replace(/[^0-9]/g, "");
    const rawDoc = String(primaryDocs[i] || "").trim();
    const safeDoc = rawDoc.replace(/\.\./g, "").replace(/[^A-Za-z0-9._\-\/]/g, "").replace(/^\/+/, "");
    const secArchiveUrl = buildSafeSecArchiveUrl(cikNumeric, accNoDash, safeDoc);
    const secUrl = secArchiveUrl || `https://www.sec.gov/edgar/browse/?CIK=${entry.cikStr}`;
    const filingDateStr = String(filingDates[i] || "");

    if (isTarget && filings.length < 15) {
      const filingIdx = filings.length;
      filings.push({
        form: rawForm,
        filingDate: filingDateStr,
        reportDate: String(reportDates[i] || ""),
        accessionNumber: accession,
        description: String(primaryDescs[i] || rawForm),
        secUrl,
        isTriggerForm: TRIGGER_SEC_FORMS.has(rawForm),
      });

      // Schedule deterministic Form 4 XML parsing for up to 5 recent Form 4s (within 90 days)
      if ((rawForm === "4" || rawForm === "4/A") && form4Jobs.length < 5 && safeDoc) {
        const fMs = new Date(filingDateStr + "T00:00:00Z").getTime();
        if (!isNaN(fMs) && fMs >= ninetyDaysAgoMs) {
          const xmlDoc = stripSecXsltPrefix(safeDoc);
          const rawXmlUrl = buildSafeSecArchiveUrl(cikNumeric, accNoDash, xmlDoc);
          if (rawXmlUrl && xmlDoc.toLowerCase().endsWith(".xml")) {
            form4Jobs.push({ filingIndex: filingIdx, rawXmlUrl });
          }
        }
      }
    } else if (isSupplemental && supplementalDocs.length < 4 && secArchiveUrl) {
      supplementalDocs.push({
        form: rawForm,
        filingDate: filingDateStr,
        description: String(primaryDescs[i] || rawForm),
        secUrl,
        rawUrl: secArchiveUrl,
      });
    }
  }

  // Enrich recent Form 4 filings with deterministic XML transaction codes (Code P vs S vs A/M/F)
  if (form4Jobs.length > 0) {
    await Promise.all(
      form4Jobs.map(async (job) => {
        try {
          const xmlRes = await fetch(job.rawXmlUrl, {
            headers: {
              "User-Agent": SEC_USER_AGENT,
              Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
            },
            signal: AbortSignal.timeout(5000),
          });
          if (!xmlRes.ok) return;
          const xmlText = await xmlRes.text();
          const summary = parseForm4Xml(xmlText);
          if (summary) {
            filings[job.filingIndex].form4Summary = summary;
          }
        } catch {
          // Non-fatal: leave Form 4 without form4Summary if SEC times out
        }
      })
    );
  }

  secSupplementalDocsCache.set(ticker, { timestamp: now, docs: supplementalDocs });

  const result = {
    ticker,
    cik: entry.cikStr,
    companyName: entry.title,
    status: "OK",
    fetchedAt,
    source: "SEC EDGAR",
    filings,
  };
  secFilingsCache.set(ticker, { timestamp: now, data: result });
  return result;
}

app.get("/api/sec-filings", async (req, res) => {
  try {
    const rawTickers = String(req.query.tickers || "");
    const forceRefresh = String(req.query.refresh || "") === "1";

    const tickers = Array.from(
      new Set(
        rawTickers
          .split(",")
          .map((t) => t.trim().toUpperCase())
          .filter((t) => /^[A-Z0-9.\-]{1,10}$/.test(t))
      )
    ).slice(0, 25);

    if (tickers.length === 0) {
      return res.status(400).json({ error: "Provide at least one valid ticker symbol" });
    }

    const results: Record<string, any> = {};
    // Polite sequential-batched requests (max 4 concurrent) to stay well below SEC's 10 req/sec limit
    const chunkSize = 4;
    for (let i = 0; i < tickers.length; i += chunkSize) {
      const chunk = tickers.slice(i, i + chunkSize);
      const settled = await Promise.all(
        chunk.map(async (ticker) => {
          try {
            return await fetchSecTickerSubmissions(ticker, forceRefresh);
          } catch (err: any) {
            return {
              ticker,
              status: "ERROR",
              error: err?.message || "SEC EDGAR lookup failed",
              fetchedAt: new Date().toISOString(),
              source: "SEC EDGAR",
              filings: [],
            };
          }
        })
      );
      for (const item of settled) {
        results[item.ticker] = item;
      }
      if (i + chunkSize < tickers.length) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    return res.json({
      fetchedAt: new Date().toISOString(),
      source: "SEC EDGAR",
      filingsByTicker: results,
    });
  } catch (error: any) {
    console.error("API error in /api/sec-filings:", error);
    return res.status(500).json({ error: error?.message || "Failed to fetch SEC filings" });
  }
});

// ----------------------------------------------------
// AI FILING & NEWS INTELLIGENCE (Server-side Gemini 4)
// ----------------------------------------------------
const ALLOWED_CATALYST_TYPES = new Set([
  "Earnings",
  "Clinical / FDA",
  "Insider Cluster",
  "Activist / 13D",
  "M&A / Spin-off",
  "Product / Contract",
  "Macro / Technical",
  "Other",
]);

function extractJsonObject(raw: string): any | null {
  if (!raw || typeof raw !== "string") return null;
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function isIsoDateStr(val: unknown): val is string {
  return typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val.trim());
}

function formatGeminiError(error: any, fallback: string): { statusCode: number; message: string } {
  let statusCode =
    typeof error?.status === "number" && error.status >= 400 && error.status < 600
      ? error.status
      : 500;
  let rawMsg = typeof error?.message === "string" ? error.message.trim() : "";

  if (rawMsg.startsWith("{")) {
    try {
      const parsed = JSON.parse(rawMsg);
      const inner = parsed?.error || parsed;
      if (typeof inner?.code === "number" && inner.code >= 400 && inner.code < 600) {
        statusCode = inner.code;
      }
      if (typeof inner?.message === "string" && inner.message.trim()) {
        rawMsg = inner.message.trim();
      }
    } catch {
      // keep rawMsg
    }
  }

  if (statusCode === 429) {
    return {
      statusCode: 429,
      message: "Gemini API rate/quota limit reached (429). Please wait a moment and click Re-analyze.",
    };
  }
  if (statusCode === 503) {
    return {
      statusCode: 503,
      message: "Gemini model is temporarily busy (503). Please try again in a few seconds.",
    };
  }
  return {
    statusCode,
    message: rawMsg ? rawMsg.slice(0, 260) : fallback,
  };
}

app.post("/api/journal-intel/analyze-trade", async (req, res) => {
  try {
    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error: "Server GEMINI_API_KEY is not configured. Configure GEMINI_API_KEY in the server environment to run AI Filing & News Intelligence.",
      });
    }

    const body = req.body || {};
    const ticker = String(body.ticker || "").trim().toUpperCase();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(ticker)) {
      return res.status(400).json({ error: "Invalid ticker symbol" });
    }

    const companyName = String(body.companyName || ticker).trim().slice(0, 120);
    const instrument = body.instrument === "OPTION" ? "OPTION" : "STOCK";
    const status = body.status === "CLOSED" ? "CLOSED" : "OPEN";
    const entryDate = isIsoDateStr(body.entryDate) ? body.entryDate.trim() : "";
    const exitDate = isIsoDateStr(body.exitDate) ? body.exitDate.trim() : "";
    const expiry = isIsoDateStr(body.expiry) ? body.expiry.trim() : "";
    const catalystDate = isIsoDateStr(body.catalystDate) ? body.catalystDate.trim() : "";
    const catalystType = String(body.catalystType || "Other").trim().slice(0, 40);
    const thesis = String(body.thesis || "").trim().slice(0, 500);
    const manualFilingNote = String(body.manualFilingNote || "").trim().slice(0, 500);
    const forceRefresh = Boolean(body.forceRefresh);

    const cacheKey = JSON.stringify([
      ticker,
      instrument,
      status,
      entryDate,
      exitDate,
      expiry,
      catalystType,
      catalystDate,
      thesis,
      manualFilingNote,
    ]);

    const now = Date.now();
    const cached = journalIntelCache.get(cacheKey);
    if (!forceRefresh && cached && now - cached.timestamp < JOURNAL_INTEL_CACHE_TTL_MS) {
      return res.json({ intel: cached.data, cached: true });
    }

    // 1. Gather real SEC EDGAR filings + deterministic Form 4 summaries + up to 3 actual SEC filing text excerpts
    let secData: any = null;
    try {
      secData = await fetchSecTickerSubmissions(ticker, forceRefresh);
    } catch {
      secData = null;
    }

    const filings: any[] = Array.isArray(secData?.filings) ? secData.filings : [];
    const supplementalDocs = secSupplementalDocsCache.get(ticker)?.docs || [];

    const form4SummariesText = filings
      .filter((f) => (f.form === "4" || f.form === "4/A") && f.form4Summary)
      .slice(0, 5)
      .map((f) => {
        const s = f.form4Summary;
        return `- Form ${f.form} (${f.filingDate}): ${s.insiderName} (${s.insiderRole}) | ${s.actionLabel} | ${s.shares} shares @ $${s.pricePerShare} (total ~$${s.totalValue}) | openMarketBuy=${s.isOpenMarketBuy} routineNoise=${s.isRoutineNoise} | URL: ${f.secUrl}`;
      })
      .join("\n");

    // Pick up to 3 highest-value non-Form-4 filings to extract actual text from sec.gov
    const docsToRead: Array<{ form: string; filingDate: string; description: string; secUrl: string }> = [];
    const pickFirst = (pred: (d: any) => boolean, pool: any[]) => {
      const found = pool.find((d) => pred(d) && d.secUrl?.startsWith("https://www.sec.gov/Archives/edgar/data/") && !docsToRead.some((x) => x.secUrl === d.secUrl));
      if (found) docsToRead.push({ form: found.form, filingDate: found.filingDate, description: found.description, secUrl: found.secUrl });
    };

    pickFirst((d) => d.form === "8-K" || d.form === "8-K/A" || d.form === "6-K", filings);
    pickFirst((d) => d.form === "10-Q" || d.form === "10-Q/A" || d.form === "20-F", filings);
    pickFirst((d) => d.form.includes("13D"), filings);
    if (docsToRead.length < 3) {
      pickFirst((d) => d.form === "S-3" || d.form === "S-3/A" || d.form === "424B5" || d.form === "F-3", supplementalDocs);
    }
    if (docsToRead.length < 3) {
      pickFirst((d) => d.form === "10-K" || d.form === "10-K/A", supplementalDocs);
    }
    if (docsToRead.length < 3) {
      pickFirst((d) => d.form === "8-K" || d.form === "8-K/A", filings);
    }

    const excerpts = await Promise.all(
      docsToRead.slice(0, 3).map(async (d) => {
        const text = await fetchSecDocumentText(d.secUrl, 6500);
        return { ...d, text };
      })
    );

    const secContextBlock = [
      `SEC Status: ${secData?.status || "UNAVAILABLE"} (${secData?.companyName || companyName}, CIK: ${secData?.cik || "N/A"})`,
      filings.length > 0
        ? `Recent SEC Filing List:\n${filings
            .slice(0, 10)
            .map((f) => `- ${f.form} | ${f.filingDate} | ${f.description} | ${f.secUrl}`)
            .join("\n")}`
        : "No recent US SEC EDGAR filings available (may be non-US issuer).",
      supplementalDocs.length > 0
        ? `Recent Shelf / Annual Filings:\n${supplementalDocs
            .map((d) => `- ${d.form} | ${d.filingDate} | ${d.description} | ${d.secUrl}`)
            .join("\n")}`
        : "",
      form4SummariesText ? `Parsed Form 4 XML Transactions (authoritative):\n${form4SummariesText}` : "",
      excerpts.filter((e) => e.text).length > 0
        ? `Actual SEC Filing Text Excerpts:\n${excerpts
            .filter((e) => e.text)
            .map((e) => `--- ${e.form} (${e.filingDate}) [${e.secUrl}] ---\n${e.text}`)
            .join("\n\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const todayIso = new Date().toISOString().slice(0, 10);

    const systemInstruction = `You are a concise, factual equity & biotech/event-driven filing analyst inside a trader's risk journal.
Today's date is ${todayIso}.
Use the provided SEC EDGAR excerpts AND Google Search grounding to verify recent news, earnings dates, FDA/PDUFA/clinical dates, SEC filings, cash runway, ATM/shelf dilution, and (for closed trades) exit-day news.
Rules:
1. Never invent dates, cash numbers, or filing facts. If something is unknown or unavailable, say so honestly ("UNKNOWN", null, or empty string).
2. Keep every field crisp and scannable (1–2 sentences max per summary).
3. Only output a single valid JSON object matching the exact schema below—no markdown prose outside JSON.
Schema:
{
  "thesisCheck": {
    "verdict": "ALIGNED" | "WATCH" | "RISK" | "NO_THESIS",
    "summary": "1-sentence verdict directly addressing the user's thesis",
    "evidence": "1-2 sentences citing specific recent filing or news facts",
    "sourceUrl": "optional https:// url"
  },
  "filingDigests": [
    {
      "form": "8-K | 10-Q | Form 4 | SC 13D | S-3 | News",
      "date": "YYYY-MM-DD",
      "materiality": "MATERIAL" | "DILUTION" | "INSIDER_BUY" | "ROUTINE",
      "headline": "short factual title (max 80 chars)",
      "summary": "plain-English 1-sentence takeaway",
      "secUrl": "optional https:// url"
    }
  ],
  "catalystRadar": {
    "suggestedCatalystType": "Earnings" | "Clinical / FDA" | "Insider Cluster" | "Activist / 13D" | "M&A / Spin-off" | "Product / Contract" | "Macro / Technical" | "Other",
    "suggestedDate": "YYYY-MM-DD or empty string if no confirmed upcoming date",
    "eventLabel": "concise description of the next key catalyst (e.g. Q3 Earnings Release or FDA PDUFA Date)",
    "timelineDrift": "ON_TRACK" | "DELAYED" | "PULLED_FORWARD" | "UNKNOWN",
    "driftNote": "optional 1-sentence note if timeline shifted vs prior guidance or user date",
    "sourceUrl": "optional https:// url"
  },
  "runwayAndDilution": {
    "cashAndEquivalents": "e.g. $142M (Q2 2026) or Unknown",
    "quarterlyBurn": "e.g. ~$18M/qtr or Cash-flow positive or Unknown",
    "estimatedRunwayMonths": number or null,
    "dilutionRisk": "LOW" | "MODERATE" | "HIGH" | "UNKNOWN",
    "atmOrShelfNote": "1-sentence note on active S-3 shelf, ATM facility, warrants, or buybacks/no dilution risk",
    "asOfDate": "YYYY-MM-DD or quarter label"
  },
  "exitContext": ${
    status === "CLOSED"
      ? `{
    "summary": "1-2 sentences explaining what news, filing, or market catalyst happened within +/- 3 days of the exit date",
    "keyEvents": [{ "date": "YYYY-MM-DD", "headline": "short event headline", "sourceUrl": "optional https:// url" }]
  }`
      : "null"
  }
}`;

    const userPrompt = `Analyze this journal position and return the JSON object only:
Ticker: ${ticker}
Company: ${companyName}
Instrument: ${instrument}
Status: ${status}
Entry Date: ${entryDate || "Unknown"}
${exitDate ? `Exit Date: ${exitDate}` : ""}
${expiry ? `Option Expiry: ${expiry}` : ""}
User's 1. Why I Entered (One-Line Thesis): ${thesis || "(Not entered yet — set verdict to NO_THESIS and still provide filing digests, catalyst radar, and runway/dilution)"}
User's 2. Catalyst Waiting For: Type=${catalystType}, Date=${catalystDate || "Not set"}
${manualFilingNote ? `User's Manual Filing/Catalyst Note: ${manualFilingNote}` : ""}

${secContextBlock}

Tasks:
- Check the user's thesis against the latest SEC filings and current news (via Google Search). Mark verdict "RISK" only when material evidence contradicts the thesis (e.g. FDA CRL/delay, major equity offering dilution, missed endpoint, guidance cut); mark "WATCH" for notable caveats; "ALIGNED" if intact; "NO_THESIS" if thesis is empty.
- Summarize up to 4 most relevant recent SEC filings in plain English (prioritize 8-K, 10-Q/20-F, SC 13D, S-3/ATM, and open-market Form 4 buys/sales; deprioritize routine grants).
- Identify the next upcoming catalyst date (YYYY-MM-DD) for ${ticker} and whether any public timeline has been DELAYED vs prior guidance or the user's catalyst date.
- Extract latest cash & equivalents, quarterly burn / cash-flow status, approximate runway months (or null for profitable/large-cap issuers), dilution risk, and S-3/ATM status.
${status === "CLOSED" && exitDate ? `- Because this trade is CLOSED on ${exitDate}, search for news/SEC filings within +/- 3 days of ${exitDate} to populate exitContext.` : ""}`;

    let response: any = null;
    let usedSearchGrounding = true;
    const isTransientQuotaOrBusy = (err: any) => {
      const st = err?.status || formatGeminiError(err, "").statusCode;
      return st === 429 || st === 503;
    };

    try {
      response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: userPrompt,
        config: {
          systemInstruction,
          tools: [{ googleSearch: {} }],
        },
      });
    } catch (primaryErr: any) {
      if (!isTransientQuotaOrBusy(primaryErr)) throw primaryErr;
      // Retry with gemini-3.1-flash-lite + Google Search first, then SEC-only if search grounding quota is exhausted
      try {
        response = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: userPrompt,
          config: {
            systemInstruction,
            tools: [{ googleSearch: {} }],
          },
        });
      } catch (searchErr: any) {
        if (!isTransientQuotaOrBusy(searchErr)) throw searchErr;
        usedSearchGrounding = false;
        response = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: userPrompt,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
          },
        });
      }
    }

    const rawText = response.text || "";
    const parsed = extractJsonObject(rawText);
    if (!parsed || typeof parsed !== "object") {
      return res.status(502).json({
        error: "AI analyzer returned an unexpected format. Please try re-analyzing.",
      });
    }

    // Collect verified sources from grounding chunks + SEC links
    const sourceMap = new Map<string, { title: string; url: string }>();
    const addSource = (url?: string, title?: string) => {
      const safe = sanitizeExternalUrl(url);
      if (!safe) return;
      if (!sourceMap.has(safe)) {
        sourceMap.set(safe, {
          title: (title || new URL(safe).hostname).slice(0, 90),
          url: safe,
        });
      }
    };

    const groundingChunks = (response as any)?.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(groundingChunks)) {
      for (const ch of groundingChunks) {
        if (ch?.web?.uri) {
          addSource(ch.web.uri, ch.web.title || ch.web.uri);
        }
      }
    }
    for (const d of docsToRead) {
      addSource(d.secUrl, `SEC ${d.form} (${d.filingDate})`);
    }

    const validVerdicts = new Set(["ALIGNED", "WATCH", "RISK", "NO_THESIS"]);
    const rawVerdict = String(parsed?.thesisCheck?.verdict || "").toUpperCase();
    const verdict = !thesis
      ? "NO_THESIS"
      : validVerdicts.has(rawVerdict)
      ? rawVerdict
      : "WATCH";

    const validMateriality = new Set(["MATERIAL", "DILUTION", "INSIDER_BUY", "ROUTINE"]);
    const filingDigests = Array.isArray(parsed?.filingDigests)
      ? parsed.filingDigests.slice(0, 5).map((item: any) => {
          const mat = String(item?.materiality || "MATERIAL").toUpperCase();
          const safeUrl = sanitizeExternalUrl(item?.secUrl);
          if (safeUrl) addSource(safeUrl, `${item?.form || "Filing"} (${item?.date || ""})`);
          return {
            form: String(item?.form || "Filing").slice(0, 24),
            date: String(item?.date || "").slice(0, 20),
            materiality: validMateriality.has(mat) ? mat : "MATERIAL",
            headline: String(item?.headline || "").slice(0, 140),
            summary: String(item?.summary || "").slice(0, 340),
            secUrl: safeUrl,
          };
        })
      : [];

    const validDrift = new Set(["ON_TRACK", "DELAYED", "PULLED_FORWARD", "UNKNOWN"]);
    const rawDrift = String(parsed?.catalystRadar?.timelineDrift || "UNKNOWN").toUpperCase();
    const rawCatType = String(parsed?.catalystRadar?.suggestedCatalystType || "").trim();
    const suggestedDate = isIsoDateStr(parsed?.catalystRadar?.suggestedDate)
      ? parsed.catalystRadar.suggestedDate.trim()
      : undefined;
    const catalystSourceUrl = sanitizeExternalUrl(parsed?.catalystRadar?.sourceUrl);
    if (catalystSourceUrl) addSource(catalystSourceUrl, "Catalyst Source");

    const validDilution = new Set(["LOW", "MODERATE", "HIGH", "UNKNOWN"]);
    const rawDilution = String(parsed?.runwayAndDilution?.dilutionRisk || "UNKNOWN").toUpperCase();
    const rawRunwayNum = parsed?.runwayAndDilution?.estimatedRunwayMonths;
    const estimatedRunwayMonths =
      typeof rawRunwayNum === "number" && isFinite(rawRunwayNum) && rawRunwayNum >= 0 && rawRunwayNum <= 600
        ? Math.round(rawRunwayNum)
        : null;

    const thesisSourceUrl = sanitizeExternalUrl(parsed?.thesisCheck?.sourceUrl);
    if (thesisSourceUrl) addSource(thesisSourceUrl, "Thesis Evidence");

    let exitContext: any = undefined;
    if (status === "CLOSED" && parsed?.exitContext && typeof parsed.exitContext === "object") {
      const keyEvents = Array.isArray(parsed.exitContext.keyEvents)
        ? parsed.exitContext.keyEvents.slice(0, 4).map((ev: any) => {
            const evUrl = sanitizeExternalUrl(ev?.sourceUrl);
            if (evUrl) addSource(evUrl, ev?.headline || "Exit Event");
            return {
              date: String(ev?.date || exitDate || "").slice(0, 20),
              headline: String(ev?.headline || "").slice(0, 180),
              sourceUrl: evUrl,
            };
          })
        : [];
      exitContext = {
        summary: String(parsed.exitContext.summary || "").slice(0, 500),
        keyEvents,
      };
    }

    const intel = {
      ticker,
      analyzedAt: new Date().toISOString(),
      source:
        filings.length > 0 && usedSearchGrounding
          ? "SEC EDGAR + Gemini Search Grounding"
          : filings.length > 0
          ? "SEC EDGAR + Gemini Filing Analysis"
          : usedSearchGrounding
          ? "Gemini Search Grounding"
          : "Gemini Analysis",
      thesisSnapshot: thesis || undefined,
      thesisCheck: {
        verdict,
        summary: String(parsed?.thesisCheck?.summary || (thesis ? "Review recent filings against thesis." : "Add a one-line thesis to enable automated thesis alignment checks.")).slice(0, 320),
        evidence: String(parsed?.thesisCheck?.evidence || "").slice(0, 480),
        sourceUrl: thesisSourceUrl,
      },
      filingDigests,
      catalystRadar: {
        suggestedCatalystType: ALLOWED_CATALYST_TYPES.has(rawCatType) ? rawCatType : undefined,
        suggestedDate,
        eventLabel: String(parsed?.catalystRadar?.eventLabel || "No confirmed upcoming catalyst date found").slice(0, 160),
        timelineDrift: validDrift.has(rawDrift) ? rawDrift : "UNKNOWN",
        driftNote: parsed?.catalystRadar?.driftNote ? String(parsed.catalystRadar.driftNote).slice(0, 260) : undefined,
        sourceUrl: catalystSourceUrl,
      },
      runwayAndDilution: {
        cashAndEquivalents: parsed?.runwayAndDilution?.cashAndEquivalents
          ? String(parsed.runwayAndDilution.cashAndEquivalents).slice(0, 80)
          : "Unknown",
        quarterlyBurn: parsed?.runwayAndDilution?.quarterlyBurn
          ? String(parsed.runwayAndDilution.quarterlyBurn).slice(0, 80)
          : "Unknown",
        estimatedRunwayMonths,
        dilutionRisk: validDilution.has(rawDilution) ? rawDilution : "UNKNOWN",
        atmOrShelfNote: String(parsed?.runwayAndDilution?.atmOrShelfNote || "No active shelf/ATM details extracted.").slice(0, 280),
        asOfDate: parsed?.runwayAndDilution?.asOfDate ? String(parsed.runwayAndDilution.asOfDate).slice(0, 40) : undefined,
      },
      exitContext,
      sources: Array.from(sourceMap.values()).slice(0, 8),
    };

    journalIntelCache.set(cacheKey, { timestamp: now, data: intel });
    return res.json({ intel, cached: false });
  } catch (error: any) {
    console.error("API error in /api/journal-intel/analyze-trade:", error);
    const { statusCode, message } = formatGeminiError(
      error,
      "Failed to analyze filings & news for this trade."
    );
    return res.status(statusCode).json({ error: message });
  }
});

app.post("/api/journal-intel/post-mortem", async (req, res) => {
  try {
    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error: "Server GEMINI_API_KEY is not configured. Configure GEMINI_API_KEY in the server environment to run AI Post-Mortem Review.",
      });
    }

    const rawTrades = req.body?.closedTrades;
    if (!Array.isArray(rawTrades) || rawTrades.length === 0) {
      return res.status(400).json({ error: "Provide at least 1 closed trade for post-mortem analysis." });
    }

    const sanitizedTrades = rawTrades.slice(0, 100).map((t: any) => ({
      ticker: String(t?.ticker || "").toUpperCase().slice(0, 12),
      instrument: t?.instrument === "OPTION" ? "OPTION" : "STOCK",
      catalystType: String(t?.catalystType || "Other").slice(0, 40),
      holdingDays: typeof t?.holdingDays === "number" && isFinite(t.holdingDays) ? Math.round(t.holdingDays) : 0,
      currentR: typeof t?.currentR === "number" && isFinite(t.currentR) ? Number(t.currentR.toFixed(2)) : 0,
      exitReason: String(t?.exitReason || "unlogged").slice(0, 32),
      thesis: String(t?.thesis || "").slice(0, 240),
      lesson: String(t?.lesson || "").slice(0, 240),
      entryDate: String(t?.entryDate || "").slice(0, 12),
      exitDate: String(t?.exitDate || "").slice(0, 12),
      hasInsiderCluster: Boolean(t?.hasInsiderCluster),
    }));

    const sampleCount = sanitizedTrades.length;
    const postMortemConfig = {
      systemInstruction: `You are a blunt, quantitative trading performance coach analyzing a trader's closed trades measured in R-multiples.
- Explicitly respect sample size: if n < 30, mention that conclusions are early directional observations rather than statistically proven edge.
- Cite concrete tickers, catalyst types, exit reasons, holding periods, and R-multiples from the provided JSON only. Never invent trades.
- Keep each bullet concise (1-2 sentences, actionable, zero fluff).`,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          executiveTakeaway: {
            type: Type.STRING,
            description: "2-sentence blunt summary of overall R expectancy, win/loss asymmetry, and sample size caveat.",
          },
          workingEdges: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Up to 4 specific patterns or setups that produced positive R.",
          },
          recurringLeaks: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Up to 4 specific mistakes, gap slippage, premature exits, or unlogged thesis/exit leaks.",
          },
          nextTradeRules: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Up to 4 concrete, testable rules to apply on the next 10 trades.",
          },
        },
        required: ["executiveTakeaway", "workingEdges", "recurringLeaks", "nextTradeRules"],
      },
    };
    const postMortemPrompt = `Review these ${sampleCount} closed trades from a trader's 1R risk journal and identify behavioral patterns, edges, leaks, and concrete rules for future trades.\n\nClosed Trades JSON:\n${JSON.stringify(sanitizedTrades)}`;

    let response: any = null;
    try {
      response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: postMortemPrompt,
        config: postMortemConfig,
      });
    } catch (primaryErr: any) {
      const st = primaryErr?.status || formatGeminiError(primaryErr, "").statusCode;
      if (st !== 429 && st !== 503) throw primaryErr;
      response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: postMortemPrompt,
        config: postMortemConfig,
      });
    }

    const parsed = extractJsonObject(response.text || "");
    if (!parsed) {
      return res.status(502).json({ error: "AI post-mortem returned an unexpected format. Please retry." });
    }

    const cleanList = (arr: unknown) =>
      Array.isArray(arr)
        ? arr
            .filter((x) => typeof x === "string" && x.trim().length > 0)
            .slice(0, 5)
            .map((x) => String(x).trim().slice(0, 320))
        : [];

    return res.json({
      review: {
        analyzedAt: new Date().toISOString(),
        closedTradeCount: sampleCount,
        executiveTakeaway: String(parsed.executiveTakeaway || "").slice(0, 500),
        workingEdges: cleanList(parsed.workingEdges),
        recurringLeaks: cleanList(parsed.recurringLeaks),
        nextTradeRules: cleanList(parsed.nextTradeRules),
      },
    });
  } catch (error: any) {
    console.error("API error in /api/journal-intel/post-mortem:", error);
    const { statusCode, message } = formatGeminiError(
      error,
      "Failed to generate AI post-mortem review."
    );
    return res.status(statusCode).json({ error: message });
  }
});

// Clear cache endpoint
app.post("/api/cache/clear", (_req, res) => {
  optionsCache.clear();
  secFilingsCache.clear();
  secSupplementalDocsCache.clear();
  secExcerptCache.clear();
  journalIntelCache.clear();
  return res.json({ message: "Cache cleared successfully" });
});

// ----------------------------------------------------
// VITE MIDDLEWARE & SERVER STARTUP
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Options Analyzer Terminal] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
