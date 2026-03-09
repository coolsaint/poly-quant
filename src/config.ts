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

  // Gate 2: Price gap — minimum 0.05% gap from reference (Binance must show clear direction)
  minGapPercent: 0.05,

  // Gate 3: Volatility — max 0.15% rolling 60s volatility
  maxVolatility: 0.15,

  // Gate 4: Polymarket price cap — handled in signal engine (max 75¢)

  // Gate 5: Edge — minimum 3% after fees (mispricing strategy, tighter margins)
  minEdge: 0.03,

  // Fees & sizing
  takerFeeRate: 0.0156, // Polymarket taker fee rate
  kellyFraction: 0.25, // Quarter Kelly
};
