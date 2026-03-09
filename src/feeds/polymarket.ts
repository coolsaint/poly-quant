/**
 * Polymarket price simulator for paper trading.
 *
 * In paper trading mode, we simulate Polymarket odds based on the
 * price gap from reference. In live mode, this would connect to
 * the Polymarket CLOB WebSocket / REST API.
 *
 * The simulation models how Polymarket odds typically behave:
 * - At window start (price near ref): ~50/50
 * - As gap grows: odds shift toward the leading direction
 * - Market makers are somewhat efficient but lag real price by ~5-15s
 * - There's noise/spread in the odds
 */
export class PolymarketSimulator {
  /**
   * Simulate what Polymarket "Up" token would cost given the current gap.
   *
   * This models the empirical relationship between Binance price gap
   * and Polymarket odds. Market makers on Polymarket adjust odds based
   * on the same price feed, but with lag and noise.
   *
   * @param gapPercent - Current price gap from reference (positive = up)
   * @param timeLeftSec - Seconds remaining in window
   * @returns Simulated price for "Up" token (0.01 to 0.99)
   */
  getSimulatedUpPrice(gapPercent: number, timeLeftSec: number): number {
    // Base probability from gap using logistic function
    // At 0% gap → 0.50, at 0.3% gap → ~0.75, at 0.5% gap → ~0.88
    const k = 8; // Steepness — how quickly odds shift with gap
    const baseProbability = 1 / (1 + Math.exp(-k * gapPercent));

    // Time factor: as time runs out, odds converge more to true direction
    // With more time left, odds are closer to 50/50 (more uncertainty)
    const timeFactor = 1 - timeLeftSec / 900; // 0 at window start, 1 at end
    const adjustedProbability =
      0.5 + (baseProbability - 0.5) * (0.6 + 0.4 * timeFactor);

    // Add market maker noise (±2%)
    const noise = (Math.random() - 0.5) * 0.04;

    // Add spread (market maker takes ~2-3 cents)
    // If you're buying the likely direction, you pay slightly more
    const spread = 0.02;
    const withSpread =
      gapPercent > 0
        ? adjustedProbability + spread / 2 // Buying Up when price is up = pay premium
        : adjustedProbability - spread / 2; // Buying Up when price is down = get discount

    const final = Math.max(0.02, Math.min(0.98, withSpread + noise));
    return Math.round(final * 100) / 100;
  }

  /**
   * Simulate order book depth available at current price.
   * Thin books are realistic for 15-min markets.
   */
  getSimulatedBookDepth(token: string): number {
    const baseDepth: Record<string, number> = {
      BTC: 350,
      ETH: 200,
      SOL: 125,
      XRP: 100,
    };
    const base = baseDepth[token] ?? 100;
    // Random variation ±30%
    const variation = 0.7 + Math.random() * 0.6;
    return Math.round(base * variation);
  }
}
