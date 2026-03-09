import type { Token, WindowInfo, TokenState } from "../types.js";
import { TOKENS } from "../types.js";
import { config } from "../config.js";

/**
 * Tracks 15-minute windows and captures reference prices at window boundaries.
 */
export class WindowManager {
  private states: Map<Token, TokenState> = new Map();
  private currentWindowId: string = "";
  private windowBetsPlaced: Map<Token, boolean> = new Map();

  constructor() {
    for (const token of TOKENS) {
      this.states.set(token, {
        currentPrice: 0,
        referencePrice: 0,
        priceHistory: [],
        lastUpdate: 0,
      });
      this.windowBetsPlaced.set(token, false);
    }
  }

  /**
   * Get current window timing info.
   */
  getCurrentWindow(): WindowInfo {
    const now = new Date();
    const minutesSinceMidnight =
      now.getUTCHours() * 60 + now.getUTCMinutes();
    const windowStart =
      Math.floor(minutesSinceMidnight / config.windowMinutes) *
      config.windowMinutes;

    const windowStartTime = new Date(now);
    windowStartTime.setUTCHours(Math.floor(windowStart / 60));
    windowStartTime.setUTCMinutes(windowStart % 60);
    windowStartTime.setUTCSeconds(0);
    windowStartTime.setUTCMilliseconds(0);

    const windowEndTime = new Date(
      windowStartTime.getTime() + config.windowMinutes * 60 * 1000
    );
    const timeRemainingMs = windowEndTime.getTime() - now.getTime();
    const timeElapsedMs = now.getTime() - windowStartTime.getTime();

    const windowId = windowStartTime.toISOString();

    return { windowStartTime, windowEndTime, timeRemainingMs, timeElapsedMs, windowId };
  }

  /**
   * Update price for a token. Captures reference price at window boundaries.
   * Returns true if a new window just started.
   */
  updatePrice(token: Token, price: number, timestamp: number): boolean {
    const state = this.states.get(token)!;
    const window = this.getCurrentWindow();
    let newWindow = false;

    // Detect new window
    if (window.windowId !== this.currentWindowId) {
      this.currentWindowId = window.windowId;
      newWindow = true;

      // Reset all reference prices and bet flags
      for (const t of TOKENS) {
        const s = this.states.get(t)!;
        // Set reference price to current known price
        if (s.currentPrice > 0) {
          s.referencePrice = s.currentPrice;
        }
        s.priceHistory = [];
        this.windowBetsPlaced.set(t, false);
      }
    }

    // Capture reference price if not yet set (first price in window)
    if (state.referencePrice === 0 && price > 0) {
      state.referencePrice = price;
    }

    // Update current price
    state.currentPrice = price;
    state.lastUpdate = timestamp;

    // Maintain rolling 60-second price history
    state.priceHistory.push({ time: Date.now(), price });
    const cutoff = Date.now() - 60000;
    while (
      state.priceHistory.length > 0 &&
      state.priceHistory[0].time < cutoff
    ) {
      state.priceHistory.shift();
    }

    return newWindow;
  }

  getState(token: Token): TokenState {
    return this.states.get(token)!;
  }

  /**
   * Mark that we've already bet this token in the current window.
   */
  markBetPlaced(token: Token): void {
    this.windowBetsPlaced.set(token, true);
  }

  hasBetThisWindow(token: Token): boolean {
    return this.windowBetsPlaced.get(token) ?? false;
  }

  /**
   * Calculate gap from reference price.
   */
  getGap(token: Token): {
    direction: "Up" | "Down";
    gapPercent: number;
    absGapPercent: number;
    gap: number;
  } {
    const state = this.states.get(token)!;
    if (state.referencePrice === 0) {
      return { direction: "Up", gapPercent: 0, absGapPercent: 0, gap: 0 };
    }
    const gap = state.currentPrice - state.referencePrice;
    const gapPercent = (gap / state.referencePrice) * 100;
    return {
      direction: gap >= 0 ? "Up" : "Down",
      gapPercent,
      absGapPercent: Math.abs(gapPercent),
      gap,
    };
  }

  /**
   * Calculate rolling 60-second volatility for a token.
   */
  getVolatility(token: Token): number {
    const state = this.states.get(token)!;
    if (state.priceHistory.length < 10) return 999; // Not enough data

    const prices = state.priceHistory.map((p) => p.price);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const mid = (high + low) / 2;

    return ((high - low) / mid) * 100; // percentage
  }
}
