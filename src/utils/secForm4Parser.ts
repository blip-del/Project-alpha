/**
 * Pure SEC Form 4 XML Parser, Filing Excerpt Cleaner & URL Sanitizer
 * Shared between server.ts and client/unit tests (zero browser/DOM dependencies).
 */

import type { SecForm4Summary } from '../types';

const ROUTINE_FORM4_CODES = new Set(['A', 'M', 'F', 'G', 'C', 'D', 'E', 'H', 'I', 'J', 'W', 'Z']);

function extractTagValue(xml: string, tagName: string): string {
  const re = new RegExp(`<${tagName}[^>]*>\\s*(?:<value[^>]*>)?([^<]*)(?:<\\/value>)?\\s*<\\/${tagName}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Strip optional XSLT stylesheet prefix (e.g. xslF345X05/form4.xml -> form4.xml)
 * so SEC EDGAR returns raw machine-readable Form 4 XML instead of HTML.
 */
export function stripSecXsltPrefix(primaryDoc: string): string {
  const clean = (primaryDoc || '').trim().replace(/^\/+/, '');
  if (!clean) return '';
  const parts = clean.split('/');
  if (parts.length >= 2 && /^xsl[A-Za-z0-9_\-]+$/i.test(parts[0])) {
    return parts.slice(1).join('/');
  }
  return clean;
}

/**
 * Parse raw SEC EDGAR Form 4 XML into a deterministic insider transaction summary.
 * Distinguishes genuine open-market purchases (Code P) and sales (Code S) from
 * routine RSU grants (A), option exercises (M), and tax withholdings (F).
 */
export function parseForm4Xml(xml: string): SecForm4Summary | null {
  if (!xml || !xml.includes('<ownershipDocument')) return null;

  const insiderName = extractTagValue(xml, 'rptOwnerName') || 'Reporting Insider';
  const officerTitle = extractTagValue(xml, 'officerTitle');
  const isDirector = extractTagValue(xml, 'isDirector') === '1' || extractTagValue(xml, 'isDirector').toLowerCase() === 'true';
  const isTenPercent =
    extractTagValue(xml, 'isTenPercentOwner') === '1' ||
    extractTagValue(xml, 'isTenPercentOwner').toLowerCase() === 'true';

  const insiderRole =
    officerTitle ||
    (isDirector && isTenPercent
      ? 'Director & 10% Owner'
      : isDirector
      ? 'Director'
      : isTenPercent
      ? '10% Owner'
      : 'Insider');

  // Collect all nonDerivativeTransaction & derivativeTransaction blocks
  const txBlocks: string[] = [];
  const nonDerivMatches = xml.match(/<nonDerivativeTransaction[\s\S]*?<\/nonDerivativeTransaction>/gi) || [];
  const derivMatches = xml.match(/<derivativeTransaction[\s\S]*?<\/derivativeTransaction>/gi) || [];
  txBlocks.push(...nonDerivMatches, ...derivMatches);

  if (txBlocks.length === 0) {
    return null;
  }

  let openMarketBuyShares = 0;
  let openMarketBuyValue = 0;
  let openMarketSaleShares = 0;
  let openMarketSaleValue = 0;
  let primaryCode = '';
  let totalSharesAny = 0;
  let totalValueAny = 0;
  const codesSeen = new Set<string>();

  for (const block of txBlocks) {
    const code = extractTagValue(block, 'transactionCode').toUpperCase();
    const shares = Math.abs(parseFloat(extractTagValue(block, 'transactionShares')) || 0);
    const price = Math.abs(parseFloat(extractTagValue(block, 'transactionPricePerShare')) || 0);
    const val = shares * price;

    if (code) codesSeen.add(code);
    if (!primaryCode && code) primaryCode = code;

    totalSharesAny += shares;
    totalValueAny += val;

    if (code === 'P') {
      openMarketBuyShares += shares;
      openMarketBuyValue += val;
    } else if (code === 'S') {
      openMarketSaleShares += shares;
      openMarketSaleValue += val;
    }
  }

  const isOpenMarketBuy = openMarketBuyShares > 0;
  const isOpenMarketSale = !isOpenMarketBuy && openMarketSaleShares > 0;
  const isRoutineNoise =
    !isOpenMarketBuy &&
    !isOpenMarketSale &&
    codesSeen.size > 0 &&
    Array.from(codesSeen).every((c) => ROUTINE_FORM4_CODES.has(c));

  const effectiveCode = isOpenMarketBuy ? 'P' : isOpenMarketSale ? 'S' : primaryCode || 'OTHER';
  const effectiveShares = isOpenMarketBuy
    ? openMarketBuyShares
    : isOpenMarketSale
    ? openMarketSaleShares
    : totalSharesAny;
  const effectiveValue = isOpenMarketBuy
    ? openMarketBuyValue
    : isOpenMarketSale
    ? openMarketSaleValue
    : totalValueAny;
  const avgPrice = effectiveShares > 0 && effectiveValue > 0 ? effectiveValue / effectiveShares : 0;

  let actionLabel = `Code ${effectiveCode}`;
  if (isOpenMarketBuy) actionLabel = 'Open-Market Buy (P)';
  else if (isOpenMarketSale) actionLabel = 'Open-Market Sale (S)';
  else if (effectiveCode === 'A') actionLabel = 'Grant / Award (A)';
  else if (effectiveCode === 'M') actionLabel = 'Option Exercise (M)';
  else if (effectiveCode === 'F') actionLabel = 'Tax Withholding (F)';
  else if (effectiveCode === 'G') actionLabel = 'Gift (G)';

  return {
    insiderName,
    insiderRole,
    transactionCode: effectiveCode,
    actionLabel,
    shares: Math.round(effectiveShares),
    pricePerShare: Number(avgPrice.toFixed(4)),
    totalValue: Math.round(effectiveValue),
    isOpenMarketBuy,
    isOpenMarketSale,
    isRoutineNoise,
  };
}

/**
 * Strip HTML/XBRL/XML tags from an SEC EDGAR filing document into clean, bounded plain text
 * suitable for LLM summarization without markup noise.
 */
export function extractPlainTextFromFiling(rawContent: string, maxChars = 9000): string {
  if (!rawContent) return '';
  const cleaned = rawContent
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#8217;/gi, "'")
    .replace(/&#8220;|&#8221;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxChars);
}

/**
 * Validate external URLs returned by upstream feeds or AI grounding chunks.
 * Strictly allows only http: and https: URLs and blocks javascript:/data:/local schemes.
 */
export function sanitizeExternalUrl(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1000) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.')
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
