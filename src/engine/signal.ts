import type { Token, Signal } from "../types.js";
import { config } from "../config.js";
import { WindowManager } from "./window.js";
import { PolymarketSimulator } from "../feeds/polymarket.js";

/**
 * 5-Gate Signal Engine
 *
 * Always computes all values so the dashboard can display real-time
 * gate status. Only `shouldBet` is gated by the 5 thresholds.
 */
export class SignalEngine {
  constructor(
    private windowManager: WindowManager,
    private polymarket: PolymarketSimulator
  ) {}

  generateSignal(token: Token): Signal {
    const window = this.windowManager.getCurrentWindow();
    const timeLeftSec = window.timeRemainingMs / 1000;
    const state = this.windowManager.getState(token);

    // Base signal with defaults
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

    // No price data yet
    if (state.referencePrice === 0 || state.currentPrice === 0) {
      return { ...base, reason: `⏳ Waiting for ${token} price data` };
    }

    // ── Always compute all values ──

    const { direction, gapPercent, absGapPercent, gap } =
      this.windowManager.getGap(token);

    const vol = this.windowManager.getVolatility(token);
    const volSafe = vol > 100 ? 0 : vol;

    // Confidence (computed regardless of gates)
    let confidence = 0.5 + (absGapPercent / 0.6) * 0.4;
    confidence = Math.min(0.95, Math.max(0.5, confidence));
    const timeFactor = 1 - (timeLeftSec / 300) * 0.2;
    confidence *= timeFactor;
    const volFactor = Math.max(0.6, 1 - volSafe * 15);
    confidence *= volFactor;

    // Polymarket simulated price & edge
    const simUpPrice = this.polymarket.getSimulatedUpPrice(gapPercent, timeLeftSec);
    const polyPrice = direction === "Up" ? simUpPrice : 1 - simUpPrice;
    const takerFee = config.takerFeeRate * Math.min(polyPrice, 1 - polyPrice) * 2;
    const effectivePrice = polyPrice + takerFee;
    const edge = confidence - effectivePrice;

    // Populate all values
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

    // ── Gate 1: Time ──
    if (timeLeftSec > config.maxTimeLeftSec) {
      return {
        ...base,
        reason: `⏰ ${timeLeftSec.toFixed(0)}s left — waiting for last ${config.maxTimeLeftSec}s`,
      };
    }
    if (timeLeftSec < config.minTimeLeftSec) {
      return {
        ...base,
        reason: `⏰ ${timeLeftSec.toFixed(0)}s left — too late, slippage risk`,
      };
    }

    // ── Gate 2: Price Gap ──
    if (absGapPercent < config.minGapPercent) {
      return {
        ...base,
        reason: `📏 ${token} gap ${absGapPercent.toFixed(3)}% ($${gap.toFixed(2)}) — need ${config.minGapPercent}%`,
      };
    }

    // ── Gate 3: Volatility ──
    if (vol > config.maxVolatility) {
      return {
        ...base,
        reason: `🌊 ${token} vol ${vol.toFixed(4)}% — max ${config.maxVolatility}%`,
      };
    }

    // ── Gate 4: Confidence ──
    if (confidence < config.minConfidence) {
      return {
        ...base,
        reason: `🎯 ${token} conf ${(confidence * 100).toFixed(1)}% — need ${config.minConfidence * 100}%`,
      };
    }

    // ── Gate 5: Edge ──
    if (edge < config.minEdge) {
      return {
        ...base,
        reason: `📊 ${token} edge ${(edge * 100).toFixed(1)}% (conf ${(confidence * 100).toFixed(0)}% vs ${(polyPrice * 100).toFixed(0)}¢+fee) — need ${config.minEdge * 100}%`,
      };
    }

    // ── ALL GATES PASSED ──

    const b = 1 / effectivePrice - 1;
    const kellyFraction = (b * confidence - (1 - confidence)) / b;
    const quarterKelly = kellyFraction * config.kellyFraction * config.bankroll;
    const bookDepth = this.polymarket.getSimulatedBookDepth(token);
    const suggestedSize = Math.min(quarterKelly, config.maxBetPerToken, bookDepth * 0.8);

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
      reason: `✅ ${token} ${direction} | Gap ${absGapPercent.toFixed(2)}% | Conf ${(confidence * 100).toFixed(0)}% | Price ${(polyPrice * 100).toFixed(0)}¢ | Edge ${(edge * 100).toFixed(0)}% | Size $${suggestedSize.toFixed(0)}`,
    };
  }
}
