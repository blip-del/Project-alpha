import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIBKRFlexXML, parseIBKRActivityCSV, resolveUnderlyingTicker, assignSmartOptionBuckets } from './ibkrParser';
import { calculatePortfolioState, calculateDownsideCushionPct, getFxMultiplier } from './portfolioEngine';
import { calculateXIRR, computeStepDownData, computeMonthlyCashflows, computeActiveOptions, computeCapitalAllocation } from './analyticsEngine';
import type { Transaction } from '../types';

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

