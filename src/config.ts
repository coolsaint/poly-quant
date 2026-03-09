import type { Config } from "./types.js";

export const config: Config = {
  // Capital
  bankroll: 500,
  maxBetPerToken: 15,
  maxBetPerWindow: 40,
  windowMinutes: 15,

  // Gate 1: Time — only bet in last 60 seconds of window
  minTimeLeftSec: 5, // Don't bet with <5s left (slippage risk)
  maxTimeLeftSec: 60, // Don't bet with >60s left (too early)

  // Gate 2: Price gap — minimum 0.15% gap from reference
  minGapPercent: 0.15,

  // Gate 3: Volatility — max 0.03% rolling 60s volatility
  maxVolatility: 0.03,

  // Gate 4: Confidence — minimum 85%
  minConfidence: 0.85,

  // Gate 5: Edge — minimum 10% after fees
  minEdge: 0.10,

  // Fees & sizing
  takerFeeRate: 0.0156, // Polymarket taker fee rate
  kellyFraction: 0.25, // Quarter Kelly
};
