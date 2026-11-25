import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIBKRFlexXML, parseIBKRActivityCSV, resolveUnderlyingTicker, assignSmartOptionBuckets } from './ibkrParser';
import { calculatePortfolioState, calculateDownsideCushionPct, getFxMultiplier } from './portfolioEngine';
import { calculateXIRR, computeStepDownData, computeMonthlyCashflows, computeActiveOptions, computeCapitalAllocation } from './analyticsEngine';
import {
  buildJournalTrades,
  computeJournalTopStrip,
  applyJournalFilters,
  buildJournalTimeline,
  computeJournalAnalysis,
  detectAutoInsiderCluster,
  getNewTriggerFilings,
} from './journalEngine';
import {
  mergePortfolioImport,
  migrateLegacyJournalOverrides,
} from './xmlImportEngine';
import {
  stripSecXsltPrefix,
  parseForm4Xml,
  sanitizeExternalUrl,
} from './secForm4Parser';
import {
  DEFAULT_JOURNAL_SETTINGS,
  type Transaction,
  type JournalDerivedTrade,
  type JournalTradeIntel,
  type SecFilingItem,
} from '../types';

function installMinimalDomParser() {
  function parseXmlNodes(xml: string) {
    const root: any = { tagName: 'ROOT', parentNode: null, children: [], getAttribute: () => null };
    const matchTag = (node: any, simpleSel: string): boolean => node.tagName === simpleSel;
    const queryAll = (node: any, sel: string): any[] => {
      const parts = sel.split(',').map((s) => s.trim());
      const out: any[] = [];
      const seen = new Set<any>();
      const walk = (n: any) => {
        for (const c of n.children) {
          for (const p of parts) {
            if (p.includes('>')) {
              const [parentSel, childSel] = p.split('>').map((s) => s.trim());
              if (matchTag(c, childSel) && c.parentNode && matchTag(c.parentNode, parentSel) && !seen.has(c)) {
                seen.add(c);
                out.push(c);
              }
            } else if (matchTag(c, p) && !seen.has(c)) {
              seen.add(c);
              out.push(c);
            }
          }
          walk(c);
        }
      };
      walk(node);
      return out;
    };
    const makeNode = (tag: string, attrMap: Record<string, string>, parent: any) => ({
      tagName: tag,
      parentNode: parent,
      children: [],
      getAttribute(k: string) {
        return k in attrMap ? attrMap[k] : null;
      },
      querySelectorAll(sel: string) {
        return queryAll(this, sel);
      },
      querySelector(sel: string) {
        return queryAll(this, sel)[0] || null;
      },
    });
    root.querySelectorAll = (sel: string) => queryAll(root, sel);
    root.querySelector = (sel: string) => queryAll(root, sel)[0] || null;
    const stack = [root];
    const re = /<(\/?)([A-Za-z0-9_:-]+)([^>]*?)(\/?)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const [, closing, tag, attrsStr, selfClose] = m;
      if (closing) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrMap: Record<string, string> = {};
      const attrRe = /([A-Za-z0-9_:-]+)="([^"]*)"/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(attrsStr))) attrMap[am[1]] = am[2];
      const parent = stack[stack.length - 1];
      const node = makeNode(tag, attrMap, parent);
      parent.children.push(node);
      if (!selfClose) stack.push(node);
    }
    return root;
  }
  (globalThis as any).DOMParser = class {
    parseFromString(s: string) {
      return parseXmlNodes(s);
    }
  };
}

test('Downside cushion % stays bounded for both in-profit and underwater positions', () => {
  assert.equal(Number(calculateDownsideCushionPct(100, 80).toFixed(2)), 20);
  assert.equal(Number(calculateDownsideCushionPct(0.396, 0.918).toFixed(2)), -56.86);
  assert.equal(Number(calculateDownsideCushionPct(1.48, 11.0687).toFixed(2)), -86.63);
  assert.equal(calculateDownsideCushionPct(50, -5), 100);
});

test('Underlying resolver handles European split/corporate-action suffixes cleanly', () => {
  assert.equal(resolveUnderlyingTicker('BMPSm', 'BMPS', 'STK'), 'BMPS');
  assert.equal(resolveUnderlyingTicker('SAN1', 'SAN', 'STK'), 'SAN');
  assert.equal(resolveUnderlyingTicker('C SNW  20261218 76 M', 'SAN1', 'OPT'), 'SAN');
});

test('Chronological Real Entry Price preserves per-share basis on partial sell and handles forward splits', () => {
  const txs: Transaction[] = [
    {
      id: '1', dateTime: '2024-01-01 10:00:00', date: '2024-01-01', section: 'Trades',
      assetCategory: 'STK', symbol: 'TEST', underlying: 'TEST', action: 'BUY',
      quantity: 100, price: 100, multiplier: 1, proceeds: -10000, commission: 0, netCashFlow: -10000,
      currency: 'USD', fxRateToBase: 1, tradeId: 't1', defaultBucket: 'LINKED', bucket: 'LINKED',
    },
    {
      id: '2', dateTime: '2024-02-01 10:00:00', date: '2024-02-01', section: 'Trades',
      assetCategory: 'OPT', symbol: 'TEST 240315C110', underlying: 'TEST', action: 'SELL',
      quantity: -1, price: 5, multiplier: 100, proceeds: 500, commission: 0, netCashFlow: 500,
      currency: 'USD', fxRateToBase: 1, tradeId: 't2', defaultBucket: 'LINKED', bucket: 'LINKED',
      optionDetails: { type: 'CALL', strike: 110, expiry: '2024-03-15', isShort: true },
    },
    {
      id: '3', dateTime: '2024-03-01 10:00:00', date: '2024-03-01', section: 'Trades',
      assetCategory: 'STK', symbol: 'TEST', underlying: 'TEST', action: 'SELL',
      quantity: -50, price: 110, multiplier: 1, proceeds: 5500, commission: 0, netCashFlow: 5500,
      currency: 'USD', fxRateToBase: 1, tradeId: 't3', defaultBucket: 'LINKED', bucket: 'LINKED',
    },
    {
      id: '4', dateTime: '2024-04-01 10:00:00', date: '2024-04-01', section: 'Corporate Actions',
      assetCategory: 'CORP_ACTION', symbol: 'TEST', underlying: 'TEST', action: 'SPLIT',
      quantity: 5, price: 0, multiplier: 1, proceeds: 0, commission: 0, netCashFlow: 0,
      currency: 'USD', fxRateToBase: 1, tradeId: 't4', defaultBucket: 'LINKED', bucket: 'LINKED',
      corporateAction: { type: 'SPLIT', ratio: 5 },
    },
  ];
  const state = calculatePortfolioState(txs, {}, { TEST: { symbol: 'TEST', shortName: 'Test', regularMarketPrice: 25, regularMarketChange: 0, regularMarketChangePercent: 0, regularMarketDayHigh: 25, regularMarketDayLow: 25, regularMarketVolume: 0, fiftyTwoWeekHigh: 30, fiftyTwoWeekLow: 15, marketCap: 0, exchange: 'NASDAQ' } }, 'USD');
  assert.equal(state.positions.length, 1);
  const pos = state.positions[0];
  assert.equal(pos.currentShares, 250);
  // Pre-split real entry was (10000 - 500)/100 = 95.00; 50% trim kept $95/sh; 5:1 split => $19.00/sh
  assert.equal(Number(pos.rawAvgEntry.toFixed(2)), 20);
  assert.equal(Number(pos.realEntryPrice.toFixed(2)), 19);
  assert.equal(Number(pos.totalRealizedStockPnl.toFixed(2)), 500);
});

test('IBKR Flex XML statement reconciles cash summary, position marks, and separates NOK mixed campaigns', () => {
  installMinimalDomParser();
  const xml = fs.readFileSync('public/assets/aistudio/IBKR_content_5667205778210155609_1c6ba69a.xml', 'utf8');
  const parsed = parseIBKRFlexXML(xml);

  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.baseCurrency, 'EUR');
  assert.equal(parsed.transactions.length, 161);
  assert.equal(parsed.depositsBase, 14159);
  assert.equal(parsed.withdrawalsBase, 0);
  assert.equal(parsed.netDepositsBase, 14159);
  assert.ok(Math.abs((parsed.endingCashBase || 0) - 2879.98) < 0.05);

  const portfolio = calculatePortfolioState(parsed.transactions, {}, {}, 'EUR', parsed.fxRates, parsed.positionMarks);
  // Exact match to IBKR <OpenPositions> sum in EUR
  assert.ok(Math.abs(portfolio.summary.totalMarketValue - 8126.74) < 0.1);
  assert.equal(portfolio.positions.length, 5);

  const nok = portfolio.positions.find((p) => p.ticker === 'NOK');
  assert.ok(nok);
  // Mixed contract NOK 260724C00011000 must split into Linked (+82.97) and Standalone (-26.95)
  const nokLinked0724 = nok!.linkedOptionCampaigns.find((c) => c.contractSymbol.includes('260724C00011000'));
  const nokStandalone0724 = nok!.standaloneOptionCampaigns.find((c) => c.contractSymbol.includes('260724C00011000'));
  assert.ok(nokLinked0724 && Math.abs(nokLinked0724.netCashFlow - 82.97) < 0.05);
  assert.ok(nokStandalone0724 && Math.abs(nokStandalone0724.netCashFlow - (-26.95)) < 0.05);

  // Sub-dollar stock precision in computeStepDownData (OTLK = 0.396)
  const otlk = portfolio.positions.find((p) => p.ticker === 'OTLK')!;
  const steps = computeStepDownData(otlk);
  assert.equal(steps[steps.length - 1].spotPrice, 0.396);

  // EUR live quote works for European options (SAN -> P SNW) in computeActiveOptions
  const activeOpts = computeActiveOptions(
    portfolio.positions,
    portfolio.standalonePositions,
    { SAN: { symbol: 'SAN', shortName: 'Sanofi', regularMarketPrice: 80, regularMarketChange: 0, regularMarketChangePercent: 0, regularMarketDayHigh: 80, regularMarketDayLow: 80, regularMarketVolume: 0, fiftyTwoWeekHigh: 90, fiftyTwoWeekLow: 70, marketCap: 0, exchange: 'SBF' } },
    parsed.positionMarks,
    'EUR',
    parsed.fxRates
  );
  const sanOpt = activeOpts.find((o) => o.contractSymbol.includes('P SNW  20271217 88 M'));
  assert.ok(sanOpt);
  assert.equal(sanOpt!.action, 'LONG');
  assert.equal(sanOpt!.spotPrice, 80);
  // Long Put strike 88 vs spot 80 => +10.0% ITM (in favor of buyer)
  assert.equal(sanOpt!.strikeCushionPct, 10);
});

test('CSV parser reads Deposits & Withdrawals and FX multiplier converts EUR/USD cleanly', () => {
  const csv = [
    'Account Information,Header,Field Name,Field Value',
    'Account Information,Data,Base Currency,EUR',
    'Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount',
    'Deposits & Withdrawals,Data,EUR,2026-03-01,SEPA Deposit,10000',
    'Deposits & Withdrawals,Data,EUR,2026-06-01,Withdrawal,-1500',
  ].join('\n');
  const res = parseIBKRActivityCSV(csv);
  assert.equal(res.depositsBase, 10000);
  assert.equal(res.withdrawalsBase, 1500);
  assert.equal(res.netDepositsBase, 8500);

  assert.equal(getFxMultiplier('USD', 'EUR', { 'EUR->USD': 1.10 }), 1 / 1.10);
  assert.equal(calculateXIRR([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]), 10);
  const monthly = computeMonthlyCashflows([], 'EUR');
  assert.equal(monthly.totalCashflow, 0);
});

test('Unified Ticker Matrix reconciles 100% with Global KPIs, FX Currency Buckets, Closed Tickers, Short OTM Signs & Bucket Invariance', () => {
  installMinimalDomParser();
  const xml = fs.readFileSync('public/assets/aistudio/IBKR_content_5667205778210155609_1c6ba69a.xml', 'utf8');
  const parsed = parseIBKRFlexXML(xml);

  // 1. Per-currency cash extraction from 3-row CashReportCurrency
  assert.ok(parsed.cashByCurrency);
  assert.ok(Math.abs((parsed.cashByCurrency!.EUR || 0) - 843.73) < 0.05);
  assert.ok(Math.abs((parsed.cashByCurrency!.USD || 0) - 2239.33) < 0.05);

  const portfolio = calculatePortfolioState(parsed.transactions, {}, {}, 'EUR', parsed.fxRates, parsed.positionMarks);

  // 2. Algebraic reconciliation: Sum of unifiedTickers === Summary totals
  const sumOpen = portfolio.unifiedTickers.reduce((s, t) => s + t.activeOpenPnlBase, 0);
  const sumRealized = portfolio.unifiedTickers.reduce((s, t) => s + t.realizedPnlBase, 0);
  const sumNet = portfolio.unifiedTickers.reduce((s, t) => s + t.totalNetPnlBase, 0);

  assert.ok(Math.abs(sumOpen - portfolio.summary.totalActiveOpenPnlBase) < 0.01);
  assert.ok(Math.abs(sumRealized - portfolio.summary.totalRealizedAllPnlBase) < 0.01);
  assert.ok(Math.abs(sumNet - portfolio.summary.totalNetAllPnlBase) < 0.01);

  for (const ut of portfolio.unifiedTickers) {
    assert.ok(Math.abs(ut.activeOpenPnlBase + ut.realizedPnlBase - ut.totalNetPnlBase) < 0.01);
    if (ut.annualizedReturnPct !== null) {
      assert.ok(ut.annualizedReturnPct >= -100 && ut.annualizedReturnPct <= 999);
    }
    for (const c of ut.campaigns) {
      if (c.annualizedReturnPct !== null && Math.abs(c.netPnlBase) > 1) {
        if (c.netPnlBase < -1) {
          assert.ok(c.annualizedReturnPct <= 0, `Expected negative/zero annualized return for losing campaign ${ut.ticker} ${c.contractSymbol}, got ${c.annualizedReturnPct}`);
        } else if (c.netPnlBase > 1) {
          assert.ok(c.annualizedReturnPct >= 0, `Expected non-negative annualized return for winning campaign ${ut.ticker} ${c.contractSymbol}, got ${c.annualizedReturnPct}`);
        }
      }
    }
  }

  // 3. Closed tickers (WULF, BMPS, ORCL) appear cleanly with isActive === false & WULF expired short call credit captured
  const wulf = portfolio.unifiedTickers.find((t) => t.ticker === 'WULF');
  const bmps = portfolio.unifiedTickers.find((t) => t.ticker === 'BMPS');
  const orcl = portfolio.unifiedTickers.find((t) => t.ticker === 'ORCL');
  assert.ok(wulf && !wulf.isActive && wulf.realizedPnlNative > 30);
  assert.ok(bmps && !bmps.isActive);
  assert.ok(orcl && !orcl.isActive);

  // 4. CAPR $20 short call is deeply OTM (>135%) and must NEVER be tagged TESTED
  const activeOpts = computeActiveOptions(
    portfolio.positions,
    portfolio.standalonePositions,
    {},
    parsed.positionMarks,
    'EUR',
    parsed.fxRates,
    portfolio.closedPositions
  );
  const capr20C = activeOpts.find((o) => o.contractSymbol.includes('261218C00020000'));
  assert.ok(capr20C);
  assert.equal(capr20C!.action, 'SHORT');
  assert.ok(capr20C!.strikeCushionPct > 135, `Expected CAPR $20C cushion > 135%, got ${capr20C!.strikeCushionPct}`);
  assert.notEqual(capr20C!.statusTag, 'TESTED');

  // 5. Currency Buckets decompose 100% of Net Liq Value (Holdings + Cash)
  const alloc = computeCapitalAllocation(
    portfolio.positions,
    portfolio.standalonePositions,
    parsed.transactions,
    'EUR',
    parsed.fxRates,
    parsed.endingCashBase,
    parsed.cashByCurrency,
    portfolio.closedPositions
  );
  assert.ok(Math.abs(alloc.usdPercent + alloc.eurPercent - 100) < 0.05);
  const expectedNetLiq = portfolio.summary.totalMarketValue + (parsed.endingCashBase || 0);
  assert.ok(Math.abs(alloc.usdAmount + alloc.eurAmount - expectedNetLiq) < 0.25);

  // 6. Toggling a NOK option campaign between LINKED <-> STANDALONE alters Real Entry & Cushion while keeping Total Net P&L invariant
  const nokBefore = portfolio.unifiedTickers.find((t) => t.ticker === 'NOK')!;
  const nokCamp = nokBefore.campaigns.find((c) => c.kind === 'OPTION_CAMPAIGN' && c.bucket === 'LINKED')!;
  const overrides: Record<string, 'LINKED' | 'STANDALONE'> = {};
  for (const id of nokCamp.transactionIds) overrides[id] = 'STANDALONE';

  const toggled = calculatePortfolioState(parsed.transactions, overrides, {}, 'EUR', parsed.fxRates, parsed.positionMarks);
  const nokAfter = toggled.unifiedTickers.find((t) => t.ticker === 'NOK')!;

  assert.notEqual(nokAfter.realEntryPrice, nokBefore.realEntryPrice);
  assert.notEqual(nokAfter.cushionPct, nokBefore.cushionPct);
  assert.ok(Math.abs(nokAfter.totalNetPnlBase - nokBefore.totalNetPnlBase) < 0.01);
  assert.ok(Math.abs(nokAfter.activeOpenPnlBase - nokBefore.activeOpenPnlBase) < 0.01);
  assert.ok(Math.abs(nokAfter.realizedPnlBase - nokBefore.realizedPnlBase) < 0.01);
});

test('Filtered Journal engine computes 1R sizing, 4-state outline priority, attention sort, timeline clusters & 30-trade correlation gate', () => {
  installMinimalDomParser();
  const xml = fs.readFileSync('public/assets/aistudio/IBKR_content_5667205778210155609_1c6ba69a.xml', 'utf8');
  const parsed = parseIBKRFlexXML(xml);
  const portfolio = calculatePortfolioState(parsed.transactions, {}, {}, 'EUR', parsed.fxRates, parsed.positionMarks);

  const now = new Date('2026-11-24T12:00:00Z');
  const liveQuotes: Record<string, any> = {
    CAPR: { symbol: 'CAPR', shortName: 'Capricor', regularMarketPrice: 8.41, regularMarketChange: 0, regularMarketChangePercent: 0 },
    NOK: { symbol: 'NOK', shortName: 'Nokia', regularMarketPrice: 10.50, regularMarketChange: 0, regularMarketChangePercent: 0 },
    OTLK: { symbol: 'OTLK', shortName: 'Outlook', regularMarketPrice: 1.50, regularMarketChange: 0, regularMarketChangePercent: 0 },
    TE: { symbol: 'TE', shortName: 'T1 Energy', regularMarketPrice: 4.50, regularMarketChange: 0, regularMarketChangePercent: 0 },
    TENX: { symbol: 'TENX', shortName: 'Tenax', regularMarketPrice: 16.00, regularMarketChange: 0, regularMarketChangePercent: 0 },
  };

  const overrides = {
    'camp-stk-CAPR': {
      riskPerTrade: 100,
      stopPrice: 10.0, // Current 8.41 <= stop 10 => RED
      target1: 20,
      catalystDate: '2026-12-05',
      catalystType: 'Clinical / FDA' as const,
      thesis: 'BLA submission catalyst',
    },
    'camp-stk-NOK': {
      riskPerTrade: 100,
      stopPrice: 8.20, // Entry ~10.20, current 10.50 => intact, but catalyst in 10d => AMBER
      catalystDate: '2026-12-04',
      catalystType: 'Insider Cluster' as const,
    },
    'camp-stk-OTLK': {
      riskPerTrade: 2000, // Large 1R so currentR > -1 => not RED; fresh live price, no near catalyst => GREEN
      stopPrice: 0.20,
      catalystDate: '2027-06-01',
      catalystType: 'Earnings' as const,
    },
  };

  const secMock = {
    NOK: {
      ticker: 'NOK',
      cik: '0000924613',
      status: 'OK' as const,
      fetchedAt: now.toISOString(),
      source: 'SEC EDGAR',
      filings: [
        { form: '4', filingDate: '2026-11-20', accessionNumber: 'acc-1', description: 'Form 4', secUrl: 'https://www.sec.gov/Archives/edgar/data/1/1/a.xml', isTriggerForm: true },
        { form: '4', filingDate: '2026-11-21', accessionNumber: 'acc-2', description: 'Form 4', secUrl: 'https://www.sec.gov/Archives/edgar/data/1/2/b.xml', isTriggerForm: true },
      ],
    },
  };

  const rows = buildJournalTrades(
    portfolio.unifiedTickers,
    liveQuotes,
    now.toISOString(),
    parsed.positionMarks,
    parsed.fxRates,
    'EUR',
    overrides,
    DEFAULT_JOURNAL_SETTINGS,
    secMock,
    now
  );

  const capr = rows.find((r) => r.ticker === 'CAPR' && r.instrument === 'STOCK' && r.status === 'OPEN')!;
  const nok = rows.find((r) => r.ticker === 'NOK' && r.instrument === 'STOCK' && r.status === 'OPEN')!;
  const otlk = rows.find((r) => r.ticker === 'OTLK' && r.instrument === 'STOCK' && r.status === 'OPEN')!;

  // Verify stable stk::TICKER::date IDs AND lossless legacy override lookup
  assert.ok(capr.id.startsWith('stk::CAPR::'));
  assert.ok(nok.id.startsWith('stk::NOK::'));
  assert.ok(otlk.id.startsWith('stk::OTLK::'));
  assert.equal(capr.thesis, 'BLA submission catalyst');

  assert.equal(capr.signalColor, 'RED');
  assert.ok(capr.signalReasons.some((r) => r.code === 'STOP_HIT'));
  assert.equal(capr.plannedSizeUnits, Math.floor(100 / (capr.entryPrice - 10.0)));

  assert.equal(nok.signalColor, 'AMBER');
  assert.ok(nok.signalReasons.some((r) => r.code === 'NEW_FILING'));
  assert.ok(nok.signalReasons.some((r) => r.code === 'CATALYST_SOON'));
  assert.equal(nok.hasInsiderCluster, true);

  assert.equal(otlk.signalColor, 'GREEN');

  // Default sort order: RED before AMBER before GREEN before GREY
  const openRows = rows.filter((r) => r.status === 'OPEN');
  for (let i = 1; i < openRows.length; i++) {
    assert.ok(openRows[i - 1].signalPriority <= openRows[i].signalPriority);
  }

  // Saved view: Insider-cluster trades includes NOK
  const insiderView = DEFAULT_JOURNAL_SETTINGS.savedViews.find((v) => v.insiderClusterOnly)!;
  const insiderMatches = applyJournalFilters(rows, {
    instrument: 'ALL',
    statusChip: 'OPEN',
    catalystFilter: 'ALL',
    ageFilter: 'ALL',
    activeSavedView: insiderView,
    now,
  });
  assert.ok(insiderMatches.some((r) => r.id === nok.id));

  // Timeline groups CAPR (Dec 5) and NOK (Dec 4) into the same ISO week cluster
  const tl = buildJournalTimeline(openRows, now);
  const decWeek = tl.weeks.find((w) => w.events.some((e) => e.ticker === 'CAPR') && w.events.some((e) => e.ticker === 'NOK'));
  assert.ok(decWeek && decWeek.events.length >= 2);

  // Top strip stats
  const strip = computeJournalTopStrip(rows, 11000, 10);
  assert.ok(strip.totalOpenRiskBase > 0);
  assert.ok(strip.attentionCount >= 2);

  // Analysis tab: Field-Correlation strictly locked below 30 closed trades, unlocked at >= 30
  const closedActual = rows.filter((r) => r.status === 'CLOSED');
  const analysisSmall = computeJournalAnalysis(closedActual);
  if (closedActual.length < 30) {
    assert.equal(analysisSmall.statisticallyMeaningful, false);
    assert.equal(analysisSmall.fieldCorrelations.length, 0);
  }

  const synthetic30: JournalDerivedTrade[] = Array.from({ length: 32 }, (_, idx) => ({
    ...otlk,
    id: `syn-${idx}`,
    status: 'CLOSED',
    exitDate: `2026-06-${String((idx % 28) + 1).padStart(2, '0')}`,
    holdingDays: 5 + idx,
    currentR: idx % 2 === 0 ? 2.5 : -1.0,
    pnlBase: idx % 2 === 0 ? 250 : -100,
    hasInsiderCluster: idx % 2 === 0,
    loggedFields: { insiderCluster: idx % 2 === 0, preCatalystEntry: idx < 16 },
    exitReason: idx % 2 === 0 ? 'target' : 'stop',
    lesson: 'Test lesson',
  }));
  const analysisBig = computeJournalAnalysis(synthetic30);
  assert.equal(analysisBig.statisticallyMeaningful, true);
  assert.ok(analysisBig.fieldCorrelations.length > 0);
  const icCorr = analysisBig.fieldCorrelations.find((c) => c.field === 'Insider Cluster')!;
  assert.ok(icCorr && icCorr.liftR > 3.0);
});

test('8. Safe incremental XML merge: stable trade cycles, bucket-invariant option IDs, cross-source div dedup, snapshot/deposit guards & undo', () => {
  installMinimalDomParser();

  // Base XML #1 (2026-01-01 -> 2026-10-31): Buy 100 ACME @ $10, Sell 1 ACME Call, Accrual dividend
  const xml1 = `
    <FlexQueryResponse>
      <FlexStatements>
        <FlexStatement fromDate="20260101" toDate="20261031" whenGenerated="20261031;210000">
          <AccountInformation currency="EUR" />
          <ConversionRates>
            <ConversionRate reportDate="20261031" fromCurrency="USD" toCurrency="EUR" rate="0.90" />
          </ConversionRates>
          <CashReport>
            <CashReportCurrency currency="BASE_SUMMARY" endingCash="5000" deposits="10000" withdrawals="0" depositWithdrawals="10000" />
            <CashReportCurrency currency="EUR" endingCash="5000" />
          </CashReport>
          <OpenPositions>
            <OpenPosition symbol="ACME" underlyingSymbol="ACME" currency="USD" position="100" markPrice="12.0" positionValue="1200" costBasisMoney="1001" fifoPnlUnrealized="199" />
            <OpenPosition symbol="ACME  261218C00015000" underlyingSymbol="ACME" currency="USD" strike="15" putCall="C" expiry="20261218" position="-1" markPrice="0.80" positionValue="-80" costBasisMoney="-120" fifoPnlUnrealized="40" />
          </OpenPositions>
          <Trades>
            <Trade assetCategory="STK" symbol="ACME" underlyingSymbol="ACME" dateTime="20260210;100000" buySell="BUY" quantity="100" tradePrice="10.00" proceeds="-1000" ibCommission="-1" netCash="-1001" currency="USD" fxRateToBase="0.90" tradeID="10001" />
            <Trade assetCategory="OPT" symbol="ACME  261218C00015000" underlyingSymbol="ACME" dateTime="20260915;110000" buySell="SELL" quantity="-1" tradePrice="1.20" multiplier="100" strike="15" putCall="C" expiry="20261218" proceeds="120" ibCommission="-1" netCash="119" currency="USD" fxRateToBase="0.90" tradeID="10002" />
          </Trades>
          <ChangeInDividendAccruals>
            <ChangeInDividendAccrual underlyingSymbol="ACME" symbol="ACME" date="20260615" grossAmount="-25.00" tax="3.75" fee="0" currency="USD" actionID="99901" />
          </ChangeInDividendAccruals>
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>
  `;

  const p1 = parseIBKRFlexXML(xml1, new Set());
  assert.equal(p1.statementFromDate, '2026-01-01');
  assert.equal(p1.statementToDate, '2026-10-31');

  const m1 = mergePortfolioImport(
    {
      transactions: [],
      fxRates: {},
      positionMarks: {},
      endingCashCurrency: 'EUR',
      bucketOverrides: {},
      journalOverrides: {},
      baseCurrency: 'EUR',
      quotes: {},
    },
    { format: 'XML', ...p1 },
    'ibkr-oct.xml',
    new Date('2026-10-31T22:00:00Z')
  );

  assert.equal(m1.diff.newTransactionsCount, 4); // 1 STK + 1 OPT + 1 DIV + 1 TAX
  assert.equal(m1.nextState.netDepositsBase, 10000);

  // Verify stable IDs and bucket-invariance on option campaign
  const state1 = calculatePortfolioState(
    m1.nextState.transactions,
    m1.nextState.bucketOverrides,
    {},
    'EUR',
    m1.nextState.fxRates,
    m1.nextState.positionMarks
  );
  const optCampBefore = state1.unifiedTickers[0].campaigns.find((c) => c.kind === 'OPTION_CAMPAIGN')!;
  const stkCampBefore = state1.unifiedTickers[0].campaigns.find((c) => c.kind === 'STOCK_LOT')!;
  assert.equal(stkCampBefore.id, 'stk::ACME::2026-02-10');
  assert.equal(optCampBefore.id, 'opt::ACME  261218C00015000::2026-09-15');

  // Toggle option bucket LINKED -> STANDALONE: campaign ID MUST NOT change!
  const optTxId = optCampBefore.transactionIds[0];
  const toggledState = calculatePortfolioState(
    m1.nextState.transactions,
    { [optTxId]: 'STANDALONE' },
    {},
    'EUR',
    m1.nextState.fxRates,
    m1.nextState.positionMarks
  );
  const optCampAfterToggle = toggledState.unifiedTickers[0].campaigns.find((c) => c.kind === 'OPTION_CAMPAIGN')!;
  assert.equal(optCampAfterToggle.id, optCampBefore.id);
  assert.equal(optCampAfterToggle.bucket, 'STANDALONE');

  const userJournalOverrides = {
    'camp-stk-ACME': {
      thesis: 'Original Cycle 1 thesis',
      stopPrice: 8.5,
      manualPriceOverride: 11.5,
      manualPriceTimestamp: '2026-10-20T12:00:00Z',
    },
    [optCampBefore.id]: {
      thesis: 'Covered call income leg',
    },
  };

  // XML #2 (Partial-period rolling drop: 2026-06-01 -> 2026-11-24):
  // - Duplicate ACME buy enriched with openCloseIndicator="O" & listingExchange="NASDAQ"
  // - CashTransactions version of same June 15 dividend -> MUST dedup cross-source!
  // - CashTransaction deposit of +1000 EUR on 2026-11-10 -> MUST add delta to lifetime 10000 => 11000!
  // - Closes Cycle 1 (SELL 100 ACME) & opens Cycle 2 (BUY 50 ACME) -> TWO distinct cycles!
  const xml2 = `
    <FlexQueryResponse>
      <FlexStatements>
        <FlexStatement fromDate="20260601" toDate="20261124" whenGenerated="20261124;200000">
          <AccountInformation currency="EUR" />
          <ConversionRates>
            <ConversionRate reportDate="20261124" fromCurrency="USD" toCurrency="EUR" rate="0.91" />
          </ConversionRates>
          <CashReport>
            <CashReportCurrency currency="BASE_SUMMARY" endingCash="6400" deposits="1000" withdrawals="0" depositWithdrawals="1000" />
            <CashReportCurrency currency="EUR" endingCash="6400" />
          </CashReport>
          <OpenPositions>
            <OpenPosition symbol="ACME" underlyingSymbol="ACME" currency="USD" position="50" markPrice="14.5" positionValue="725" costBasisMoney="701" fifoPnlUnrealized="24" />
            <OpenPosition symbol="ACME  261218C00015000" underlyingSymbol="ACME" currency="USD" strike="15" putCall="C" expiry="20261218" position="-1" markPrice="0.50" positionValue="-50" costBasisMoney="-120" fifoPnlUnrealized="70" />
          </OpenPositions>
          <Trades>
            <Trade assetCategory="STK" symbol="ACME" underlyingSymbol="ACME" dateTime="20260210;100000" buySell="BUY" quantity="100" tradePrice="10.00" proceeds="-1000" ibCommission="-1" netCash="-1001" currency="USD" fxRateToBase="0.90" tradeID="10001" openCloseIndicator="O" listingExchange="NASDAQ" />
            <Trade assetCategory="STK" symbol="ACME" underlyingSymbol="ACME" dateTime="20261105;140000" buySell="SELL" quantity="-100" tradePrice="15.00" proceeds="1500" ibCommission="-1" netCash="1499" currency="USD" fxRateToBase="0.91" tradeID="10003" openCloseIndicator="C" fifoPnlRealized="498" />
            <Trade assetCategory="STK" symbol="ACME" underlyingSymbol="ACME" dateTime="20261120;103000" buySell="BUY" quantity="50" tradePrice="14.00" proceeds="-700" ibCommission="-1" netCash="-701" currency="USD" fxRateToBase="0.91" tradeID="10004" openCloseIndicator="O" />
          </Trades>
          <CashTransactions>
            <CashTransaction type="Dividends" symbol="ACME" underlyingSymbol="ACME" dateTime="20260616" amount="25.00" currency="USD" fxRateToBase="0.90" transactionID="CT-DIV-555" description="ACME Cash Dividend Official" />
            <CashTransaction type="Deposits/Withdrawals" dateTime="20261110" amount="1000" currency="EUR" fxRateToBase="1" transactionID="CT-DEP-777" description="SEPA Transfer" />
          </CashTransactions>
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>
  `;

  const p2 = parseIBKRFlexXML(xml2, new Set());
  const m2 = mergePortfolioImport(
    {
      ...m1.nextState,
      bucketOverrides: { [optTxId]: 'STANDALONE' },
      journalOverrides: userJournalOverrides,
      quotes: {},
    },
    { format: 'XML', ...p2 },
    'ibkr-nov-partial.xml',
    new Date('2026-11-24T21:00:00Z')
  );

  assert.equal(m2.diff.newTransactionsCount, 2);
  assert.equal(m2.diff.crossSourceDividendsSkipped, 1);
  assert.ok(m2.diff.enrichedUpdatedCount >= 1);
  assert.equal(m2.diff.migratedOverridesCount, 1);
  assert.equal(m2.diff.staleManualPricesCleared, 1);
  assert.equal(m2.diff.newlyClosedTrades.length, 1);
  assert.equal(m2.diff.newlyClosedTrades[0].id, 'stk::ACME::2026-02-10');
  assert.equal(m2.diff.newlyClosedTrades[0].needsLesson, true);
  assert.equal(m2.nextState.netDepositsBase, 11000);
  assert.ok(m2.diff.depositsPreservedReason?.includes('Partial-period'));
  assert.equal(m2.nextState.endingCashBase, 6400);

  const state2 = calculatePortfolioState(
    m2.nextState.transactions,
    m2.nextState.bucketOverrides,
    {},
    'EUR',
    m2.nextState.fxRates,
    m2.nextState.positionMarks
  );
  const acmeCycles = state2.unifiedTickers[0].campaigns.filter((c) => c.kind === 'STOCK_LOT');
  assert.equal(acmeCycles.length, 2);
  const c1 = acmeCycles.find((c) => c.id === 'stk::ACME::2026-02-10')!;
  const c2 = acmeCycles.find((c) => c.id === 'stk::ACME::2026-11-20')!;
  assert.equal(c1.status, 'CLOSED');
  assert.equal(c2.status, 'OPEN');
  assert.equal(m2.nextState.journalOverrides[c1.id]?.thesis, 'Original Cycle 1 thesis');
  assert.equal(m2.nextState.journalOverrides[c1.id]?.manualPriceOverride, undefined);
  assert.equal(m2.nextState.journalOverrides[c2.id], undefined);
  assert.equal(m2.nextState.journalOverrides[optCampBefore.id]?.thesis, 'Covered call income leg');
  assert.equal(m2.nextState.bucketOverrides[optTxId], 'STANDALONE');

  // XML #3 (Older XML drop: 2025-01-01 -> 2025-12-31): Must guard marks/cash/deposits!
  const xmlOld = `
    <FlexQueryResponse>
      <FlexStatements>
        <FlexStatement fromDate="20250101" toDate="20251231">
          <AccountInformation currency="EUR" />
          <CashReport>
            <CashReportCurrency currency="BASE_SUMMARY" endingCash="1200" deposits="3000" withdrawals="0" depositWithdrawals="3000" />
          </CashReport>
          <OpenPositions>
            <OpenPosition symbol="ACME" underlyingSymbol="ACME" currency="USD" position="10" markPrice="5.0" positionValue="50" costBasisMoney="50" fifoPnlUnrealized="0" />
          </OpenPositions>
          <Trades>
            <Trade assetCategory="STK" symbol="OLDX" underlyingSymbol="OLDX" dateTime="20250501;100000" buySell="BUY" quantity="10" tradePrice="20" proceeds="-200" ibCommission="-1" netCash="-201" currency="USD" fxRateToBase="0.90" tradeID="90001" />
          </Trades>
        </FlexStatement>
      </FlexStatements>
    </FlexQueryResponse>
  `;
  const pOld = parseIBKRFlexXML(xmlOld, new Set());
  const m3 = mergePortfolioImport(
    { ...m2.nextState, quotes: {} },
    { format: 'XML', ...pOld },
    'ibkr-2025-archive.xml'
  );
  assert.equal(m3.diff.newTransactionsCount, 1);
  assert.equal(m3.diff.snapshotUpdated, false);
  assert.ok(m3.diff.snapshotGuardReason?.includes('Older statement'));
  assert.equal(m3.nextState.endingCashBase, 6400);
  assert.equal(m3.nextState.netDepositsBase, 11000);
  assert.equal(m3.nextState.positionMarks['ACME']?.markPrice, 14.5);
  assert.equal(m3.undoSnapshot.transactions.length, m2.nextState.transactions.length);

  const reMig = migrateLegacyJournalOverrides(m2.nextState.journalOverrides, state2.unifiedTickers);
  assert.equal(reMig.migratedCount, 0);
});

test('9. Smart Form 4 XML parsing, routine noise filtering, URL sanitizer & AI intel signal precedence', () => {
  // 1. Strip XSLT prefix & URL sanitization
  assert.equal(stripSecXsltPrefix('xslF345X05/wf-form4_12345.xml'), 'wf-form4_12345.xml');
  assert.equal(stripSecXsltPrefix('form4.xml'), 'form4.xml');
  assert.equal(sanitizeExternalUrl('https://www.sec.gov/Archives/edgar/data/1/2/doc.htm'), 'https://www.sec.gov/Archives/edgar/data/1/2/doc.htm');
  assert.equal(sanitizeExternalUrl('javascript:alert(1)'), undefined);
  assert.equal(sanitizeExternalUrl('http://127.0.0.1:3000/api/sec-filings'), undefined);
  assert.equal(sanitizeExternalUrl('http://169.254.169.254/latest/meta-data/'), undefined);

  // 2. Parse Form 4 XML: Open-market Buy (Code P) vs Routine RSU Grant/Tax (A + F)
  const form4BuyXml = `
    <ownershipDocument>
      <reportingOwner>
        <reportingOwnerId><rptOwnerName>Jane Doe</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>1</isDirector><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship>
      </reportingOwner>
      <nonDerivativeTable>
        <nonDerivativeTransaction>
          <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
          <transactionAmounts>
            <transactionShares><value>25000</value></transactionShares>
            <transactionPricePerShare><value>14.20</value></transactionPricePerShare>
          </transactionAmounts>
        </nonDerivativeTransaction>
      </nonDerivativeTable>
    </ownershipDocument>
  `;
  const buySummary = parseForm4Xml(form4BuyXml)!;
  assert.equal(buySummary.isOpenMarketBuy, true);
  assert.equal(buySummary.isRoutineNoise, false);
  assert.equal(buySummary.transactionCode, 'P');
  assert.equal(buySummary.shares, 25000);
  assert.equal(buySummary.pricePerShare, 14.2);
  assert.equal(buySummary.insiderRole, 'Chief Executive Officer');

  const form4GrantXml = `
    <ownershipDocument>
      <reportingOwner>
        <reportingOwnerId><rptOwnerName>John Smith</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship>
      </reportingOwner>
      <nonDerivativeTable>
        <nonDerivativeTransaction>
          <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
          <transactionAmounts>
            <transactionShares><value>10000</value></transactionShares>
            <transactionPricePerShare><value>0</value></transactionPricePerShare>
          </transactionAmounts>
        </nonDerivativeTransaction>
        <nonDerivativeTransaction>
          <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
          <transactionAmounts>
            <transactionShares><value>3000</value></transactionShares>
            <transactionPricePerShare><value>14.00</value></transactionPricePerShare>
          </transactionAmounts>
        </nonDerivativeTransaction>
      </nonDerivativeTable>
    </ownershipDocument>
  `;
  const grantSummary = parseForm4Xml(form4GrantXml)!;
  assert.equal(grantSummary.isOpenMarketBuy, false);
  assert.equal(grantSummary.isOpenMarketSale, false);
  assert.equal(grantSummary.isRoutineNoise, true);

  // 3. Smart Form 4 cluster & trigger filtering: 2 routine grants MUST NOT trigger Insider Cluster or Amber alert
  const nowMs = new Date('2026-11-24T12:00:00Z').getTime();
  const routineFilings: SecFilingItem[] = [
    { form: '4', filingDate: '2026-11-20', reportDate: '2026-11-19', accessionNumber: '1', description: '4', secUrl: 'https://www.sec.gov/1', isTriggerForm: true, form4Summary: grantSummary },
    { form: '4', filingDate: '2026-11-21', reportDate: '2026-11-20', accessionNumber: '2', description: '4', secUrl: 'https://www.sec.gov/2', isTriggerForm: true, form4Summary: grantSummary },
  ];
  assert.equal(detectAutoInsiderCluster(routineFilings, nowMs), false);
  assert.equal(getNewTriggerFilings(routineFilings, undefined, nowMs).length, 0);

  const realClusterFilings: SecFilingItem[] = [
    { form: '4', filingDate: '2026-11-20', reportDate: '2026-11-19', accessionNumber: '3', description: '4', secUrl: 'https://www.sec.gov/3', isTriggerForm: true, form4Summary: buySummary },
    { form: '4', filingDate: '2026-11-22', reportDate: '2026-11-21', accessionNumber: '4', description: '4', secUrl: 'https://www.sec.gov/4', isTriggerForm: true, form4Summary: buySummary },
  ];
  assert.equal(detectAutoInsiderCluster(realClusterFilings, nowMs), true);
  assert.equal(getNewTriggerFilings(realClusterFilings, undefined, nowMs).length, 2);

  // 4. AI intel & Option-Expiry Mismatch trigger AMBER, and never override RED
  const txs: Transaction[] = [
    {
      id: 't-stk',
      date: '2026-10-01',
      dateTime: '2026-10-01 14:00:00',
      section: 'Trades',
      assetCategory: 'STK',
      symbol: 'BIOX',
      underlying: 'BIOX',
      action: 'BUY',
      quantity: 10,
      price: 20,
      multiplier: 1,
      proceeds: -200,
      commission: 0,
      netCashFlow: -200,
      currency: 'USD',
      fxRateToBase: 1,
      tradeId: 't-stk',
      defaultBucket: 'LINKED',
      bucket: 'LINKED',
    },
    {
      id: 't-opt',
      date: '2026-10-05',
      dateTime: '2026-10-05 14:00:00',
      section: 'Trades',
      assetCategory: 'OPT',
      symbol: 'BIOX 261218C00025000',
      underlying: 'BIOX',
      action: 'BUY',
      quantity: 1,
      price: 1.0,
      multiplier: 100,
      proceeds: -100,
      commission: 0,
      netCashFlow: -100,
      currency: 'USD',
      fxRateToBase: 1,
      tradeId: 't-opt',
      optionDetails: {
        type: 'CALL',
        strike: 25,
        expiry: '2026-12-18',
        isShort: false,
      },
      defaultBucket: 'STANDALONE',
      bucket: 'STANDALONE',
    },
  ];
  const optMarks = {
    'BIOX 261218C00025000': {
      symbol: 'BIOX 261218C00025000',
      underlying: 'BIOX',
      assetCategory: 'OPT' as const,
      currency: 'USD',
      position: 1,
      markPrice: 1.1,
      positionValue: 110,
      costBasisMoney: 100,
      fifoPnlUnrealized: 10,
    },
  };
  const bioxQuotes = {
    BIOX: {
      symbol: 'BIOX',
      shortName: 'BioX',
      regularMarketPrice: 21,
      regularMarketChange: 0.5,
      regularMarketChangePercent: 2.4,
    },
  };
  const state = calculatePortfolioState(
    txs,
    {},
    bioxQuotes,
    'USD',
    { USD: 1 },
    optMarks
  );

  const stkId = 'stk::BIOX::2026-10-01';
  const optId = 'opt::BIOX 261218C00025000::2026-10-05';
  const intelMap: Record<string, JournalTradeIntel> = {
    [stkId]: {
      ticker: 'BIOX',
      analyzedAt: '2026-11-24T10:00:00Z',
      source: 'SEC EDGAR + Gemini Search Grounding',
      thesisCheck: { verdict: 'RISK', summary: '8-K announced unexpected shelf offering.', evidence: 'S-3 filed.' },
      filingDigests: [],
      catalystRadar: { eventLabel: 'Phase 3 Readout', timelineDrift: 'DELAYED', driftNote: 'Shifted to Q2 2027' },
      runwayAndDilution: { dilutionRisk: 'HIGH', atmOrShelfNote: 'Active ATM' },
      sources: [],
    },
    [optId]: {
      ticker: 'BIOX',
      analyzedAt: '2026-11-24T10:00:00Z',
      source: 'SEC EDGAR + Gemini Search Grounding',
      thesisCheck: { verdict: 'ALIGNED', summary: 'Aligned', evidence: '' },
      filingDigests: [],
      catalystRadar: { eventLabel: 'FDA PDUFA', suggestedDate: '2027-01-15', timelineDrift: 'ON_TRACK' },
      runwayAndDilution: { dilutionRisk: 'LOW', atmOrShelfNote: 'Funded' },
      sources: [],
    },
  };

  const rows = buildJournalTrades(
    state.unifiedTickers,
    bioxQuotes,
    '2026-11-24T11:55:00Z',
    optMarks,
    { USD: 1 },
    'USD',
    {},
    DEFAULT_JOURNAL_SETTINGS,
    {},
    new Date('2026-11-24T12:00:00Z'),
    intelMap
  );

  const stkRow = rows.find((r) => r.id === stkId)!;
  const optRow = rows.find((r) => r.id === optId)!;
  assert.equal(stkRow.signalColor, 'AMBER');
  assert.ok(stkRow.signalReasons.some((r) => r.code === 'AI_THESIS_RISK'));
  assert.ok(stkRow.signalReasons.some((r) => r.code === 'CATALYST_DELAYED'));

  assert.equal(optRow.signalColor, 'AMBER');
  assert.ok(optRow.signalReasons.some((r) => r.code === 'OPTION_EXPIRY_MISMATCH'));

  // Ensure RED (thesisBroken) still strictly overrides AMBER AI intel
  const redRows = buildJournalTrades(
    state.unifiedTickers,
    { BIOX: { symbol: 'BIOX', shortName: 'BioX', regularMarketPrice: 21, regularMarketChange: 0.5, regularMarketChangePercent: 2.4 } },
    '2026-11-24T11:55:00Z',
    {},
    { USD: 1 },
    'USD',
    { [stkId]: { thesisBroken: true } },
    DEFAULT_JOURNAL_SETTINGS,
    {},
    new Date('2026-11-24T12:00:00Z'),
    intelMap
  );
  assert.equal(redRows.find((r) => r.id === stkId)!.signalColor, 'RED');
});



