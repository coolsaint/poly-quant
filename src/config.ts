import type { Config } from "./types.js";

export const config: Config = {
  // Capital
  bankroll: 500,
  maxBetPerToken: 15,
  maxBetPerWindow: 40,
  windowMinutes: 15,

  // Gate 1: Time — only bet in last 90 seconds of window
  minTimeLeftSec: 5,
  maxTimeLeftSec: 90,

  // Gate 2: Price gap — minimum 0.10% gap from reference
  minGapPercent: 0.10,

  // Gate 3: Volatility — max 0.12% rolling 60s volatility
  maxVolatility: 0.12,

  // Gate 4: Confidence — minimum 80%
  minConfidence: 0.80,

  // Gate 5: Edge — minimum 8% after fees
  minEdge: 0.08,

  // Fees & sizing
  takerFeeRate: 0.0156, // Polymarket taker fee rate
  kellyFraction: 0.25, // Quarter Kelly
};
