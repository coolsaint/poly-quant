import type { Token, Signal } from "../types.js";
import { config } from "../config.js";
import { WindowManager } from "./window.js";
import { PolymarketSimulator } from "../feeds/polymarket.js";

/**
 * 5-Gate Signal Engine
 *
 * Gate 1: Time — must be in last 60 seconds of window
 * Gate 2: Price Gap — must be >= 0.15% from reference
 * Gate 3: Volatility — must be <= 0.03% (60s rolling)
 * Gate 4: Confidence — must be >= 85%
 * Gate 5: Edge — must be >= 10% after fees
 */
export class SignalEngine {
  constructor(
    private windowManager: WindowManager,
    private polymarket: PolymarketSimulator
  ) {}

  generateSignal(token: Token): Signal {
    const NO_BET: Signal = {
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
      timeLeftSec: 0,
    };

    const window = this.windowManager.getCurrentWindow();
    const timeLeftSec = window.timeRemainingMs / 1000;

    // Already bet this window?
    if (this.windowManager.hasBetThisWindow(token)) {
      return {
        ...NO_BET,
        timeLeftSec,
        reason: `⏸️  Already bet ${token} this window`,
      };
    }

    // Reference price set?
    const state = this.windowManager.getState(token);
    if (state.referencePrice === 0 || state.currentPrice === 0) {
      return {
        ...NO_BET,
        timeLeftSec,
        reason: `⏳ Waiting for ${token} price data`,
      };
    }

    // ═══════════════════════════════════════
    // GATE 1: Time — must be in last 60 seconds
    // ═══════════════════════════════════════
    if (timeLeftSec > config.maxTimeLeftSec) {
      return {
        ...NO_BET,
        timeLeftSec,
        reason: `⏰ ${timeLeftSec.toFixed(0)}s left — waiting for last ${config.maxTimeLeftSec}s`,
      };
    }

    if (timeLeftSec < config.minTimeLeftSec) {
      return {
        ...NO_BET,
        timeLeftSec,
        reason: `⏰ ${timeLeftSec.toFixed(0)}s left — too late, slippage risk`,
      };
    }

    // ═══════════════════════════════════════
    // GATE 2: Price Gap — must be >= 0.15%
    // ═══════════════════════════════════════
    const { direction, gapPercent, absGapPercent, gap } =
      this.windowManager.getGap(token);

    if (absGapPercent < config.minGapPercent) {
      return {
        ...NO_BET,
        timeLeftSec,
        gapPercent,
        reason: `📏 ${token} gap ${absGapPercent.toFixed(3)}% ($${gap.toFixed(2)}) — need ${config.minGapPercent}%`,
      };
    }

    // ═══════════════════════════════════════
    // GATE 3: Volatility — must be <= 0.03%
    // ═══════════════════════════════════════
    const vol = this.windowManager.getVolatility(token);

    if (vol > config.maxVolatility) {
      return {
        ...NO_BET,
        timeLeftSec,
        gapPercent,
        volatility: vol,
        reason: `🌊 ${token} vol ${vol.toFixed(4)}% — max ${config.maxVolatility}%`,
      };
    }

    // ═══════════════════════════════════════
    // GATE 4: Confidence — must be >= 85%
    // ═══════════════════════════════════════

    // Base confidence from gap size (logistic curve)
    // 0.15% gap → ~70%, 0.30% gap → ~85%, 0.50% gap → ~93%
    let confidence = 0.5 + (absGapPercent / 0.6) * 0.4;
    confidence = Math.min(0.95, Math.max(0.5, confidence));

    // Time factor — less time = more confident (price more locked in)
    const timeFactor = 1 - (timeLeftSec / 300) * 0.2;
    confidence *= timeFactor;

    // Volatility factor — calmer = more confident
    const volFactor = Math.max(0.6, 1 - vol * 15);
    confidence *= volFactor;

    if (confidence < config.minConfidence) {
      return {
        ...NO_BET,
        timeLeftSec,
        gapPercent,
        volatility: vol,
        confidence,
        reason: `🎯 ${token} conf ${(confidence * 100).toFixed(1)}% — need ${config.minConfidence * 100}%`,
      };
    }

    // ═══════════════════════════════════════
    // GATE 5: Edge — must be >= 10% after fees
    // ═══════════════════════════════════════

    // Get simulated Polymarket price
    const simUpPrice = this.polymarket.getSimulatedUpPrice(
      gapPercent,
      timeLeftSec
    );
    const polyPrice = direction === "Up" ? simUpPrice : 1 - simUpPrice;

    // Calculate effective price with taker fee
    const takerFee =
      config.takerFeeRate * Math.min(polyPrice, 1 - polyPrice) * 2;
    const effectivePrice = polyPrice + takerFee;

    const edge = confidence - effectivePrice;

    if (edge < config.minEdge) {
      return {
        ...NO_BET,
        timeLeftSec,
        gapPercent,
        volatility: vol,
        confidence,
        polymarketPrice: polyPrice,
        edge,
        reason: `📊 ${token} edge ${(edge * 100).toFixed(1)}% (conf ${(confidence * 100).toFixed(0)}% vs ${(polyPrice * 100).toFixed(0)}¢+fee) — need ${config.minEdge * 100}%`,
      };
    }

    // ═══════════════════════════════════════
    // ALL GATES PASSED — Calculate bet size
    // ═══════════════════════════════════════

    // Quarter Kelly
    const b = 1 / effectivePrice - 1;
    const kellyFraction = (b * confidence - (1 - confidence)) / b;
    const quarterKelly = kellyFraction * config.kellyFraction * config.bankroll;

    // Book depth
    const bookDepth = this.polymarket.getSimulatedBookDepth(token);

    // Cap at max bet, book depth, and available bankroll
    const suggestedSize = Math.min(
      quarterKelly,
      config.maxBetPerToken,
      bookDepth * 0.8
    );

    if (suggestedSize < 1) {
      return {
        ...NO_BET,
        timeLeftSec,
        gapPercent,
        volatility: vol,
        confidence,
        polymarketPrice: polyPrice,
        edge,
        reason: `💰 ${token} size too small ($${suggestedSize.toFixed(2)})`,
      };
    }

    return {
      shouldBet: true,
      token,
      direction,
      confidence,
      polymarketPrice: polyPrice,
      edge,
      suggestedSize: Math.round(suggestedSize * 100) / 100,
      reason: `✅ ${token} ${direction} | Gap ${absGapPercent.toFixed(2)}% | Conf ${(confidence * 100).toFixed(0)}% | Price ${(polyPrice * 100).toFixed(0)}¢ | Edge ${(edge * 100).toFixed(0)}% | Size $${suggestedSize.toFixed(0)}`,
      gapPercent,
      volatility: vol,
      timeLeftSec,
    };
  }
}
