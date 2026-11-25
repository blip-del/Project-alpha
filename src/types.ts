/**
 * Portfolio Performance Tracker & Real Entry Price Engine Types
 */

export type AssetCategory = 'STK' | 'OPT' | 'CASH' | 'DIV' | 'TAX' | 'CORP_ACTION';
export type TradeAction = 'BUY' | 'SELL' | 'DIV' | 'TAX' | 'SPLIT' | 'EXPIRED' | 'ASSIGNED';
export type BucketType = 'LINKED' | 'STANDALONE';

export interface OptionDetails {
  type: 'CALL' | 'PUT';
  strike: number;
  expiry: string; // YYYY-MM-DD
  isShort: boolean;
}

export interface PositionMark {
  symbol: string;
  underlying: string;
  assetCategory: 'STK' | 'OPT';
  currency: string;
  position: number;
  markPrice: number;
  positionValue: number;
  costBasisMoney: number;
  fifoPnlUnrealized: number;
  listingExchange?: string;
  underlyingListingExchange?: string;
}

export interface BrokerCashSummary {
  endingCashBase?: number;
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  cashByCurrency?: Record<string, number>;
  currency: 'EUR' | 'USD';
}

export interface Transaction {
  id: string; // Deduplication hash: (dateTime + symbol + quantity + price + tradeId)
  dateTime: string; // YYYY-MM-DD HH:mm:ss
  date: string; // YYYY-MM-DD
  section: string;
  assetCategory: AssetCategory;
  symbol: string;
  underlying: string;
  action: TradeAction;
  quantity: number; // Positive = Buy/Long/Credit, Negative = Sell/Short
  price: number; // Unit price
  multiplier?: number; // 1 for STK, 100 (or 1000 for IDEM) for OPT
  proceeds: number; // Gross transaction proceeds
  commission: number; // Broker commission/fees (negative or positive amount)
  netCashFlow: number; // Actual cash impact in transaction currency
  currency: string; // USD, EUR, etc.
  fxRateToBase: number; // Multiplier to convert to base currency
  realizedPnl?: number; // IBKR-reported realized P&L if available
  openCloseIndicator?: 'O' | 'C';
  listingExchange?: string;
  tradeId: string;
  notes?: string;
  optionDetails?: OptionDetails;
  defaultBucket: BucketType;
  bucket: BucketType; // Current bucket (after user override)
  corporateAction?: {
    type: 'SPLIT';
    ratio: number;
  };
}

export interface ChronologicalStep {
  date: string;
  tradeId: string;
  actionDesc: string;
  impactType: 'BUY' | 'SELL' | 'DIVIDEND' | 'OPTION_PREMIUM' | 'OPTION_DEBIT' | 'SPLIT';
  sharesBefore: number;
  sharesAfter: number;
  rawPoolBefore: number;
  rawPoolAfter: number;
  adjustedPoolBefore: number;
  adjustedPoolAfter: number;
  rawAvgCostAfter: number;
  realEntryPriceAfter: number;
  impactAmount: number;
  notes: string;
}

export interface DividendRecord {
  id: string;
  date: string;
  grossAmount: number;
  withholdingTax: number;
  netAmount: number;
  currency: string;
  fxRateToBase: number;
  description: string;
}

export interface OptionCampaign {
  id: string;
  underlying: string;
  contractSymbol: string;
  type: 'CALL' | 'PUT';
  strike: number;
  expiry: string;
  multiplier: number;
  currency: string;
  bucket: BucketType;
  trades: Transaction[];
  netContracts: number; // 0 = closed, -1 = short 1, +1 = long 1
  totalCredits: number;
  totalDebits: number;
  netCashFlow: number;
  realizedPnl: number;
  openCostBasis?: number;
  currentMarkPrice?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  status: 'OPEN' | 'CLOSED' | 'EXPIRED' | 'ASSIGNED';
  isCurrentCoveredCall?: boolean;
}

export interface StockPosition {
  ticker: string;
  companyName: string;
  currency: string;
  listingExchange?: string;
  currentShares: number;
  rawCostPool: number;
  adjustedCostPool: number;
  rawAvgEntry: number;
  realEntryPrice: number;
  spotPrice: number;
  spotChange: number;
  spotChangePct: number;
  marketValue: number;
  unrealizedPnlRaw: number;
  unrealizedPnlReal: number;
  unrealizedPnlRealPct: number;
  downsideCushionDollar: number;
  downsideCushionPct: number;
  basisReductionDollar: number;
  basisReductionPct: number;
  totalDividendsGross: number;
  totalWithholdingTax: number;
  totalDividendsNet: number;
  totalLinkedPremiums: number;
  totalRealizedStockPnl: number;
  yieldOnCostPct: number;
  transactions: Transaction[];
  timeline: ChronologicalStep[];
  linkedOptionCampaigns: OptionCampaign[];
  standaloneOptionCampaigns: OptionCampaign[];
  activeCoveredCalls: OptionCampaign[];
  dividends: DividendRecord[];
}

export interface StandaloneOptionPosition {
  id: string;
  underlying: string;
  contractSymbol: string;
  type: 'CALL' | 'PUT';
  strike: number;
  expiry: string;
  multiplier: number;
  currency: string;
  netContracts: number;
  avgEntryPrice: number;
  currentMarkPrice: number;
  openCostBasis: number;
  marketValue: number;
  unrealizedPnl: number;
  totalOutlay: number;
  totalReceived: number;
  realizedPnl: number;
  status: 'OPEN' | 'CLOSED';
  trades: Transaction[];
}

export interface CampaignComparisonItem {
  id: string;
  kind: 'STOCK_LOT' | 'OPTION_CAMPAIGN' | 'DIVIDENDS';
  contractSymbol: string;
  title: string;
  strategyType: string;
  bucket: BucketType;
  canToggleBucket: boolean;
  transactionIds: string[];
  status: 'OPEN' | 'CLOSED';
  dte?: number;
  expiry?: string;
  strike?: number;
  optionType?: 'CALL' | 'PUT';
  netContracts?: number;
  strikeCushionPct?: number;
  currency: string;
  capitalDeployedNative: number;
  capitalDeployedBase: number;
  netCashNative: number;
  realizedPnlNative: number;
  unrealizedPnlNative: number;
  netPnlNative: number;
  netPnlBase: number;
  tradeRoiPct: number;
  annualizedReturnPct: number | null;
  holdingDays: number;
  trades: Transaction[];
  legacyIds?: string[]; // Previous unstable IDs (e.g. camp-stk-TICKER or camp-SYM-LINKED) for lossless override migration
}

export interface UnifiedTickerSummary {
  ticker: string;
  companyName: string;
  currency: string;
  isActive: boolean;
  hasStockPosition: boolean;
  hasOpenOptions: boolean;
  spotPrice: number;
  spotChange: number;
  spotChangePct: number;
  currentShares: number;
  openOptionCount: number;
  totalCampaignCount: number;
  rawAvgEntry: number;
  realEntryPrice: number;
  basisReductionPct: number;
  cushionPct: number;
  stockMarketValueNative: number;
  stockMarketValueBase: number;
  openOptionsMarketValueNative: number;
  openOptionsMarketValueBase: number;
  totalExposureBase: number;
  capitalAtRiskNative: number;
  capitalAtRiskBase: number;
  activeOpenPnlNative: number;
  activeOpenPnlBase: number;
  activeOpenPnlPct: number;
  realizedPnlNative: number;
  realizedPnlBase: number;
  totalNetPnlNative: number;
  totalNetPnlBase: number;
  annualizedReturnPct: number | null;
  isShortDuration: boolean;
  holdingDays: number;
  stockPosition?: StockPosition;
  campaigns: CampaignComparisonItem[];
}

export interface PortfolioSummary {
  totalMarketValue: number; // Active Stocks + Open Options net market value (in baseCurrency)
  totalStockMarketValue: number; // Active Stocks market value (in baseCurrency)
  totalOpenOptionsValue: number; // Net market value of open options (in baseCurrency)
  totalRawCostBasis: number; // Active Stocks raw cost pool (in baseCurrency)
  totalAdjustedCostBasis: number; // Active Stocks adjusted cost pool (in baseCurrency)
  totalUnrealizedPnlRaw: number;
  totalUnrealizedPnlReal: number;
  totalUnrealizedPnlRealPct: number;
  totalRealizedStockPnl: number;
  totalNetDividends: number;
  totalLinkedOptionPremiums: number;
  totalStandaloneOptionsPnl: number;
  totalStandaloneUnrealizedPnl: number;
  totalNetBasisReduction: number; // (Raw Basis - Real Basis)
  weightedDownsideCushionPct: number;
  overallYoCPct: number;
  // Reconciled KPI totals (matching sum of unifiedTickers)
  totalActiveOpenPnlBase: number;
  totalRealizedAllPnlBase: number;
  totalNetAllPnlBase: number;
  shortPutCollateralBase: number;
  baseCurrency: 'EUR' | 'USD';
  openStockCount: number;
  openOptionCount: number;
  totalTransactionCount: number;
}

export interface MonthlyCashflowRecord {
  month: string; // YYYY-MM
  label: string; // "Jan '23"
  netDividends: number;
  linkedPremiums: number;
  standalonePnl: number;
  totalInflow: number;
}

export interface ActiveOptionMetric {
  id: string;
  underlying: string;
  contractSymbol: string;
  type: 'CALL' | 'PUT';
  action: 'SHORT' | 'LONG';
  strike: number;
  spotPrice: number;
  expiry: string;
  dte: number;
  contracts: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnlNative: number;
  unrealizedPnlBase: number;
  strikeCushionPct: number;
  profitCapturedPct: number;
  extrinsicRemaining: number;
  annualizedApr: number;
  thetaPerDay: number;
  statusTag: 'ROLL_CANDIDATE' | 'SWEET_SPOT' | 'EXPIRING_SOON' | 'TESTED' | 'ACTIVE';
  statusLabel: string;
  bucket: BucketType;
  currency?: string;
}

export interface CapitalAllocation {
  equityValue: number;
  cashCollateral: number;
  standaloneOptionsValue: number;
  freeCashBuffer: number;
  totalCapital: number;
  usdAmount: number;
  eurAmount: number;
  usdPercent: number;
  eurPercent: number;
  usdToEurRate: number;
}

export interface AdvancedKPIs {
  xirrPct: number;
  returnOnMarginPct: number;
  annualizedAprPct: number;
  dailyThetaDollars: number;
  totalDeposits: number;
  netGainDollars: number;
}

export interface OptionalPanelsState {
  stepDown: boolean;
  monthlyCashflow: boolean;
  expiryMatrix: boolean;
  filteredJournal: boolean;
}

export const DEFAULT_OPTIONAL_PANELS: OptionalPanelsState = {
  stepDown: false,
  monthlyCashflow: false,
  expiryMatrix: false,
  filteredJournal: false,
};

// ------------------------------------------------------------
// FILTERED JOURNAL DEEP-DIVE TYPES
// ------------------------------------------------------------

export type JournalSignalColor = 'RED' | 'AMBER' | 'GREEN' | 'GREY';

export type JournalCatalystType =
  | 'Earnings'
  | 'Clinical / FDA'
  | 'Insider Cluster'
  | 'Activist / 13D'
  | 'M&A / Spin-off'
  | 'Product / Contract'
  | 'Macro / Technical'
  | 'Other';

export type JournalExitReason =
  | 'stop'
  | 'target'
  | 'thesis_broke'
  | 'gap'
  | 'expiry';

export interface SecForm4Summary {
  insiderName: string;
  insiderRole: string;
  transactionCode: string;
  actionLabel: string;
  shares: number;
  pricePerShare: number;
  totalValue: number;
  isOpenMarketBuy: boolean;
  isOpenMarketSale: boolean;
  isRoutineNoise: boolean;
}

export interface SecFilingItem {
  form: string;
  filingDate: string;
  reportDate?: string;
  accessionNumber: string;
  description: string;
  secUrl: string;
  isTriggerForm: boolean;
  form4Summary?: SecForm4Summary;
}

export interface SecTickerFilings {
  ticker: string;
  cik?: string;
  companyName?: string;
  status: 'OK' | 'NO_CIK' | 'ERROR';
  error?: string;
  fetchedAt: string;
  source: string;
  filings: SecFilingItem[];
}

export interface JournalLoggedFields {
  insiderCluster?: boolean;
  preCatalystEntry?: boolean;
  asymmetricRR?: boolean;
  volumeConfirmed?: boolean;
  sectorTailwind?: boolean;
}

export interface JournalTradeOverride {
  riskPerTrade?: number; // Fixed 1R in position native currency (default 100)
  thesis?: string;
  stopPrice?: number;
  target1?: number;
  target2?: number;
  target3?: number;
  catalystType?: JournalCatalystType;
  catalystDate?: string; // YYYY-MM-DD
  thesisBroken?: boolean;
  lastViewedAt?: string; // ISO timestamp for detecting new filings since last view
  manualPriceOverride?: number;
  manualPriceTimestamp?: string;
  manualFilingNote?: string;
  exitReason?: JournalExitReason;
  lesson?: string;
  loggedFields?: JournalLoggedFields;
}

export interface JournalSavedView {
  id: string;
  name: string;
  builtIn?: boolean;
  instrument: 'ALL' | 'STOCK' | 'OPTION';
  statusChip: 'OPEN' | 'ATTENTION' | 'CLOSED';
  catalystFilter: string;
  ageFilter: 'ALL' | 'LT14' | 'D14_60' | 'GT60';
  expiringThisMonth?: boolean;
  insiderClusterOnly?: boolean;
}

export interface JournalSettings {
  defaultRisk1R: number; // Default 100
  sleeveCapPct: number; // Configurable portfolio open-risk sleeve cap % (default 10)
  autoRefreshMinutes: number; // Default 15
  savedViews: JournalSavedView[];
}

export const DEFAULT_JOURNAL_SAVED_VIEWS: JournalSavedView[] = [
  {
    id: 'view-opt-month',
    name: 'Options expiring this month',
    builtIn: true,
    instrument: 'OPTION',
    statusChip: 'OPEN',
    catalystFilter: 'ALL',
    ageFilter: 'ALL',
    expiringThisMonth: true,
  },
  {
    id: 'view-insider-cluster',
    name: 'Insider-cluster trades',
    builtIn: true,
    instrument: 'ALL',
    statusChip: 'OPEN',
    catalystFilter: 'ALL',
    ageFilter: 'ALL',
    insiderClusterOnly: true,
  },
];

export const DEFAULT_JOURNAL_SETTINGS: JournalSettings = {
  defaultRisk1R: 100,
  sleeveCapPct: 10,
  autoRefreshMinutes: 15,
  savedViews: DEFAULT_JOURNAL_SAVED_VIEWS,
};

export interface JournalSignalReason {
  level: JournalSignalColor;
  code: string;
  detail: string;
  source: string;
  timestamp?: string;
}

export interface JournalDerivedTrade {
  id: string; // matches CampaignComparisonItem.id
  ticker: string;
  companyName: string;
  contractSymbol: string;
  instrument: 'STOCK' | 'OPTION';
  displayType: string; // e.g., "Stock", "Long Call", "Short Call", "Long Put"
  optionType?: 'CALL' | 'PUT';
  isShortOption?: boolean;
  status: 'OPEN' | 'CLOSED';
  currency: string;
  fxToBase: number;

  // Dates & age
  entryDate: string;
  exitDate?: string;
  holdingDays: number;
  dte?: number;
  expiry?: string;
  catalystType: JournalCatalystType;
  catalystDate?: string;
  nextEventDate?: string; // nearest of catalystDate or expiry
  daysToNextEvent?: number;

  // Quantity, prices & provenance
  quantity: number; // shares or contracts
  multiplier: number;
  entryPrice: number; // per share or per option contract share
  realEntryPrice?: number;
  currentPrice: number;
  priceSource: 'Yahoo Finance' | 'IBKR XML Mark' | 'Manual Override' | 'Missing';
  priceTimestamp?: string;
  priceIsStale: boolean;

  // Fixed 1R Risk & Sizing
  risk1RNative: number;
  risk1RBase: number;
  plannedSizeUnits?: number; // Stocks: floor(1R / |entry - stop|); Options: floor(1R / (entry*mult))
  openRiskNative: number;
  openRiskBase: number;

  // Stock Range Bar levels
  stopPrice?: number;
  target1?: number;
  target2?: number;
  target3?: number;
  stopDistancePct?: number; // % of entry-to-stop cushion remaining

  // Option-specific metrics
  strike?: number;
  premiumPaidNative?: number;
  currentOptionValueNative?: number;
  premiumChangePct?: number; // (currentValue - premiumPaid) / premiumPaid * 100
  breakevenPrice?: number;
  spotPrice?: number;
  breakevenDiffPct?: number; // how far current spot is from breakeven

  // Results in currency & R
  pnlNative: number;
  pnlBase: number;
  currentR: number;
  plannedLossR: number; // -1.0R
  actualLossR?: number; // negative R on losing closed trades

  // Qualitative / Journal fields
  thesis: string;
  thesisBroken: boolean;
  exitReason?: JournalExitReason;
  lesson?: string;
  loggedFields: JournalLoggedFields;
  hasInsiderCluster: boolean;

  // SEC Filings
  secFilings: SecFilingItem[];
  newTriggerFilings: SecFilingItem[];
  secStatus: 'OK' | 'NO_CIK' | 'ERROR' | 'IDLE';
  secFetchedAt?: string;
  lastViewedAt?: string;
  manualFilingNote?: string;

  // Signal system (only color system: 4 states)
  signalColor: JournalSignalColor;
  signalPriority: number; // 0=RED, 1=AMBER, 2=GREEN, 3=GREY
  signalReasons: JournalSignalReason[];
}

export interface ViewVisibilityState {
  // Overview KPIs
  kpi_portfolio_value: boolean;
  kpi_cost_vs_real: boolean;
  kpi_cushion: boolean;
  kpi_income: boolean;
  kpi_yoc: boolean;
  kpi_realized_pnl: boolean;
  section_broker_funding: boolean;

  // Overview Charts
  chart_allocation: boolean;
  chart_basis_comparison: boolean;
  chart_waterfall: boolean;
  chart_cushion_ranking: boolean;
  chart_income_timeline: boolean;

  // Positions & Campaigns Sections
  section_active_equities: boolean;
  section_standalone_options: boolean;
  section_closed_positions: boolean;

  // Analytics Modules
  analytics_step_down: boolean;
  analytics_portfolio_deposits: boolean;
  analytics_monthly_income: boolean;
  analytics_standalone_pnl: boolean;
  analytics_open_expiries: boolean;
  analytics_allocation_fx: boolean;

  // Advanced KPIs
  kpi_xirr: boolean;
  kpi_rom: boolean;
  kpi_apr: boolean;
  kpi_theta: boolean;
}

export const DEFAULT_VISIBILITY: ViewVisibilityState = {
  kpi_portfolio_value: true,
  kpi_cost_vs_real: true,
  kpi_cushion: true,
  kpi_income: true,
  kpi_yoc: true,
  kpi_realized_pnl: true,
  section_broker_funding: true,
  chart_allocation: true,
  chart_basis_comparison: true,
  chart_waterfall: true,
  chart_cushion_ranking: true,
  chart_income_timeline: true,
  section_active_equities: true,
  section_standalone_options: true,
  section_closed_positions: true,

  analytics_step_down: false,
  analytics_portfolio_deposits: false,
  analytics_monthly_income: false,
  analytics_standalone_pnl: false,
  analytics_open_expiries: false,
  analytics_allocation_fx: false,

  kpi_xirr: true,
  kpi_rom: true,
  kpi_apr: true,
  kpi_theta: true,
};

export interface StockQuote {
  symbol: string;
  shortName: string;
  regularMarketPrice: number;
  regularMarketChange: number;
  regularMarketChangePercent: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  marketCap?: number;
  exchange?: string;
}

// ------------------------------------------------------------
// SAFE INCREMENTAL XML IMPORT & SNAPSHOT GUARD TYPES
// ------------------------------------------------------------

export interface CashTransferEvent {
  id: string; // IBKR transactionID or deterministic hash
  date: string; // YYYY-MM-DD
  amountBase: number; // positive = deposit, negative = withdrawal
  currency: string;
  description?: string;
}

export interface StatementSnapshotMeta {
  fromDate?: string; // YYYY-MM-DD from <FlexStatement fromDate>
  toDate?: string; // YYYY-MM-DD from <FlexStatement toDate>
  whenGenerated?: string; // Raw or normalized timestamp from <FlexStatement whenGenerated>
  importedAt: string; // ISO timestamp when merged into app
  sourceLabel?: string; // filename or "Pasted Data"
  format: 'XML' | 'CSV' | 'JSON';
  isFullHistory?: boolean;
  knownCashTransferIds?: string[]; // Dedup set for incremental CashTransaction deposit/withdrawal deltas
}

export interface ImportNewlyClosedTrade {
  id: string;
  ticker: string;
  title: string;
  instrument: 'STOCK' | 'OPTION';
  needsLesson: boolean;
}

export interface ImportMergeDiff {
  sourceLabel: string;
  format: 'XML' | 'CSV' | 'JSON';
  statementFromDate?: string;
  statementToDate?: string;
  newTransactionsCount: number;
  duplicatesSkipped: number;
  enrichedUpdatedCount: number;
  crossSourceDividendsSkipped: number;
  snapshotUpdated: boolean;
  snapshotGuardReason?: string;
  depositsPreservedReason?: string;
  newlyClosedTrades: ImportNewlyClosedTrade[];
  newlyOpenedTradesCount: number;
  staleManualPricesCleared: number;
  manualOverridesPreserved: number;
  migratedOverridesCount: number;
  sectionsFound: string[];
}

export interface ImportUndoSnapshot {
  createdAt: string;
  sourceLabel: string;
  transactions: Transaction[];
  fxRates: Record<string, number>;
  positionMarks: Record<string, PositionMark>;
  endingCashBase?: number;
  endingCashCurrency: 'EUR' | 'USD';
  depositsBase?: number;
  withdrawalsBase?: number;
  netDepositsBase?: number;
  cashByCurrency?: Record<string, number>;
  bucketOverrides: Record<string, BucketType>;
  journalOverrides: Record<string, JournalTradeOverride>;
  lastStatementMeta?: StatementSnapshotMeta;
}

// ------------------------------------------------------------
// AI FILING & NEWS INTELLIGENCE + POST-MORTEM REVIEW TYPES
// ------------------------------------------------------------

export interface JournalIntelSource {
  title: string;
  url: string;
}

export interface JournalFilingDigest {
  form: string;
  date: string;
  materiality: 'MATERIAL' | 'DILUTION' | 'INSIDER_BUY' | 'ROUTINE';
  headline: string;
  summary: string;
  secUrl?: string;
}

export interface JournalThesisCheck {
  verdict: 'ALIGNED' | 'WATCH' | 'RISK' | 'NO_THESIS';
  summary: string;
  evidence: string;
  sourceUrl?: string;
}

export interface JournalCatalystRadar {
  suggestedCatalystType?: JournalCatalystType;
  suggestedDate?: string; // YYYY-MM-DD
  eventLabel: string;
  timelineDrift: 'ON_TRACK' | 'DELAYED' | 'PULLED_FORWARD' | 'UNKNOWN';
  driftNote?: string;
  sourceUrl?: string;
}

export interface JournalRunwayDilution {
  cashAndEquivalents?: string;
  quarterlyBurn?: string;
  estimatedRunwayMonths?: number | null;
  dilutionRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'UNKNOWN';
  atmOrShelfNote: string;
  asOfDate?: string;
}

export interface JournalExitContext {
  summary: string;
  keyEvents: Array<{
    date: string;
    headline: string;
    sourceUrl?: string;
  }>;
}

export interface JournalTradeIntel {
  ticker: string;
  analyzedAt: string; // ISO timestamp
  source: string; // e.g. "SEC EDGAR + Gemini Search Grounding"
  thesisSnapshot?: string; // thesis at time of analysis
  thesisCheck: JournalThesisCheck;
  filingDigests: JournalFilingDigest[];
  catalystRadar: JournalCatalystRadar;
  runwayAndDilution: JournalRunwayDilution;
  exitContext?: JournalExitContext;
  sources: JournalIntelSource[];
}

export interface JournalPostMortemReview {
  analyzedAt: string;
  closedTradeCount: number;
  executiveTakeaway: string;
  workingEdges: string[];
  recurringLeaks: string[];
  nextTradeRules: string[];
}


