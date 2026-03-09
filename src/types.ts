// ── Token & Market Types ──

export type Token = "BTC" | "ETH" | "SOL" | "XRP";

export const TOKENS: Token[] = ["BTC", "ETH", "SOL", "XRP"];

// Binance trading pairs
export const BINANCE_PAIRS: Record<Token, string> = {
  BTC: "btcusdt",
  ETH: "ethusdt",
  SOL: "solusdt",
  XRP: "xrpusdt",
};

// ── Price Data ──

export interface PriceUpdate {
  token: Token;
  price: number;
  timestamp: number;
}

export interface TokenState {
  currentPrice: number;
  referencePrice: number;
  priceHistory: { time: number; price: number }[];
  lastUpdate: number;
}

// ── Window ──

export interface WindowInfo {
  windowStartTime: Date;
  windowEndTime: Date;
  timeRemainingMs: number;
  timeElapsedMs: number;
  windowId: string; // e.g., "2026-03-09T12:00Z"
}

// ── Signal ──

export interface Signal {
  shouldBet: boolean;
  token: Token;
  direction: "Up" | "Down";
  confidence: number;
  polymarketPrice: number;
  edge: number;
  suggestedSize: number;
  reason: string;
  gapPercent: number;
  volatility: number;
  timeLeftSec: number;
}

// ── Paper Trade ──

export interface PaperTrade {
  id: string;
  token: Token;
  direction: "Up" | "Down";
  entryPrice: number; // Polymarket price paid (e.g., 0.68)
  size: number; // USD amount
  referencePrice: number; // Binance ref price at window start
  currentPriceAtEntry: number; // Binance price when bet placed
  windowId: string;
  timestamp: number;
  resolved: boolean;
  won: boolean | null;
  pnl: number | null;
  resolutionPrice: number | null;
}

// ── Session Stats ──

export interface SessionStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalWagered: number;
  winRate: number;
  peakPnl: number;
  maxDrawdown: number;
  byToken: Record<Token, { trades: number; wins: number; pnl: number }>;
}

// ── Config ──

export interface Config {
  bankroll: number;
  maxBetPerToken: number;
  maxBetPerWindow: number;
  windowMinutes: number;
  // Gate thresholds
  minTimeLeftSec: number; // Only bet in last N seconds
  maxTimeLeftSec: number; // Don't bet too early
  minGapPercent: number; // Minimum price gap
  maxVolatility: number; // Maximum 60s volatility
  minEdge: number; // Minimum edge after fees
  takerFeeRate: number; // Polymarket taker fee
  kellyFraction: number; // Fraction of Kelly criterion
}
