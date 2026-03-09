import type { Token, Signal } from "../types.js";
import { config } from "../config.js";
import { WindowManager } from "./window.js";
import { PolymarketFeed } from "../feeds/polymarket.js";

/**
 * Market Mispricing Signal Engine
 *
 * Strategy: Fade Polymarket when it lags Binance reality.
 *
 * Edge comes from: Binance shows a clear direction (gap > threshold)
 * but Polymarket hasn't fully priced it in yet. We buy the cheap side.
 *
 * Example: BTC up 0.3% on Binance → should be ~70¢ Up → Poly still at 55¢ → buy Up
 *
 * The confidence = how likely the direction holds (from Binance gap + time + vol).
 * The edge = confidence minus what Polymarket is charging (real CLOB price + fees).
 *
 * Always computes all values for dashboard display.
 */
export class SignalEngine {
  constructor(
    private windowManager: WindowManager,
    private polymarket: PolymarketFeed
  ) {}

  generateSignal(token: Token): Signal {
    const window = this.windowManager.getCurrentWindow();
    const timeLeftSec = window.timeRemainingMs / 1000;
    const state = this.windowManager.getState(token);

    const base: Signal = {
      shouldBet: false,
      token,
      direction: "Up",
      confidence: 0,
      polymarketPrice: 0,
      edge: 0,
      suggestedSize: 0,
      reason: "",
      gapPercent: 0,
      volatility: 0,
      timeLeftSec,
    };

    if (state.referencePrice === 0 || state.currentPrice === 0) {
      return { ...base, reason: `⏳ Waiting for ${token} price data` };
    }

    if (!this.polymarket.hasMarket(token)) {
      return { ...base, reason: `⏳ Waiting for ${token} Polymarket data` };
    }

    // ── Always compute all values ──

    const { direction, gapPercent, absGapPercent, gap } =
      this.windowManager.getGap(token);

    const vol = this.windowManager.getVolatility(token);
    const volSafe = vol > 100 ? 0 : vol;

    // ── Confidence: how likely is the current Binance direction correct? ──
    //
    // This is our "true probability" estimate. Key inputs:
    // 1. Gap size — bigger gap = more likely to hold
    // 2. Time left — less time = direction more locked in
    // 3. Volatility — low vol = more stable, direction more reliable
    // 4. Gap momentum — if gap has been consistent, more confident

    // Base from gap: 0% → 50%, 0.10% → 60%, 0.20% → 70%, 0.40% → 83%, 0.60%+ → 90%
    let confidence = 0.5 + (absGapPercent / 0.6) * 0.4;
    confidence = Math.min(0.95, Math.max(0.5, confidence));

    // Time boost: with <60s left, direction is very sticky
    // At 90s: ×0.97, at 60s: ×0.98, at 30s: ×0.99, at 10s: ×1.0
    const timeBoost = 1 - Math.max(0, (timeLeftSec - 10) / 900) * 0.04;
    confidence *= timeBoost;

    // Vol penalty: high vol = direction could reverse
    const volRatio = volSafe / config.maxVolatility;
    const volFactor = Math.max(0.80, 1 - volRatio * 0.15);
    confidence *= volFactor;

    // ── Polymarket price (what the market charges) ──

    const upMid = this.polymarket.getMidpoint(token);
    // Price for the direction we'd bet on
    const polyPrice = direction === "Up" ? upMid : 1 - upMid;

    // ── Mispricing detection ──
    //
    // "Fair value" from our model vs what Polymarket charges.
    // If Polymarket is cheap relative to our confidence → edge exists.
    //
    // But also check: is Polymarket MOVING toward fair value?
    // If it's already caught up, the edge is gone.

    const polyChange30s = this.polymarket.getPriceChange(token, 30);
    const polyMovingTowardUs =
      polyChange30s !== null &&
      ((direction === "Up" && polyChange30s > 0.02) ||
        (direction === "Down" && polyChange30s < -0.02));

    // Slight confidence boost if Polymarket is trending our way (confirmation)
    if (polyMovingTowardUs) {
      confidence = Math.min(0.95, confidence * 1.03);
    }

    // ── Edge calculation ──

    const takerFee =
      config.takerFeeRate * Math.min(polyPrice, 1 - polyPrice) * 2;
    const effectivePrice = polyPrice + takerFee;
    const edge = confidence - effectivePrice;

    // Populate base
    base.direction = direction;
    base.gapPercent = gapPercent;
    base.volatility = volSafe;
    base.confidence = confidence;
    base.polymarketPrice = polyPrice;
    base.edge = edge;

    // ── Already bet this window? ──
    if (this.windowManager.hasBetThisWindow(token)) {
      return { ...base, reason: `⏸️  Already bet ${token} this window` };
    }

    // ── Gate 1: Time — only last 90s ──
    if (timeLeftSec > config.maxTimeLeftSec) {
      return {
        ...base,
        reason: `⏰ ${timeLeftSec.toFixed(0)}s left — waiting for last ${config.maxTimeLeftSec}s`,
      };
    }
    if (timeLeftSec < config.minTimeLeftSec) {
      return {
        ...base,
        reason: `⏰ ${timeLeftSec.toFixed(0)}s left — too late`,
      };
    }

    // ── Gate 2: Price Gap (Binance direction must be clear) ──
    if (absGapPercent < config.minGapPercent) {
      return {
        ...base,
        reason: `📏 ${token} gap ${absGapPercent.toFixed(3)}% — need ${config.minGapPercent}%`,
      };
    }

    // ── Gate 3: Volatility ──
    if (vol > config.maxVolatility) {
      return {
        ...base,
        reason: `🌊 ${token} vol ${vol.toFixed(4)}% — max ${config.maxVolatility}%`,
      };
    }

    // ── Gate 4: Polymarket must be cheap (the actual edge) ──
    // If Polymarket already prices it at >75¢, the edge is gone
    if (polyPrice > 0.75) {
      return {
        ...base,
        reason: `💸 ${token} Poly already ${(polyPrice * 100).toFixed(0)}¢ — too expensive`,
      };
    }

    // ── Gate 5: Minimum edge after fees ──
    if (edge < config.minEdge) {
      return {
        ...base,
        reason: `📊 ${token} edge ${(edge * 100).toFixed(1)}% (conf ${(confidence * 100).toFixed(0)}% vs poly ${(polyPrice * 100).toFixed(0)}¢+fee) — need ${config.minEdge * 100}%`,
      };
    }

    // ── ALL GATES PASSED — size the bet ──

    const b = 1 / effectivePrice - 1;
    const kellyFraction = (b * confidence - (1 - confidence)) / b;
    const quarterKelly = kellyFraction * config.kellyFraction * config.bankroll;
    const bookDepth = this.polymarket.getBookDepth(token);
    const suggestedSize = Math.min(
      quarterKelly,
      config.maxBetPerToken,
      bookDepth * 0.8
    );

    if (suggestedSize < 1) {
      return {
        ...base,
        reason: `💰 ${token} size too small ($${suggestedSize.toFixed(2)})`,
      };
    }

    return {
      ...base,
      shouldBet: true,
      suggestedSize: Math.round(suggestedSize * 100) / 100,
      reason: `✅ ${token} ${direction} | Gap ${absGapPercent.toFixed(2)}% | Conf ${(confidence * 100).toFixed(0)}% | Poly ${(polyPrice * 100).toFixed(0)}¢ | Edge ${(edge * 100).toFixed(1)}% | $${suggestedSize.toFixed(0)}`,
    };
  }
}
