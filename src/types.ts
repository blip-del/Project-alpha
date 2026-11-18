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
}

export const DEFAULT_OPTIONAL_PANELS: OptionalPanelsState = {
  stepDown: false,
  monthlyCashflow: false,
  expiryMatrix: false,
};

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
