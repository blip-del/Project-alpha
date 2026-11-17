import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseIBKRFlexXML, parseIBKRActivityCSV, resolveUnderlyingTicker, assignSmartOptionBuckets } from './ibkrParser';
import { calculatePortfolioState, calculateDownsideCushionPct, getFxMultiplier } from './portfolioEngine';
import { calculateXIRR, computeStepDownData, computeMonthlyCashflows, computeActiveOptions } from './analyticsEngine';
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
  assert.equal(sanOpt!.spotPrice, 80);
  // Put strike 88 vs spot 80 => ITM by -10.0%
  assert.equal(sanOpt!.strikeCushionPct, -10);
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
