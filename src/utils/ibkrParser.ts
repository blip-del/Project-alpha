/**
 * Interactive Brokers (IBKR) Multi-Section Activity Statement & Flex XML Parser
 * Offline-capable client-side parser and SHA-like deduplication engine.
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
    cashByCurrency?: Record<string, number>;
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
  cashByCurrency?: Record<string, number>;
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
  const cashByCurrency: Record<string, number> = {};
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

    // 0B. Parse <CashReport> ending cash, per-currency cash buckets & deposits/withdrawals summary
    const cashReportNodes = Array.from(doc.querySelectorAll('CashReport > CashReportCurrency, CashReportCurrency'));
    const cashReportFirst = cashReportNodes[0];
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

    // Extract per-currency endingCash balances when multiple CashReportCurrency nodes are present
    const nonBaseNodes = cashReportNodes.filter((n) => (n.getAttribute('currency') || '').toUpperCase() !== 'BASE_SUMMARY');
    const explicitCurrencyNodes = nonBaseNodes.filter((n) => Boolean(n.getAttribute('currency')));
    if (explicitCurrencyNodes.length > 0) {
      for (const n of explicitCurrencyNodes) {
        const cur = (n.getAttribute('currency') || '').toUpperCase();
        const endVal = parseFloat(n.getAttribute('endingCash') || '');
        if (cur && !isNaN(endVal)) {
          cashByCurrency[cur] = endVal;
        }
      }
    } else if (cashReportNodes.length === 3 && endingCashBase !== undefined) {
      // Standard IBKR 3-row CashReport when currency attr is omitted: [BASE_SUMMARY, baseCurrency, foreignCurrency]
      const otherCurrency = baseCurrency === 'EUR' ? 'USD' : 'EUR';
      const c1 = parseFloat(cashReportNodes[1].getAttribute('endingCash') || '');
      const c2 = parseFloat(cashReportNodes[2].getAttribute('endingCash') || '');
      const fxOtherToBase = fxRates[`${otherCurrency}->${baseCurrency}`] || (baseCurrency === 'EUR' ? 0.91 : 1.099);
      if (!isNaN(c1) && !isNaN(c2)) {
        const errDirect = Math.abs(c1 + c2 * fxOtherToBase - endingCashBase);
        const errSwapped = Math.abs(c2 + c1 * fxOtherToBase - endingCashBase);
        if (errDirect < errSwapped && errDirect < Math.max(5, Math.abs(endingCashBase) * 0.02)) {
          cashByCurrency[baseCurrency] = c1;
          cashByCurrency[otherCurrency] = c2;
        } else if (errSwapped < Math.max(5, Math.abs(endingCashBase) * 0.02)) {
          cashByCurrency[baseCurrency] = c2;
          cashByCurrency[otherCurrency] = c1;
        }
      }
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
    cashByCurrency: Object.keys(cashByCurrency).length > 0 ? cashByCurrency : undefined,
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
  cashByCurrency?: Record<string, number>;
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
      cashByCurrency: cashSummary?.cashByCurrency,
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
  cashByCurrency?: Record<string, number>;
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
      cashByCurrency: res.cashByCurrency,
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

