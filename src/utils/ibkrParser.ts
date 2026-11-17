/**
 * Interactive Brokers (IBKR) Multi-Section Activity Statement CSV Parser
 * Offline-capable client-side parser, deduplication engine, and demo portfolio generator.
 */

import { Transaction, AssetCategory, TradeAction, BucketType, OptionDetails, PositionMark } from '../types';

/**
 * Normalize IBKR date strings (DD/MM/YYYY;HHMMSS, YYYYMMDD;HHMMSS, YYYY-MM-DD;HHMMSS) -> YYYY-MM-DD HH:mm:ss or YYYY-MM-DD
 */
export function normalizeIBKRDate(raw: string): string {
  const clean = (raw || '').trim();
  if (!clean) return '';

  // Format: YYYYMMDD[;T\s]HHMMSS
  let m = clean.match(/^(\d{4})(\d{2})(\d{2})(?:[;T\s](\d{2}):?(\d{2}):?(\d{2}))?/);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return m[4] ? `${d} ${m[4]}:${m[5] || '00'}:${m[6] || '00'}` : d;
  }

  // Format: DD/MM/YYYY[;T\s]HHMMSS
  m = clean.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[;T\s](\d{2}):?(\d{2}):?(\d{2}))?/);
  if (m) {
    const d = `${m[3]}-${m[2]}-${m[1]}`;
    return m[4] ? `${d} ${m[4]}:${m[5] || '00'}:${m[6] || '00'}` : d;
  }

  // Format: YYYY-MM-DD[;T\s]HHMMSS
  m = clean.match(/^(\d{4})-(\d{2})-(\d{2})(?:[;T\s](\d{2}):?(\d{2}):?(\d{2}))?/);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return m[4] ? `${d} ${m[4]}:${m[5] || '00'}:${m[6] || '00'}` : d;
  }

  return clean.replace(';', ' ');
}

/**
 * Resolve consistent underlying ticker across corporate-action suffixes (e.g. BMPSm -> BMPS, SAN1 -> SAN)
 */
export function resolveUnderlyingTicker(symbol: string, underlyingAttr: string, assetCat: string): string {
  const sym = (symbol || '').trim().toUpperCase();
  const und = (underlyingAttr || '').trim().toUpperCase();

  const stripCorpDigits = (t: string) => t.replace(/^([A-Z]{2,6})\d+$/, '$1');

  if (assetCat === 'STK') {
    if (und && sym.startsWith(und) && sym.length <= und.length + 2) {
      return stripCorpDigits(und); // e.g. symbol="BMPSm", underlyingSymbol="BMPS" -> "BMPS", or "SAN1" -> "SAN"
    }
    if (und && sym && stripCorpDigits(und) === stripCorpDigits(sym)) {
      return stripCorpDigits(sym); // e.g. symbol="SAN", underlyingSymbol="SAN1" -> "SAN"
    }
    return stripCorpDigits(sym || und);
  }

  const raw = und || parseOptionSymbol(sym).underlying;
  // Strip trailing corporate-action digits on European/split underlyings (e.g. SAN1 -> SAN)
  return stripCorpDigits(raw);
}

/**
 * Chronologically classify option trades into Bucket A (LINKED) vs Bucket B (STANDALONE),
 * ensuring closing legs inherit the exact bucket of the opening leg on the same contract.
 */
export function assignSmartOptionBuckets(transactions: Transaction[]): Transaction[] {
  const sorted = [...transactions].sort((a, b) => {
    const tA = new Date(a.dateTime).getTime() || 0;
    const tB = new Date(b.dateTime).getTime() || 0;
    if (tA !== tB) return tA - tB;
    const rank: Record<string, number> = { STK: 1, CORP_ACTION: 2, OPT: 3, DIV: 4, TAX: 5, CASH: 6 };
    return (rank[a.assetCategory] || 9) - (rank[b.assetCategory] || 9);
  });

  // Identify underlyings where shares were traded
  const stockUnderlyings = new Set<string>();
  for (const tx of sorted) {
    if (tx.assetCategory === 'STK') {
      stockUnderlyings.add(tx.underlying);
    }
  }

  const openQtyByContract = new Map<string, number>();
  const openBucketByContract = new Map<string, BucketType>();

  for (const tx of sorted) {
    if (tx.assetCategory !== 'OPT') {
      tx.defaultBucket = 'LINKED';
      tx.bucket = 'LINKED';
      continue;
    }

    const prevQty = openQtyByContract.get(tx.symbol) || 0;
    const prevBucket = openBucketByContract.get(tx.symbol);
    const isClosing =
      tx.openCloseIndicator === 'C' ||
      (prevQty > 0 && tx.quantity < 0) ||
      (prevQty < 0 && tx.quantity > 0);

    let resolvedBucket: BucketType;
    if (isClosing && prevBucket) {
      resolvedBucket = prevBucket;
    } else if (tx.action === 'BUY') {
      resolvedBucket = 'STANDALONE';
    } else {
      // SELL to Open: LINKED only if underlying has stock holdings/trades, otherwise STANDALONE credit trade
      resolvedBucket = stockUnderlyings.has(tx.underlying) ? 'LINKED' : 'STANDALONE';
    }

    const nextQty = prevQty + tx.quantity;
    openQtyByContract.set(tx.symbol, nextQty);
    if (Math.abs(nextQty) < 1e-6) {
      openQtyByContract.set(tx.symbol, 0);
      openBucketByContract.delete(tx.symbol);
    } else if (!prevBucket || Math.sign(prevQty) !== Math.sign(nextQty)) {
      openBucketByContract.set(tx.symbol, resolvedBucket);
    }

    tx.defaultBucket = resolvedBucket;
    tx.bucket = resolvedBucket;
  }

  return sorted;
}

/**
 * Generate a deterministic deduplication hash for any transaction
 */
export function generateTransactionHash(
  dateTime: string,
  symbol: string,
  quantity: number,
  price: number,
  tradeId?: string
): string {
  const cleanDate = (dateTime || '').trim();
  const cleanSym = (symbol || '').trim().toUpperCase();
  const qStr = Number(quantity || 0).toFixed(4);
  const pStr = Number(price || 0).toFixed(4);
  const tid = (tradeId || '').trim();

  // Fast DJB2 string hash
  const raw = `${cleanDate}|${cleanSym}|${qStr}|${pStr}|${tid}`;
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 33) ^ raw.charCodeAt(i);
  }
  return `tx-${Math.abs(hash).toString(36)}-${Math.abs(hash % 99999)}`;
}

/**
 * Parse an OCC Option symbol (e.g. "NVDA  240517C00085000" or "NVDA 240517C85")
 * or standard IBKR format "NVDA 2024-05-17 85 C"
 */
export function parseOptionSymbol(symbol: string): {
  underlying: string;
  details?: OptionDetails;
} {
  const clean = symbol.trim();

  // Pattern 1: OCC Symbol format "NVDA  240517C00085000"
  const occMatch = clean.match(/^([A-Za-z]+)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (occMatch) {
    const underlying = occMatch[1].toUpperCase();
    const yy = parseInt(occMatch[2], 10);
    const mm = occMatch[3];
    const dd = occMatch[4];
    const type = occMatch[5] === 'C' ? 'CALL' : 'PUT';
    const strike = parseInt(occMatch[6], 10) / 1000;
    const year = yy >= 70 ? 1900 + yy : 2000 + yy;
    const expiry = `${year}-${mm}-${dd}`;
    return {
      underlying,
      details: {
        type,
        strike,
        expiry,
        isShort: false,
      },
    };
  }

  // Pattern 2: IBKR format e.g. "NVDA 17MAY24 140 C" or "NVDA 2024-05-17 140 C"
  const ibkrMatch = clean.match(/^([A-Za-z]+)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}[A-Za-z]{3}\d{2})\s+(\d+(?:\.\d+)?)\s+([CP])/i);
  if (ibkrMatch) {
    const underlying = ibkrMatch[1].toUpperCase();
    const dateStr = ibkrMatch[2];
    const strike = parseFloat(ibkrMatch[3]);
    const type = ibkrMatch[4].toUpperCase() === 'C' ? 'CALL' : 'PUT';
    
    // Normalize dateStr if e.g. 17MAY24
    let expiry = dateStr;
    if (!dateStr.includes('-')) {
      const dMatch = dateStr.match(/^(\d{1,2})([A-Za-z]{3})(\d{2})$/);
      if (dMatch) {
        const months: Record<string, string> = {
          JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
          JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
        };
        const day = dMatch[1].padStart(2, '0');
        const month = months[dMatch[2].toUpperCase()] || '01';
        const year = 2000 + parseInt(dMatch[3], 10);
        expiry = `${year}-${month}-${day}`;
      }
    }

    return {
      underlying,
      details: {
        type,
        strike,
        expiry,
        isShort: false,
      },
    };
  }

  // Fallback: If contains a space, first token is underlying
  if (clean.includes(' ')) {
    const parts = clean.split(' ');
    return { underlying: parts[0].toUpperCase() };
  }

  return { underlying: clean.toUpperCase() };
}

/**
 * Parse an IBKR Multi-Section Activity Statement CSV string
 */
export function parseIBKRActivityCSV(
  csvContent: string,
  existingTransactionIds: Set<string> = new Set()
): {
  transactions: Transaction[];
  duplicatesSkipped: number;
  sectionsFound: string[];
  baseCurrency: 'EUR' | 'USD';
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  errors: string[];
} {
  const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const sectionsFound = new Set<string>();
  const transactions: Transaction[] = [];
  let duplicatesSkipped = 0;
  let baseCurrency: 'EUR' | 'USD' = 'EUR';
  let depositsSum = 0;
  let withdrawalsSum = 0;
  let hasDepositRows = false;
  const errors: string[] = [];

  // Group rows by Section -> Header / Data
  const sectionHeaders: Record<string, string[]> = {};

  // Simple CSV line parser respecting quotes
  function parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += char;
      }
    }
    result.push(cur.trim());
    return result;
  }

  // Pre-scan to detect headers and base currency
  for (const line of lines) {
    const cols = parseCSVLine(line);
    if (cols.length < 2) continue;

    const section = cols[0];
    const rowType = cols[1]; // Header, Data, Total, SubTotal

    sectionsFound.add(section);

    if (rowType === 'Header') {
      sectionHeaders[section] = cols.slice(2).map((c) => c.toLowerCase().replace(/[^a-z0-9]/g, ''));
    }

    // Check Base Currency in Account Information or Statement section
    if (section === 'Account Information' && cols[2] && cols[3]) {
      if (cols[2].toLowerCase().includes('base currency')) {
        const b = cols[3].toUpperCase();
        if (b === 'USD' || b === 'EUR') baseCurrency = b;
      }
    }
  }

  // Process data rows
  for (const line of lines) {
    const cols = parseCSVLine(line);
    if (cols.length < 3) continue;

    const section = cols[0];
    const rowType = cols[1];

    if (rowType !== 'Data' && rowType !== 'Order') continue;

    const headers = sectionHeaders[section] || [];
    const getVal = (nameRegex: RegExp): string => {
      const idx = headers.findIndex((h) => nameRegex.test(h));
      if (idx !== -1 && cols[idx + 2] !== undefined) {
        return cols[idx + 2];
      }
      return '';
    };

    // 1. TRADES SECTION
    if (section === 'Trades') {
      try {
        const assetCatRaw = getVal(/assetcategory|assetclass/);
        const symbol = getVal(/^symbol$/);
        if (!symbol) continue;

        const dateVal = normalizeIBKRDate(getVal(/datetime|date/));
        const qtyVal = parseFloat(getVal(/^quantity$/).replace(/,/g, ''));
        const priceVal = Math.abs(parseFloat(getVal(/tprice|tradeprice|price/).replace(/,/g, '')));
        const multiplierVal = parseFloat(getVal(/multiplier/).replace(/,/g, '') || '0');
        const proceedsVal = parseFloat(getVal(/^proceeds$/).replace(/,/g, '') || '0');
        const commVal = parseFloat(getVal(/commfee|commission|ibcommission/).replace(/,/g, '') || '0');
        const realizedPnlVal = parseFloat(getVal(/realizedpl|realizedpnl/).replace(/,/g, '') || '0');
        const currency = (getVal(/^currency$/) || 'USD').toUpperCase();
        const fxRateVal = parseFloat(getVal(/fxratetobase|fxrate/).replace(/,/g, '') || '1');
        const tradeId = getVal(/tradeid|orderid/) || '';
        const codeCol = getVal(/^code$/).toUpperCase();
        const openCloseIndicator: 'O' | 'C' | undefined = codeCol.includes('C') ? 'C' : codeCol.includes('O') ? 'O' : undefined;

        const isOption = assetCatRaw.toLowerCase().includes('opt') ||
          assetCatRaw.toLowerCase().includes('option') ||
          /[CP]\d{6,}/.test(symbol) ||
          symbol.includes(' 202');

        const assetCategory: AssetCategory = isOption ? 'OPT' : 'STK';
        const multiplier = multiplierVal > 0 ? multiplierVal : isOption ? 100 : 1;
        const { underlying: parsedUnderlying, details } = parseOptionSymbol(symbol);
        const underlying = resolveUnderlyingTicker(symbol, parsedUnderlying, assetCategory);

        const action: TradeAction = qtyVal > 0 ? 'BUY' : 'SELL';
        if (details) {
          details.isShort = action === 'SELL';
        }

        const defaultBucket: BucketType = !isOption
          ? 'LINKED'
          : action === 'SELL'
          ? 'LINKED'
          : 'STANDALONE';

        const dateTimeStr = dateVal || new Date().toISOString().slice(0, 10);
        const dateOnly = dateTimeStr.split(',')[0].split(' ')[0];

        const id = generateTransactionHash(dateTimeStr, symbol, qtyVal, priceVal, tradeId);

        if (existingTransactionIds.has(id)) {
          duplicatesSkipped++;
          continue;
        }

        const netCash = proceedsVal !== 0
          ? proceedsVal + commVal
          : (action === 'BUY' ? -(Math.abs(qtyVal) * priceVal * multiplier) : Math.abs(qtyVal) * priceVal * multiplier) + commVal;

        transactions.push({
          id,
          dateTime: dateTimeStr,
          date: dateOnly,
          section: 'Trades',
          assetCategory,
          symbol,
          underlying,
          action,
          quantity: qtyVal,
          price: priceVal,
          multiplier,
          proceeds: proceedsVal,
          commission: commVal,
          netCashFlow: netCash,
          currency,
          fxRateToBase: isNaN(fxRateVal) || fxRateVal <= 0 ? 1 : fxRateVal,
          realizedPnl: realizedPnlVal,
          openCloseIndicator,
          tradeId: tradeId || id,
          optionDetails: details,
          defaultBucket,
          bucket: defaultBucket,
        });
      } catch (err: any) {
        errors.push(`Trades row error: ${err.message}`);
      }
    }

    // 2. DIVIDENDS SECTION
    else if (section === 'Dividends' || section === 'Change in Dividend Accruals') {
      try {
        const desc = getVal(/description/) || cols[4] || '';
        const dateVal = getVal(/^date$/) || getVal(/paydate/) || cols[3] || '';
        const amountVal = parseFloat(getVal(/^amount$/).replace(/,/g, '') || cols[cols.length - 1] || '0');
        const currency = (getVal(/^currency$/) || cols[2] || 'USD').toUpperCase();

        if (amountVal > 0 && desc) {
          // Extract symbol from e.g. "NVDA(US67066G1040) Cash Dividend..."
          let symMatch = desc.match(/^([A-Za-z]+)(?:\([A-Za-z0-9]+\))?/);
          const underlying = symMatch ? symMatch[1].toUpperCase() : 'UNKNOWN';

          const id = generateTransactionHash(dateVal, `DIV_${underlying}`, 1, amountVal, desc.slice(0, 20));

          if (existingTransactionIds.has(id)) {
            duplicatesSkipped++;
            continue;
          }

          transactions.push({
            id,
            dateTime: dateVal,
            date: dateVal,
            section: 'Dividends',
            assetCategory: 'DIV',
            symbol: underlying,
            underlying,
            action: 'DIV',
            quantity: 1,
            price: amountVal,
            proceeds: amountVal,
            commission: 0,
            netCashFlow: amountVal,
            currency,
            fxRateToBase: 1,
            tradeId: `div-${id}`,
            notes: desc,
            defaultBucket: 'LINKED',
            bucket: 'LINKED',
          });
        }
      } catch (err: any) {
        errors.push(`Dividend row error: ${err.message}`);
      }
    }

    // 3. WITHHOLDING TAX SECTION
    else if (section === 'Withholding Tax') {
      try {
        const desc = getVal(/description/) || cols[4] || '';
        const dateVal = getVal(/^date$/) || cols[3] || '';
        const amountVal = parseFloat(getVal(/^amount$/).replace(/,/g, '') || cols[cols.length - 1] || '0');
        const currency = (getVal(/^currency$/) || cols[2] || 'USD').toUpperCase();

        if (amountVal !== 0 && desc) {
          let symMatch = desc.match(/^([A-Za-z]+)(?:\([A-Za-z0-9]+\))?/);
          const underlying = symMatch ? symMatch[1].toUpperCase() : 'UNKNOWN';

          const id = generateTransactionHash(dateVal, `TAX_${underlying}`, 1, Math.abs(amountVal), desc.slice(0, 20));

          if (existingTransactionIds.has(id)) {
            duplicatesSkipped++;
            continue;
          }

          transactions.push({
            id,
            dateTime: dateVal,
            date: dateVal,
            section: 'Withholding Tax',
            assetCategory: 'TAX',
            symbol: underlying,
            underlying,
            action: 'TAX',
            quantity: 1,
            price: -Math.abs(amountVal),
            proceeds: -Math.abs(amountVal),
            commission: 0,
            netCashFlow: -Math.abs(amountVal),
            currency,
            fxRateToBase: 1,
            tradeId: `tax-${id}`,
            notes: desc,
            defaultBucket: 'LINKED',
            bucket: 'LINKED',
          });
        }
      } catch (err: any) {
        errors.push(`Withholding tax error: ${err.message}`);
      }
    }

    // 4. CORPORATE ACTIONS (Splits)
    else if (section === 'Corporate Actions') {
      try {
        const desc = getVal(/description/) || cols[4] || '';
        const dateVal = getVal(/^date$/) || cols[3] || '';
        const sym = getVal(/^symbol$/) || cols[2] || '';
        const { underlying } = parseOptionSymbol(sym);

        // Check for split ratio e.g. "FORWARD SPLIT 10 FOR 1" or "10 for 1"
        const splitMatch = desc.match(/(\d+)\s+FOR\s+(\d+)/i);
        if (splitMatch) {
          const newShares = parseFloat(splitMatch[1]);
          const oldShares = parseFloat(splitMatch[2]);
          const ratio = newShares / oldShares;

          const id = generateTransactionHash(dateVal, `SPLIT_${underlying}`, ratio, 0, 'SPLIT');

          if (!existingTransactionIds.has(id)) {
            transactions.push({
              id,
              dateTime: dateVal,
              date: dateVal,
              section: 'Corporate Actions',
              assetCategory: 'CORP_ACTION',
              symbol: underlying,
              underlying,
              action: 'SPLIT',
              quantity: ratio,
              price: 0,
              proceeds: 0,
              commission: 0,
              netCashFlow: 0,
              currency: 'USD',
              fxRateToBase: 1,
              tradeId: `split-${id}`,
              notes: desc,
              defaultBucket: 'LINKED',
              bucket: 'LINKED',
              corporateAction: {
                type: 'SPLIT',
                ratio,
              },
            });
          }
        }
      } catch (err: any) {
        errors.push(`Corp actions error: ${err.message}`);
      }
    }

    // 5. DEPOSITS & WITHDRAWALS SECTION
    else if (section === 'Deposits & Withdrawals' || section === 'Deposits/Withdrawals') {
      try {
        const amountVal = parseFloat((getVal(/^amount$/) || cols[cols.length - 1] || '0').replace(/,/g, ''));
        if (!isNaN(amountVal) && amountVal !== 0) {
          hasDepositRows = true;
          if (amountVal > 0) depositsSum += amountVal;
          else withdrawalsSum += Math.abs(amountVal);
        }
      } catch {
        // Ignore malformed deposit subtotal rows
      }
    }
  }

  // Sort transactions chronologically and classify option buckets cleanly
  const classified = assignSmartOptionBuckets(transactions);

  return {
    transactions: classified,
    duplicatesSkipped,
    sectionsFound: Array.from(sectionsFound),
    baseCurrency,
    depositsBase: hasDepositRows ? depositsSum : undefined,
    withdrawalsBase: hasDepositRows ? withdrawalsSum : undefined,
    netDepositsBase: hasDepositRows ? depositsSum - withdrawalsSum : undefined,
    errors,
  };
}

/**
 * Generate rich, realistic multi-year demo portfolio transactions
 * covering NVDA, AAPL, TSLA, SPY, ASML with buys, partial sales,
 * splits, covered call rolls, net dividends, and standalone long calls.
 */
export function getDemoPortfolioTransactions(): Transaction[] {
  const demoList: Transaction[] = [];

  const addTx = (t: Omit<Transaction, 'id' | 'defaultBucket' | 'bucket'> & { bucket?: BucketType }) => {
    const isOption = t.assetCategory === 'OPT';
    const defaultBucket: BucketType = t.bucket || (!isOption
      ? 'LINKED'
      : t.action === 'SELL'
      ? 'LINKED'
      : 'STANDALONE');
    const id = generateTransactionHash(t.dateTime, t.symbol, t.quantity, t.price, t.tradeId);
    demoList.push({
      ...t,
      id,
      defaultBucket,
      bucket: t.bucket || defaultBucket,
    });
  };

  // -------------------------------------------------------------
  // NVDA: Core Growth + Covered Call Roll Campaign + 10:1 Split
  // -------------------------------------------------------------
  // 1. Initial pre-split stock buys
  addTx({
    dateTime: '2023-01-20 14:30:00',
    date: '2023-01-20',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'BUY',
    quantity: 50,
    price: 178.00,
    proceeds: -8900.00,
    commission: -1.05,
    netCashFlow: -8901.05,
    currency: 'USD',
    fxRateToBase: 0.92,
    tradeId: 'NVDA-BUY-1',
    notes: 'Initial lot: 50 shares @ $178.00',
  });

  addTx({
    dateTime: '2023-05-12 15:10:00',
    date: '2023-05-12',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'BUY',
    quantity: 50,
    price: 285.00,
    proceeds: -14250.00,
    commission: -1.10,
    netCashFlow: -14251.10,
    currency: 'USD',
    fxRateToBase: 0.91,
    tradeId: 'NVDA-BUY-2',
    notes: 'Second accumulation lot: 50 shares @ $285.00 (Total 100 shares)',
  });

  // 2. First Covered Call: Sold 1x Aug 18 '23 $460 Call
  addTx({
    dateTime: '2023-07-14 16:05:00',
    date: '2023-07-14',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'NVDA  230818C00460000',
    underlying: 'NVDA',
    action: 'SELL',
    quantity: -1,
    price: 12.50,
    proceeds: 1250.00,
    commission: -1.30,
    netCashFlow: 1248.70,
    currency: 'USD',
    fxRateToBase: 0.89,
    tradeId: 'NVDA-OPT-1',
    notes: 'Covered Call Sell to Open (Credit +$1,250)',
    optionDetails: { type: 'CALL', strike: 460, expiry: '2023-08-18', isShort: true },
    bucket: 'LINKED',
  });

  // 3. CC expired OTM (stock was ~$432 on Aug 18)
  // 4. Second Covered Call: Sold 1x Oct 20 '23 $480 Call
  addTx({
    dateTime: '2023-09-15 14:40:00',
    date: '2023-09-15',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'NVDA  231020C00480000',
    underlying: 'NVDA',
    action: 'SELL',
    quantity: -1,
    price: 14.20,
    proceeds: 1420.00,
    commission: -1.30,
    netCashFlow: 1418.70,
    currency: 'USD',
    fxRateToBase: 0.94,
    tradeId: 'NVDA-OPT-2A',
    notes: 'Covered Call Sell to Open (Credit +$1,420)',
    optionDetails: { type: 'CALL', strike: 480, expiry: '2023-10-20', isShort: true },
    bucket: 'LINKED',
  });

  // 5. Early Exit / Roll: Buy to close Oct 20 Call for $3.20 (capturing 77% max profit)
  addTx({
    dateTime: '2023-10-12 11:25:00',
    date: '2023-10-12',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'NVDA  231020C00480000',
    underlying: 'NVDA',
    action: 'BUY',
    quantity: 1,
    price: 3.20,
    proceeds: -320.00,
    commission: -1.25,
    netCashFlow: -321.25,
    currency: 'USD',
    fxRateToBase: 0.95,
    tradeId: 'NVDA-OPT-2B',
    notes: 'Early Exit: Buy to Close at 77% profit (-$320 debit)',
    optionDetails: { type: 'CALL', strike: 480, expiry: '2023-10-20', isShort: false },
    bucket: 'LINKED',
  });

  // 6. Quarterly Dividends 2023-2024
  addTx({
    dateTime: '2023-12-28 08:00:00',
    date: '2023-12-28',
    section: 'Dividends',
    assetCategory: 'DIV',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'DIV',
    quantity: 1,
    price: 4.00,
    proceeds: 4.00,
    commission: 0,
    netCashFlow: 4.00,
    currency: 'USD',
    fxRateToBase: 0.90,
    tradeId: 'NVDA-DIV-1',
    notes: 'Gross Dividend (100 shs x $0.04)',
  });
  addTx({
    dateTime: '2023-12-28 08:00:01',
    date: '2023-12-28',
    section: 'Withholding Tax',
    assetCategory: 'TAX',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'TAX',
    quantity: 1,
    price: -0.60,
    proceeds: -0.60,
    commission: 0,
    netCashFlow: -0.60,
    currency: 'USD',
    fxRateToBase: 0.90,
    tradeId: 'NVDA-TAX-1',
    notes: '15% US Withholding Tax',
  });

  addTx({
    dateTime: '2024-03-27 08:00:00',
    date: '2024-03-27',
    section: 'Dividends',
    assetCategory: 'DIV',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'DIV',
    quantity: 1,
    price: 4.00,
    proceeds: 4.00,
    commission: 0,
    netCashFlow: 4.00,
    currency: 'USD',
    fxRateToBase: 0.92,
    tradeId: 'NVDA-DIV-2',
    notes: 'Gross Dividend $4.00',
  });
  addTx({
    dateTime: '2024-03-27 08:00:01',
    date: '2024-03-27',
    section: 'Withholding Tax',
    assetCategory: 'TAX',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'TAX',
    quantity: 1,
    price: -0.60,
    proceeds: -0.60,
    commission: 0,
    netCashFlow: -0.60,
    currency: 'USD',
    fxRateToBase: 0.92,
    tradeId: 'NVDA-TAX-2',
    notes: '15% US Withholding Tax',
  });

  // 7. Partial Stock Sell: 30 shares sold @ $885.00
  // Tests exact proportional cost pool reduction before split!
  addTx({
    dateTime: '2024-04-12 10:15:00',
    date: '2024-04-12',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'SELL',
    quantity: -30,
    price: 885.00,
    proceeds: 26550.00,
    commission: -1.25,
    netCashFlow: 26548.75,
    currency: 'USD',
    fxRateToBase: 0.93,
    tradeId: 'NVDA-SELL-1',
    notes: 'Partial profit trim: 30 shares @ $885 (70 shares remaining)',
  });

  // 8. 10-for-1 Forward Split on June 10, 2024 (70 shares -> 700 shares)
  addTx({
    dateTime: '2024-06-10 09:00:00',
    date: '2024-06-10',
    section: 'Corporate Actions',
    assetCategory: 'CORP_ACTION',
    symbol: 'NVDA',
    underlying: 'NVDA',
    action: 'SPLIT',
    quantity: 10,
    price: 0,
    proceeds: 0,
    commission: 0,
    netCashFlow: 0,
    currency: 'USD',
    fxRateToBase: 1,
    tradeId: 'NVDA-SPLIT-1',
    notes: 'NVDA Forward Split 10 for 1',
  });

  // 9. Post-Split Covered Calls: Sell 7x Sep 20 '24 $135 Call @ $4.50 (+$3,150)
  addTx({
    dateTime: '2024-08-09 14:15:00',
    date: '2024-08-09',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'NVDA  240920C00135000',
    underlying: 'NVDA',
    action: 'SELL',
    quantity: -7,
    price: 4.50,
    proceeds: 3150.00,
    commission: -8.75,
    netCashFlow: 3141.25,
    currency: 'USD',
    fxRateToBase: 0.91,
    tradeId: 'NVDA-OPT-3',
    notes: 'Post-split Covered Call 7x @ $4.50 (+$3,150 credit)',
    optionDetails: { type: 'CALL', strike: 135, expiry: '2024-09-20', isShort: true },
    bucket: 'LINKED',
  });

  // 10. Post-Split Covered Call: Sell 7x Jan 17 '25 $155 Call @ $6.10 (+$4,270)
  addTx({
    dateTime: '2024-11-20 15:30:00',
    date: '2024-11-20',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'NVDA  250117C00155000',
    underlying: 'NVDA',
    action: 'SELL',
    quantity: -7,
    price: 6.10,
    proceeds: 4270.00,
    commission: -8.75,
    netCashFlow: 4261.25,
    currency: 'USD',
    fxRateToBase: 0.95,
    tradeId: 'NVDA-OPT-4',
    notes: 'Active Covered Call campaign: 7x $155 Jan 25 (+4,270 credit)',
    optionDetails: { type: 'CALL', strike: 155, expiry: '2025-01-17', isShort: true },
    bucket: 'LINKED',
  });

  // 11. Standalone Speculative Trade (Bucket B): 2x NVDA $140 Call (Buy then Sell)
  addTx({
    dateTime: '2024-07-02 11:00:00',
    date: '2024-07-02',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'NVDA  240816C00140000',
    underlying: 'NVDA',
    action: 'BUY',
    quantity: 2,
    price: 7.50,
    proceeds: -1500.00,
    commission: -2.50,
    netCashFlow: -1502.50,
    currency: 'USD',
    fxRateToBase: 0.93,
    tradeId: 'NVDA-SPEC-1A',
    notes: 'Speculative Earnings Play: 2x Long Calls @ $7.50',
    optionDetails: { type: 'CALL', strike: 140, expiry: '2024-08-16', isShort: false },
    bucket: 'STANDALONE',
  });

  addTx({
    dateTime: '2024-07-18 15:45:00',
    date: '2024-07-18',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'NVDA  240816C00140000',
    underlying: 'NVDA',
    action: 'SELL',
    quantity: -2,
    price: 14.00,
    proceeds: 2800.00,
    commission: -2.50,
    netCashFlow: 2797.50,
    currency: 'USD',
    fxRateToBase: 0.92,
    tradeId: 'NVDA-SPEC-1B',
    notes: 'Speculative Close: Sold @ $14.00 (+86% ROI / +$1,300 P&L)',
    optionDetails: { type: 'CALL', strike: 140, expiry: '2024-08-16', isShort: true },
    bucket: 'STANDALONE',
  });

  // -------------------------------------------------------------
  // AAPL: Steady Dividend Growth + Systematic Covered Calls
  // -------------------------------------------------------------
  addTx({
    dateTime: '2022-10-14 14:00:00',
    date: '2022-10-14',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'AAPL',
    underlying: 'AAPL',
    action: 'BUY',
    quantity: 100,
    price: 138.50,
    proceeds: -13850.00,
    commission: -1.00,
    netCashFlow: -13851.00,
    currency: 'USD',
    fxRateToBase: 1.02,
    tradeId: 'AAPL-BUY-1',
    notes: 'Bought 100 shares @ $138.50',
  });

  addTx({
    dateTime: '2023-03-08 15:20:00',
    date: '2023-03-08',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'AAPL',
    underlying: 'AAPL',
    action: 'BUY',
    quantity: 100,
    price: 152.00,
    proceeds: -15200.00,
    commission: -1.00,
    netCashFlow: -15201.00,
    currency: 'USD',
    fxRateToBase: 0.95,
    tradeId: 'AAPL-BUY-2',
    notes: 'Added 100 shares @ $152.00 (Total 200 shares)',
  });

  // AAPL Covered calls
  addTx({
    dateTime: '2023-06-16 11:00:00',
    date: '2023-06-16',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'AAPL  230818C00190000',
    underlying: 'AAPL',
    action: 'SELL',
    quantity: -2,
    price: 4.80,
    proceeds: 960.00,
    commission: -2.50,
    netCashFlow: 957.50,
    currency: 'USD',
    fxRateToBase: 0.91,
    tradeId: 'AAPL-OPT-1',
    notes: 'Covered Calls 2x @ $4.80 (+$960 credit)',
    optionDetails: { type: 'CALL', strike: 190, expiry: '2023-08-18', isShort: true },
    bucket: 'LINKED',
  });

  addTx({
    dateTime: '2024-01-19 14:00:00',
    date: '2024-01-19',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'AAPL  240315C00200000',
    underlying: 'AAPL',
    action: 'SELL',
    quantity: -2,
    price: 5.40,
    proceeds: 1080.00,
    commission: -2.50,
    netCashFlow: 1077.50,
    currency: 'USD',
    fxRateToBase: 0.92,
    tradeId: 'AAPL-OPT-2',
    notes: 'Covered Calls 2x @ $5.40 (+$1,080 credit)',
    optionDetails: { type: 'CALL', strike: 200, expiry: '2024-03-15', isShort: true },
    bucket: 'LINKED',
  });

  // AAPL quarterly dividends
  const aaplDivDates = ['2023-02-16', '2023-05-18', '2023-08-17', '2023-11-16', '2024-02-15', '2024-05-16', '2024-08-15', '2024-11-14'];
  aaplDivDates.forEach((d, idx) => {
    const gross = idx === 0 ? 23.00 : 50.00; // 100 shares early, then 200 shares
    const tax = Number((gross * 0.15).toFixed(2));
    addTx({
      dateTime: `${d} 08:00:00`,
      date: d,
      section: 'Dividends',
      assetCategory: 'DIV',
      symbol: 'AAPL',
      underlying: 'AAPL',
      action: 'DIV',
      quantity: 1,
      price: gross,
      proceeds: gross,
      commission: 0,
      netCashFlow: gross,
      currency: 'USD',
      fxRateToBase: 0.92,
      tradeId: `AAPL-DIV-${idx}`,
      notes: `AAPL Quarterly Dividend ($${gross})`,
    });
    addTx({
      dateTime: `${d} 08:00:01`,
      date: d,
      section: 'Withholding Tax',
      assetCategory: 'TAX',
      symbol: 'AAPL',
      underlying: 'AAPL',
      action: 'TAX',
      quantity: 1,
      price: -tax,
      proceeds: -tax,
      commission: 0,
      netCashFlow: -tax,
      currency: 'USD',
      fxRateToBase: 0.92,
      tradeId: `AAPL-TAX-${idx}`,
      notes: '15% US Withholding Tax',
    });
  });

  // -------------------------------------------------------------
  // TSLA: Cash-Secured Put Assigned into Stock + Wheel CC Strategy
  // -------------------------------------------------------------
  // 1. Initial Cash-Secured Put sold
  addTx({
    dateTime: '2023-04-18 11:30:00',
    date: '2023-04-18',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'TSLA  230519P00180000',
    underlying: 'TSLA',
    action: 'SELL',
    quantity: -1,
    price: 8.50,
    proceeds: 850.00,
    commission: -1.30,
    netCashFlow: 848.70,
    currency: 'USD',
    fxRateToBase: 0.91,
    tradeId: 'TSLA-CSP-1',
    notes: 'Cash-Secured Put Sell to Open (+850 credit)',
    optionDetails: { type: 'PUT', strike: 180, expiry: '2023-05-19', isShort: true },
    bucket: 'LINKED',
  });

  // 2. Assigned 100 shares at $180.00
  addTx({
    dateTime: '2023-05-19 16:00:00',
    date: '2023-05-19',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'TSLA',
    underlying: 'TSLA',
    action: 'BUY',
    quantity: 100,
    price: 180.00,
    proceeds: -18000.00,
    commission: 0,
    netCashFlow: -18000.00,
    currency: 'USD',
    fxRateToBase: 0.92,
    tradeId: 'TSLA-ASSIGN-1',
    notes: 'Assignment of 100 shares from $180 Put',
  });

  // 3. Covered Call campaign on assigned shares
  addTx({
    dateTime: '2023-07-21 14:00:00',
    date: '2023-07-21',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'TSLA  230818C00280000',
    underlying: 'TSLA',
    action: 'SELL',
    quantity: -1,
    price: 9.80,
    proceeds: 980.00,
    commission: -1.30,
    netCashFlow: 978.70,
    currency: 'USD',
    fxRateToBase: 0.89,
    tradeId: 'TSLA-CC-1',
    notes: 'Covered Call Sell to Open (+$980 credit)',
    optionDetails: { type: 'CALL', strike: 280, expiry: '2023-08-18', isShort: true },
    bucket: 'LINKED',
  });

  addTx({
    dateTime: '2024-04-26 15:00:00',
    date: '2024-04-26',
    section: 'Trades',
    assetCategory: 'OPT',
    symbol: 'TSLA  240621C00220000',
    underlying: 'TSLA',
    action: 'SELL',
    quantity: -1,
    price: 8.20,
    proceeds: 820.00,
    commission: -1.30,
    netCashFlow: 818.70,
    currency: 'USD',
    fxRateToBase: 0.93,
    tradeId: 'TSLA-CC-2',
    notes: 'Covered Call Sell to Open (+$820 credit)',
    optionDetails: { type: 'CALL', strike: 220, expiry: '2024-06-21', isShort: true },
    bucket: 'LINKED',
  });

  // -------------------------------------------------------------
  // SPY: Core S&P 500 Index ETF Foundation
  // -------------------------------------------------------------
  addTx({
    dateTime: '2022-06-17 10:00:00',
    date: '2022-06-17',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'SPY',
    underlying: 'SPY',
    action: 'BUY',
    quantity: 50,
    price: 368.50,
    proceeds: -18425.00,
    commission: -1.00,
    netCashFlow: -18426.00,
    currency: 'USD',
    fxRateToBase: 0.95,
    tradeId: 'SPY-BUY-1',
    notes: 'Core ETF buy: 50 shares @ $368.50',
  });

  addTx({
    dateTime: '2023-01-06 11:30:00',
    date: '2023-01-06',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'SPY',
    underlying: 'SPY',
    action: 'BUY',
    quantity: 30,
    price: 388.00,
    proceeds: -11640.00,
    commission: -1.00,
    netCashFlow: -11641.00,
    currency: 'USD',
    fxRateToBase: 0.94,
    tradeId: 'SPY-BUY-2',
    notes: 'Core ETF buy: 30 shares @ $388.00 (Total 80 shares)',
  });

  // SPY dividends
  const spyDivs = [
    { date: '2023-03-31', gross: 120.40 },
    { date: '2023-06-30', gross: 131.20 },
    { date: '2023-09-29', gross: 127.10 },
    { date: '2023-12-29', gross: 152.50 },
    { date: '2024-03-29', gross: 128.80 },
    { date: '2024-06-28', gross: 142.60 },
    { date: '2024-09-30', gross: 139.20 },
  ];
  spyDivs.forEach((d, idx) => {
    const tax = Number((d.gross * 0.15).toFixed(2));
    addTx({
      dateTime: `${d.date} 08:00:00`,
      date: d.date,
      section: 'Dividends',
      assetCategory: 'DIV',
      symbol: 'SPY',
      underlying: 'SPY',
      action: 'DIV',
      quantity: 1,
      price: d.gross,
      proceeds: d.gross,
      commission: 0,
      netCashFlow: d.gross,
      currency: 'USD',
      fxRateToBase: 0.92,
      tradeId: `SPY-DIV-${idx}`,
      notes: `SPY Quarterly Dividend ($${d.gross})`,
    });
    addTx({
      dateTime: `${d.date} 08:00:01`,
      date: d.date,
      section: 'Withholding Tax',
      assetCategory: 'TAX',
      symbol: 'SPY',
      underlying: 'SPY',
      action: 'TAX',
      quantity: 1,
      price: -tax,
      proceeds: -tax,
      commission: 0,
      netCashFlow: -tax,
      currency: 'USD',
      fxRateToBase: 0.92,
      tradeId: `SPY-TAX-${idx}`,
      notes: '15% US Withholding Tax',
    });
  });

  // -------------------------------------------------------------
  // ASML: European Semiconductor Leader (EUR Native Currency)
  // -------------------------------------------------------------
  addTx({
    dateTime: '2023-02-10 10:15:00',
    date: '2023-02-10',
    section: 'Trades',
    assetCategory: 'STK',
    symbol: 'ASML',
    underlying: 'ASML',
    action: 'BUY',
    quantity: 40,
    price: 615.00,
    proceeds: -24600.00,
    commission: -2.50,
    netCashFlow: -24602.50,
    currency: 'EUR',
    fxRateToBase: 1.0,
    tradeId: 'ASML-BUY-1',
    notes: 'Bought 40 shares @ €615.00 in EUR',
  });

  addTx({
    dateTime: '2023-11-08 09:30:00',
    date: '2023-11-08',
    section: 'Dividends',
    assetCategory: 'DIV',
    symbol: 'ASML',
    underlying: 'ASML',
    action: 'DIV',
    quantity: 1,
    price: 58.00,
    proceeds: 58.00,
    commission: 0,
    netCashFlow: 58.00,
    currency: 'EUR',
    fxRateToBase: 1.0,
    tradeId: 'ASML-DIV-1',
    notes: 'ASML Interim Dividend €58.00',
  });
  addTx({
    dateTime: '2023-11-08 09:30:01',
    date: '2023-11-08',
    section: 'Withholding Tax',
    assetCategory: 'TAX',
    symbol: 'ASML',
    underlying: 'ASML',
    action: 'TAX',
    quantity: 1,
    price: -8.70,
    proceeds: -8.70,
    commission: 0,
    netCashFlow: -8.70,
    currency: 'EUR',
    fxRateToBase: 1.0,
    tradeId: 'ASML-TAX-1',
    notes: 'Dutch 15% Dividend Tax',
  });

  // Sort chronological
  demoList.sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());

  return demoList;
}

/**
 * Export portfolio state to JSON file download
 */
export function exportPortfolioToJson(
  transactions: Transaction[],
  bucketOverrides: Record<string, BucketType>,
  baseCurrency: 'EUR' | 'USD',
  cashSummary?: {
    endingCashBase?: number;
    depositsBase?: number;
    withdrawalsBase?: number;
    netDepositsBase?: number;
  }
): string {
  const exportPayload = {
    version: '1.0.0',
    app: 'Options Analyzer Terminal - Portfolio Performance Tracker',
    exportDate: new Date().toISOString(),
    baseCurrency,
    bucketOverrides,
    cashSummary,
    transactionCount: transactions.length,
    transactions,
  };
  return JSON.stringify(exportPayload, null, 2);
}

/**
 * Normalize a single transaction object (supports minimal AI-generated JSON or full Transaction)
 */
export function normalizeImportedTransaction(raw: any): Transaction | null {
  if (!raw || typeof raw !== 'object') return null;

  const assetCatRaw = String(raw.assetCategory || 'STK').toUpperCase().trim();
  const validCats: AssetCategory[] = ['STK', 'OPT', 'CASH', 'DIV', 'TAX', 'CORP_ACTION'];
  const assetCategory: AssetCategory = validCats.includes(assetCatRaw as AssetCategory)
    ? (assetCatRaw as AssetCategory)
    : 'STK';

  const symbol = String(raw.symbol || raw.underlying || '').trim();
  if (!symbol) return null;

  const parsedSym = parseOptionSymbol(symbol);
  const underlying = String(raw.underlying || parsedSym.underlying || symbol).toUpperCase().trim();

  // Normalize Date/Time
  const rawDateTime = String(raw.dateTime || raw.date || new Date().toISOString().slice(0, 10)).trim();
  const normalizedDateTime = normalizeIBKRDate(rawDateTime);
  const dateOnly = normalizedDateTime.split(',')[0].split(' ')[0].slice(0, 10);

  // Normalize Action
  let actionRaw = String(raw.action || '').toUpperCase().trim();
  if (!actionRaw) {
    if (assetCategory === 'DIV') actionRaw = 'DIV';
    else if (assetCategory === 'TAX') actionRaw = 'TAX';
    else if (assetCategory === 'CORP_ACTION') actionRaw = 'SPLIT';
    else actionRaw = Number(raw.quantity || 0) < 0 ? 'SELL' : 'BUY';
  }
  const action = actionRaw as TradeAction;

  // Normalize Quantity sign
  let quantity = Number(raw.quantity ?? 1);
  if (isNaN(quantity)) quantity = 1;
  if (assetCategory === 'STK' || assetCategory === 'OPT') {
    if (action === 'SELL' && quantity > 0) quantity = -quantity;
    if (action === 'BUY' && quantity < 0) quantity = Math.abs(quantity);
  } else if (assetCategory === 'CORP_ACTION') {
    quantity = Number(raw.corporateAction?.ratio || raw.quantity || 1);
  }

  const price = Math.abs(Number(raw.price ?? raw.amount ?? 0)) || 0;
  const commission = Number(raw.commission ?? 0) || 0;
  const currency = String(raw.currency || 'USD').toUpperCase().trim();
  const fxRateToBase = Number(raw.fxRateToBase) > 0 ? Number(raw.fxRateToBase) : 1;
  const multiplier = Number(raw.multiplier) > 0 ? Number(raw.multiplier) : assetCategory === 'OPT' ? 100 : 1;

  // Option details
  let optionDetails: OptionDetails | undefined = undefined;
  if (assetCategory === 'OPT') {
    const rawOpt = raw.optionDetails;
    if (rawOpt && rawOpt.strike && rawOpt.expiry) {
      optionDetails = {
        type: String(rawOpt.type || 'CALL').toUpperCase().startsWith('P') ? 'PUT' : 'CALL',
        strike: Number(rawOpt.strike),
        expiry: normalizeIBKRDate(String(rawOpt.expiry)).slice(0, 10),
        isShort: action === 'SELL',
      };
    } else if (parsedSym.details) {
      optionDetails = { ...parsedSym.details, isShort: action === 'SELL' };
    }
  }

  // Compute Proceeds and Net Cash Flow if omitted
  let proceeds = Number(raw.proceeds);
  if (isNaN(proceeds) || raw.proceeds === undefined) {
    if (assetCategory === 'DIV') {
      proceeds = Math.abs(price);
    } else if (assetCategory === 'TAX') {
      proceeds = -Math.abs(price);
    } else if (assetCategory === 'CORP_ACTION') {
      proceeds = 0;
    } else {
      proceeds = action === 'BUY' ? -(Math.abs(quantity) * price * multiplier) : Math.abs(quantity) * price * multiplier;
    }
  }

  let netCashFlow = Number(raw.netCashFlow);
  if (isNaN(netCashFlow) || raw.netCashFlow === undefined) {
    netCashFlow = proceeds + commission;
    if (assetCategory === 'TAX') netCashFlow = -Math.abs(price);
    if (assetCategory === 'DIV') netCashFlow = Math.abs(price);
  }

  // Bucket Classification
  const defaultBucket: BucketType =
    assetCategory !== 'OPT' ? 'LINKED' : action === 'SELL' ? 'LINKED' : 'STANDALONE';
  const bucket: BucketType =
    raw.bucket === 'LINKED' || raw.bucket === 'STANDALONE' ? raw.bucket : defaultBucket;

  const tradeId = String(raw.tradeId || '').trim();
  const id = String(raw.id || generateTransactionHash(normalizedDateTime, symbol, quantity, price, tradeId));

  const corporateAction =
    assetCategory === 'CORP_ACTION'
      ? { type: 'SPLIT' as const, ratio: Number(raw.corporateAction?.ratio || quantity || 1) }
      : undefined;

  return {
    id,
    dateTime: normalizedDateTime,
    date: dateOnly,
    section:
      raw.section ||
      (assetCategory === 'DIV'
        ? 'Dividends'
        : assetCategory === 'TAX'
        ? 'Withholding Tax'
        : assetCategory === 'CORP_ACTION'
        ? 'Corporate Actions'
        : 'Trades'),
    assetCategory,
    symbol,
    underlying: resolveUnderlyingTicker(symbol, underlying, assetCategory),
    action,
    quantity,
    price: assetCategory === 'TAX' ? -Math.abs(price) : price,
    multiplier,
    proceeds,
    commission,
    netCashFlow,
    currency,
    fxRateToBase,
    realizedPnl: raw.realizedPnl !== undefined ? Number(raw.realizedPnl) : undefined,
    openCloseIndicator: raw.openCloseIndicator,
    listingExchange: raw.listingExchange,
    tradeId: tradeId || id,
    notes: raw.notes ? String(raw.notes) : undefined,
    optionDetails,
    defaultBucket,
    bucket,
    corporateAction,
  };
}

/**
 * Parse an IBKR Flex Query XML statement (<FlexQueryResponse>) offline using DOMParser
 */
export function parseIBKRFlexXML(
  xmlContent: string,
  existingTransactionIds: Set<string> = new Set()
): {
  transactions: Transaction[];
  duplicatesSkipped: number;
  sectionsFound: string[];
  baseCurrency: 'EUR' | 'USD';
  fxRates: Record<string, number>;
  positionMarks: Record<string, PositionMark>;
  endingCashBase?: number;
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  errors: string[];
} {
  const transactions: Transaction[] = [];
  let duplicatesSkipped = 0;
  const sectionsFound = new Set<string>();
  let baseCurrency: 'EUR' | 'USD' = 'EUR';
  const fxRates: Record<string, number> = {};
  const positionMarks: Record<string, PositionMark> = {};
  let endingCashBase: number | undefined;
  let depositsBase: number | undefined;
  let withdrawalsBase: number | undefined;
  let netDepositsBase: number | undefined;
  const errors: string[] = [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlContent, 'text/xml');
    const parseErr = doc.querySelector('parsererror');
    if (parseErr) {
      return {
        transactions: [],
        duplicatesSkipped: 0,
        sectionsFound: [],
        baseCurrency,
        fxRates,
        positionMarks,
        errors: ['Invalid XML format: ' + parseErr.textContent?.slice(0, 120)],
      };
    }

    // Detect base currency from AccountInformation
    const acctInfo = doc.querySelector('AccountInformation');
    const acctCurr = acctInfo?.getAttribute('currency')?.toUpperCase();
    if (acctCurr === 'USD' || acctCurr === 'EUR') {
      baseCurrency = acctCurr;
    }

    // 0A. Parse <ConversionRates> for daily & latest FX rates
    const dailyFxMap = new Map<string, number>();
    const latestFxDateMap = new Map<string, string>();
    const convNodes = Array.from(doc.querySelectorAll('ConversionRates > ConversionRate, ConversionRate'));
    for (const node of convNodes) {
      const reportDate = normalizeIBKRDate(node.getAttribute('reportDate') || '').slice(0, 10);
      const from = (node.getAttribute('fromCurrency') || '').toUpperCase();
      const to = (node.getAttribute('toCurrency') || '').toUpperCase();
      const rate = parseFloat(node.getAttribute('rate') || '0');
      if (!from || !to || !(rate > 0)) continue;

      if (reportDate) {
        dailyFxMap.set(`${reportDate}|${from}|${to}`, rate);
      }
      const pairKey = `${from}->${to}`;
      const prevDate = latestFxDateMap.get(pairKey) || '';
      if (!prevDate || reportDate >= prevDate) {
        latestFxDateMap.set(pairKey, reportDate);
        fxRates[pairKey] = rate;
        fxRates[`${to}->${from}`] = 1 / rate;
      }
    }

    const resolveFx = (currency: string, isoDate: string, attrVal: string | null): number => {
      if (currency === baseCurrency) return 1;
      const explicit = parseFloat(attrVal || '');
      if (!isNaN(explicit) && explicit > 0) return explicit;
      const daily = dailyFxMap.get(`${isoDate}|${currency}|${baseCurrency}`);
      if (daily && daily > 0) return daily;
      const latest = fxRates[`${currency}->${baseCurrency}`];
      if (latest && latest > 0) return latest;
      return 1;
    };

    // 0B. Parse <CashReport> ending cash & deposits/withdrawals summary (BASE_SUMMARY row is first CashReportCurrency)
    const cashReportFirst = doc.querySelector('CashReport > CashReportCurrency');
    if (cashReportFirst) {
      const ending = parseFloat(cashReportFirst.getAttribute('endingCash') || '');
      if (!isNaN(ending)) endingCashBase = ending;
      const deps = parseFloat(cashReportFirst.getAttribute('deposits') || '');
      if (!isNaN(deps)) depositsBase = deps;
      const wds = parseFloat(cashReportFirst.getAttribute('withdrawals') || '');
      if (!isNaN(wds)) withdrawalsBase = Math.abs(wds);
      const netDep = parseFloat(cashReportFirst.getAttribute('depositWithdrawals') || '');
      if (!isNaN(netDep)) netDepositsBase = netDep;
      else if (depositsBase !== undefined) netDepositsBase = depositsBase - (withdrawalsBase || 0);
    }

    if (netDepositsBase === undefined) {
      const changeInNav = doc.querySelector('ChangeInNAV');
      const navDep = parseFloat(changeInNav?.getAttribute('depositsWithdrawals') || '');
      if (!isNaN(navDep)) netDepositsBase = navDep;
    }

    // 0C. Parse <OpenPositions> marks for stocks and open options
    const openPosNodes = Array.from(doc.querySelectorAll('OpenPositions > OpenPosition, OpenPosition'));
    if (openPosNodes.length > 0) {
      sectionsFound.add('Open Positions (XML)');
    }
    for (const node of openPosNodes) {
      const symbol = (node.getAttribute('symbol') || '').trim();
      if (!symbol) continue;
      const isOpt = Boolean(node.getAttribute('strike') || node.getAttribute('putCall') || node.getAttribute('expiry'));
      const assetCat: 'STK' | 'OPT' = isOpt ? 'OPT' : 'STK';
      const underlying = resolveUnderlyingTicker(symbol, node.getAttribute('underlyingSymbol') || '', assetCat);
      const currency = (node.getAttribute('currency') || 'USD').toUpperCase();
      const position = parseFloat(node.getAttribute('position') || '0');
      const markPrice = parseFloat(node.getAttribute('markPrice') || '0');
      const positionValue = parseFloat(node.getAttribute('positionValue') || '0');
      const costBasisMoney = parseFloat(node.getAttribute('costBasisMoney') || '0');
      const fifoPnlUnrealized = parseFloat(node.getAttribute('fifoPnlUnrealized') || '0');

      const mark: PositionMark = {
        symbol,
        underlying,
        assetCategory: assetCat,
        currency,
        position,
        markPrice,
        positionValue,
        costBasisMoney,
        fifoPnlUnrealized,
        listingExchange: node.getAttribute('listingExchange') || undefined,
        underlyingListingExchange: node.getAttribute('underlyingListingExchange') || undefined,
      };
      positionMarks[symbol] = mark;
      if (assetCat === 'STK' && underlying !== symbol) {
        positionMarks[underlying] = mark;
      }
    }

    // 1. Parse <Trade> elements
    const tradeNodes = Array.from(doc.querySelectorAll('Trades > Trade, Trade'));
    const seenNodes = new Set<Element>();
    for (const node of tradeNodes) {
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);

      const assetCat = (node.getAttribute('assetCategory') || 'STK').toUpperCase();
      if (assetCat !== 'STK' && assetCat !== 'OPT') continue;
      sectionsFound.add('Trades (XML)');

      const symbol = (node.getAttribute('symbol') || '').trim();
      if (!symbol) continue;

      const underlying = resolveUnderlyingTicker(symbol, node.getAttribute('underlyingSymbol') || '', assetCat);
      const dateTime = normalizeIBKRDate(node.getAttribute('dateTime') || node.getAttribute('tradeDate') || '');
      const dateOnly = dateTime.slice(0, 10);
      const buySell = (node.getAttribute('buySell') || '').toUpperCase();
      const rawQty = parseFloat(node.getAttribute('quantity') || '0');
      const action: TradeAction = buySell === 'SELL' || rawQty < 0 ? 'SELL' : 'BUY';
      const quantity = action === 'SELL' ? -Math.abs(rawQty) : Math.abs(rawQty);
      const price = Math.abs(parseFloat(node.getAttribute('tradePrice') || node.getAttribute('price') || '0'));
      const multiplierAttr = parseFloat(node.getAttribute('multiplier') || '0');
      const multiplier = multiplierAttr > 0 ? multiplierAttr : assetCat === 'OPT' ? 100 : 1;
      const proceeds = parseFloat(node.getAttribute('proceeds') || '0');
      const commission = parseFloat(node.getAttribute('ibCommission') || node.getAttribute('commission') || '0');
      const netCashAttr = node.getAttribute('netCash');
      const netCashFlow = netCashAttr !== null && netCashAttr !== '' ? parseFloat(netCashAttr) : proceeds + commission;
      const realizedPnlAttr = node.getAttribute('fifoPnlRealized');
      const realizedPnl = realizedPnlAttr !== null && realizedPnlAttr !== '' ? parseFloat(realizedPnlAttr) : undefined;
      const currency = (node.getAttribute('currency') || 'USD').toUpperCase();
      const fxRate = resolveFx(currency, dateOnly, node.getAttribute('fxRateToBase'));
      const tradeId = node.getAttribute('tradeID') || node.getAttribute('ibOrderID') || '';
      const ocRaw = (node.getAttribute('openCloseIndicator') || '').toUpperCase();
      const openCloseIndicator: 'O' | 'C' | undefined = ocRaw === 'O' || ocRaw === 'C' ? ocRaw : undefined;
      const listingExchange = node.getAttribute('listingExchange') || node.getAttribute('underlyingListingExchange') || undefined;

      let optionDetails: OptionDetails | undefined;
      if (assetCat === 'OPT') {
        const strike = parseFloat(node.getAttribute('strike') || '0');
        const expiryRaw = node.getAttribute('expiry') || '';
        const expiry = normalizeIBKRDate(expiryRaw).slice(0, 10);
        const putCall = (node.getAttribute('putCall') || '').toUpperCase();
        if (strike > 0 && expiry) {
          optionDetails = {
            type: putCall.startsWith('P') ? 'PUT' : 'CALL',
            strike,
            expiry,
            isShort: action === 'SELL',
          };
        } else {
          optionDetails = parseOptionSymbol(symbol).details;
          if (optionDetails) optionDetails.isShort = action === 'SELL';
        }
      }

      const id = generateTransactionHash(dateTime, symbol, quantity, price, tradeId);
      if (existingTransactionIds.has(id)) {
        duplicatesSkipped++;
        continue;
      }

      const defaultBucket: BucketType = assetCat !== 'OPT' ? 'LINKED' : action === 'SELL' ? 'LINKED' : 'STANDALONE';

      transactions.push({
        id,
        dateTime,
        date: dateOnly,
        section: 'Trades',
        assetCategory: assetCat as AssetCategory,
        symbol,
        underlying,
        action,
        quantity,
        price,
        multiplier,
        proceeds,
        commission,
        netCashFlow,
        currency,
        fxRateToBase: fxRate,
        realizedPnl: realizedPnl !== undefined && !isNaN(realizedPnl) ? realizedPnl : undefined,
        openCloseIndicator,
        listingExchange,
        tradeId: tradeId || id,
        notes: node.getAttribute('description') || undefined,
        optionDetails,
        defaultBucket,
        bucket: defaultBucket,
      });
    }

    // 2. Parse <CashTransaction> elements (Dividends & Withholding Tax)
    let cashDividendCount = 0;
    const cashNodes = Array.from(doc.querySelectorAll('CashTransactions > CashTransaction, CashTransaction'));
    const seenCash = new Set<Element>();
    for (const node of cashNodes) {
      if (seenCash.has(node)) continue;
      seenCash.add(node);

      const typeAttr = (node.getAttribute('type') || '').toLowerCase();
      const desc = node.getAttribute('description') || '';
      const amount = parseFloat(node.getAttribute('amount') || '0');
      const symbolRaw = node.getAttribute('symbol') || node.getAttribute('underlyingSymbol') || '';
      const dateTime = normalizeIBKRDate(
        node.getAttribute('dateTime') || node.getAttribute('reportDate') || node.getAttribute('settleDate') || ''
      );
      const dateOnly = dateTime.slice(0, 10);
      const currency = (node.getAttribute('currency') || 'USD').toUpperCase();
      const fxRate = resolveFx(currency, dateOnly, node.getAttribute('fxRateToBase'));
      const txId = node.getAttribute('transactionID') || '';

      const isTax = typeAttr.includes('withholding tax') || typeAttr.includes('tax');
      const isDiv = typeAttr.includes('dividend') || typeAttr.includes('payment in lieu');
      if ((!isTax && !isDiv) || amount === 0) continue;

      cashDividendCount++;
      sectionsFound.add(isTax ? 'Withholding Tax (XML)' : 'Dividends (XML)');
      const symMatch = desc.match(/^([A-Za-z]+)(?:\([A-Za-z0-9]+\))?/);
      const underlying = resolveUnderlyingTicker(symbolRaw || (symMatch ? symMatch[1] : 'UNKNOWN'), symbolRaw, 'STK');

      const assetCategory: AssetCategory = isTax ? 'TAX' : 'DIV';
      const action: TradeAction = isTax ? 'TAX' : 'DIV';
      const signedAmt = isTax ? -Math.abs(amount) : Math.abs(amount);

      const id = generateTransactionHash(dateTime, `${action}_${underlying}`, 1, Math.abs(amount), txId || desc.slice(0, 20));
      if (existingTransactionIds.has(id)) {
        duplicatesSkipped++;
        continue;
      }

      transactions.push({
        id,
        dateTime,
        date: dateOnly,
        section: isTax ? 'Withholding Tax' : 'Dividends',
        assetCategory,
        symbol: underlying,
        underlying,
        action,
        quantity: 1,
        price: signedAmt,
        multiplier: 1,
        proceeds: signedAmt,
        commission: 0,
        netCashFlow: signedAmt,
        currency,
        fxRateToBase: fxRate,
        tradeId: txId || id,
        notes: desc,
        defaultBucket: 'LINKED',
        bucket: 'LINKED',
      });
    }

    // 2B. Fallback: If CashTransactions wasn't included in Flex Query, extract settled dividends from <ChangeInDividendAccrual>
    if (cashDividendCount === 0) {
      const divAccNodes = Array.from(doc.querySelectorAll('ChangeInDividendAccruals > ChangeInDividendAccrual, ChangeInDividendAccrual'));
      const reversalByAction = new Map<string, Element>();
      for (const node of divAccNodes) {
        const gross = parseFloat(node.getAttribute('grossAmount') || '0');
        if (gross >= 0) continue; // Only reversal (settlement payout) entries
        const actionId = node.getAttribute('actionID') || `${node.getAttribute('underlyingSymbol')}_${node.getAttribute('exDate')}`;
        const curDate = normalizeIBKRDate(node.getAttribute('date') || '').slice(0, 10);
        const existing = reversalByAction.get(actionId);
        const prevDate = existing ? normalizeIBKRDate(existing.getAttribute('date') || '').slice(0, 10) : '';
        if (!existing || curDate >= prevDate) {
          reversalByAction.set(actionId, node);
        }
      }

      for (const [actionId, node] of reversalByAction.entries()) {
        const rawUnd = node.getAttribute('underlyingSymbol') || node.getAttribute('symbol') || '';
        const underlying = resolveUnderlyingTicker(rawUnd, rawUnd, 'STK');
        const dateOnly = normalizeIBKRDate(node.getAttribute('date') || '').slice(0, 10);
        const dateTime = `${dateOnly} 08:00:00`;
        const gross = Math.abs(parseFloat(node.getAttribute('grossAmount') || '0'));
        const tax = Math.abs(parseFloat(node.getAttribute('tax') || '0'));
        const fee = Math.abs(parseFloat(node.getAttribute('fee') || '0'));
        const listingEx = (node.getAttribute('listingExchange') || '').toUpperCase();
        const currency = (node.getAttribute('currency') || (['BVME', 'SBF', 'AEB', 'IBIS'].includes(listingEx) ? 'EUR' : 'USD')).toUpperCase();
        const fxRate = resolveFx(currency, dateOnly, node.getAttribute('fxRateToBase'));

        if (gross > 0) {
          sectionsFound.add('Dividends (XML Accrual)');
          const divId = generateTransactionHash(dateTime, `DIV_${underlying}`, 1, gross, `acc-${actionId}`);
          if (!existingTransactionIds.has(divId)) {
            transactions.push({
              id: divId,
              dateTime,
              date: dateOnly,
              section: 'Dividends',
              assetCategory: 'DIV',
              symbol: underlying,
              underlying,
              action: 'DIV',
              quantity: 1,
              price: gross,
              multiplier: 1,
              proceeds: gross,
              commission: 0,
              netCashFlow: gross,
              currency,
              fxRateToBase: fxRate,
              tradeId: `div-${actionId}`,
              notes: `${underlying} Cash Dividend (${node.getAttribute('quantity') || ''} shs)`,
              defaultBucket: 'LINKED',
              bucket: 'LINKED',
            });
          } else {
            duplicatesSkipped++;
          }
        }

        const totalTaxAndFee = tax + fee;
        if (totalTaxAndFee > 0) {
          const taxTime = `${dateOnly} 08:00:01`;
          const taxId = generateTransactionHash(taxTime, `TAX_${underlying}`, 1, totalTaxAndFee, `acc-tax-${actionId}`);
          if (!existingTransactionIds.has(taxId)) {
            transactions.push({
              id: taxId,
              dateTime: taxTime,
              date: dateOnly,
              section: 'Withholding Tax',
              assetCategory: 'TAX',
              symbol: underlying,
              underlying,
              action: 'TAX',
              quantity: 1,
              price: -totalTaxAndFee,
              multiplier: 1,
              proceeds: -totalTaxAndFee,
              commission: 0,
              netCashFlow: -totalTaxAndFee,
              currency,
              fxRateToBase: fxRate,
              tradeId: `tax-${actionId}`,
              notes: `${underlying} Dividend Withholding Tax & ADR Fee`,
              defaultBucket: 'LINKED',
              bucket: 'LINKED',
            });
          } else {
            duplicatesSkipped++;
          }
        }
      }
    }

    // 3. Parse <CorporateAction> elements (Splits)
    const corpNodes = Array.from(doc.querySelectorAll('CorporateActions > CorporateAction, CorporateAction'));
    const seenCorp = new Set<Element>();
    for (const node of corpNodes) {
      if (seenCorp.has(node)) continue;
      seenCorp.add(node);

      const desc = node.getAttribute('description') || '';
      const symbolRaw = node.getAttribute('symbol') || node.getAttribute('underlyingSymbol') || '';
      const dateTime = normalizeIBKRDate(node.getAttribute('dateTime') || node.getAttribute('reportDate') || '');
      const splitMatch = desc.match(/(\d+)\s+FOR\s+(\d+)/i);
      if (!splitMatch) continue;

      sectionsFound.add('Corporate Actions (XML)');
      const ratio = parseFloat(splitMatch[1]) / parseFloat(splitMatch[2]);
      const underlying = resolveUnderlyingTicker(symbolRaw || desc.split(/\s+/)[0], symbolRaw, 'STK');
      const id = generateTransactionHash(dateTime, `SPLIT_${underlying}`, ratio, 0, 'SPLIT');

      if (existingTransactionIds.has(id)) {
        duplicatesSkipped++;
        continue;
      }

      transactions.push({
        id,
        dateTime,
        date: dateTime.slice(0, 10),
        section: 'Corporate Actions',
        assetCategory: 'CORP_ACTION',
        symbol: underlying,
        underlying,
        action: 'SPLIT',
        quantity: ratio,
        price: 0,
        multiplier: 1,
        proceeds: 0,
        commission: 0,
        netCashFlow: 0,
        currency: 'USD',
        fxRateToBase: 1,
        tradeId: `split-${id}`,
        notes: desc,
        defaultBucket: 'LINKED',
        bucket: 'LINKED',
        corporateAction: { type: 'SPLIT', ratio },
      });
    }

    const classified = assignSmartOptionBuckets(transactions);
    transactions.length = 0;
    transactions.push(...classified);
  } catch (err: any) {
    errors.push(`XML parse error: ${err.message}`);
  }

  return {
    transactions,
    duplicatesSkipped,
    sectionsFound: Array.from(sectionsFound),
    baseCurrency,
    fxRates,
    positionMarks,
    endingCashBase,
    depositsBase,
    withdrawalsBase,
    netDepositsBase,
    errors,
  };
}

/**
 * Parse an exported JSON portfolio backup file OR simplified AI-generated JSON
 */
export function importPortfolioFromJson(
  jsonText: string,
  existingTransactionIds: Set<string> = new Set()
): {
  transactions: Transaction[];
  bucketOverrides: Record<string, BucketType>;
  baseCurrency: 'EUR' | 'USD';
  endingCashBase?: number;
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  duplicatesSkipped: number;
  error?: string;
} {
  try {
    // Strip markdown code fences if the user pasted ```json ... ```
    const cleaned = jsonText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsed = JSON.parse(cleaned);
    const rawList = Array.isArray(parsed) ? parsed : parsed.transactions;

    if (!Array.isArray(rawList)) {
      throw new Error('Invalid JSON: expected an array of transactions or an object with a "transactions" array.');
    }

    let duplicatesSkipped = 0;
    const normalized: Transaction[] = [];

    for (const item of rawList) {
      const tx = normalizeImportedTransaction(item);
      if (!tx) continue;
      if (existingTransactionIds.has(tx.id)) {
        duplicatesSkipped++;
        continue;
      }
      existingTransactionIds.add(tx.id);
      normalized.push(tx);
    }

    normalized.sort((a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime());

    const cashSummary = !Array.isArray(parsed) ? parsed.cashSummary : undefined;

    return {
      transactions: normalized,
      bucketOverrides: (!Array.isArray(parsed) && parsed.bucketOverrides) || {},
      baseCurrency: !Array.isArray(parsed) && parsed.baseCurrency === 'USD' ? 'USD' : 'EUR',
      endingCashBase: cashSummary?.endingCashBase,
      depositsBase: cashSummary?.depositsBase,
      withdrawalsBase: cashSummary?.withdrawalsBase,
      netDepositsBase: cashSummary?.netDepositsBase,
      duplicatesSkipped,
    };
  } catch (err: any) {
    return {
      transactions: [],
      bucketOverrides: {},
      baseCurrency: 'EUR',
      duplicatesSkipped: 0,
      error: err.message || 'Failed to parse JSON file',
    };
  }
}

/**
 * Universal auto-detecting importer: supports IBKR CSV, IBKR Flex XML, and JSON (full or AI-generated)
 */
export function parseUniversalIBKRInput(
  rawText: string,
  existingTransactionIds: Set<string> = new Set()
): {
  format: 'CSV' | 'XML' | 'JSON';
  transactions: Transaction[];
  bucketOverrides?: Record<string, BucketType>;
  fxRates?: Record<string, number>;
  positionMarks?: Record<string, PositionMark>;
  endingCashBase?: number;
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  duplicatesSkipped: number;
  sectionsFound: string[];
  baseCurrency: 'EUR' | 'USD';
  errors: string[];
} {
  const trimmed = rawText.trim();
  const withoutFences = trimmed.replace(/^```(?:json|xml|csv)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // 1. JSON check
  if (withoutFences.startsWith('{') || withoutFences.startsWith('[')) {
    const res = importPortfolioFromJson(withoutFences, new Set(existingTransactionIds));
    return {
      format: 'JSON',
      transactions: res.transactions,
      bucketOverrides: res.bucketOverrides,
      endingCashBase: res.endingCashBase,
      depositsBase: res.depositsBase,
      withdrawalsBase: res.withdrawalsBase,
      netDepositsBase: res.netDepositsBase,
      duplicatesSkipped: res.duplicatesSkipped,
      sectionsFound: ['JSON Import'],
      baseCurrency: res.baseCurrency,
      errors: res.error ? [res.error] : [],
    };
  }

  // 2. XML check
  if (withoutFences.startsWith('<') || withoutFences.includes('<FlexQueryResponse') || withoutFences.includes('<FlexStatements')) {
    const res = parseIBKRFlexXML(withoutFences, existingTransactionIds);
    return {
      format: 'XML',
      ...res,
    };
  }

  // 3. Default: IBKR CSV
  const res = parseIBKRActivityCSV(rawText, existingTransactionIds);
  return {
    format: 'CSV',
    ...res,
  };
}

export const AI_EXTRACTION_PROMPT = `You are a financial data parser. Extract all Stock trades, Option trades, Dividends, Withholding Taxes, and Stock Splits from the attached Interactive Brokers (IBKR) statement (PDF, XML, or plain text) into a single valid JSON object matching this exact schema.

Return ONLY raw JSON (no markdown commentary) with this structure:
{
  "baseCurrency": "EUR",
  "transactions": [
    {
      "dateTime": "2024-05-10 14:30:00",
      "assetCategory": "STK",
      "symbol": "NVDA",
      "underlying": "NVDA",
      "action": "BUY",
      "quantity": 100,
      "price": 890.50,
      "commission": -1.05,
      "currency": "USD",
      "fxRateToBase": 0.92,
      "tradeId": "optional-broker-id",
      "notes": "Bought 100 shares"
    }
  ]
}

Strict Field Rules:
1. "assetCategory" MUST be one of: "STK" (stocks/ETFs), "OPT" (options), "DIV" (gross dividend), "TAX" (dividend withholding tax), "CORP_ACTION" (stock splits).
2. "action" MUST match assetCategory:
   - STK/OPT: "BUY" (positive quantity) or "SELL" (negative quantity, e.g. -1 for 1 short contract).
   - DIV: "DIV" (quantity: 1, price: gross dividend amount as positive number).
   - TAX: "TAX" (quantity: 1, price: negative tax amount, e.g. -15.00).
   - CORP_ACTION (Splits): "SPLIT" (quantity: split multiplier, e.g. 10 for a 10-for-1 split, price: 0).
3. For "OPT" (options), ALWAYS include "optionDetails" and use underlying ticker in "underlying":
   "optionDetails": { "type": "CALL" or "PUT", "strike": 155, "expiry": "2025-01-17" }
   Also include "bucket": "LINKED" for Covered Calls / Cash-Secured Puts / wheel legs, or "STANDALONE" for speculative long options.
4. Keep "price" as per-share price (for options, do NOT multiply by 100 — e.g. if contract sold for $4.50, price is 4.50).
5. Preserve chronological order and exact dates ("YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD").`;

