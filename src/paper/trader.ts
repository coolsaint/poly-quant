import type { Token, Signal, PaperTrade, SessionStats } from "../types.js";
import { TOKENS } from "../types.js";
import { WindowManager } from "../engine/window.js";

/**
 * Paper trading execution and tracking.
 * Simulates placing bets and resolving them at window end.
 */
export class PaperTrader {
  private trades: PaperTrade[] = [];
  private pendingTrades: PaperTrade[] = [];
  private tradeCounter = 0;
  private peakPnl = 0;
  private maxDrawdown = 0;

  constructor(private windowManager: WindowManager) {}

  /**
   * Execute a paper trade based on signal.
   */
  placeTrade(signal: Signal): PaperTrade {
    const state = this.windowManager.getState(signal.token);
    const window = this.windowManager.getCurrentWindow();

    const trade: PaperTrade = {
      id: `PT-${++this.tradeCounter}`,
      token: signal.token,
      direction: signal.direction,
      entryPrice: signal.polymarketPrice,
      size: signal.suggestedSize,
      referencePrice: state.referencePrice,
      currentPriceAtEntry: state.currentPrice,
      windowId: window.windowId,
      timestamp: Date.now(),
      resolved: false,
      won: null,
      pnl: null,
      resolutionPrice: null,
    };

    this.pendingTrades.push(trade);
    this.trades.push(trade);
    this.windowManager.markBetPlaced(signal.token);

    return trade;
  }

  /**
   * Resolve all pending trades for the previous window.
   * Called when a new window starts.
   */
  resolveWindow(previousWindowId: string): PaperTrade[] {
    const resolved: PaperTrade[] = [];

    for (const trade of this.pendingTrades) {
      if (trade.windowId !== previousWindowId) continue;

      const state = this.windowManager.getState(trade.token);
      const resolutionPrice = state.currentPrice;

      // Determine if trade won
      const priceWentUp = resolutionPrice > trade.referencePrice;
      const priceWentDown = resolutionPrice < trade.referencePrice;

      let won: boolean;
      if (trade.direction === "Up") {
        won = priceWentUp;
      } else {
        won = priceWentDown;
      }

      // If exactly equal, it's a push — return stake (treat as loss for simplicity)
      if (resolutionPrice === trade.referencePrice) {
        won = false;
      }

      // Calculate P&L
      // If won: receive $1 per share, paid entryPrice per share
      // shares = size / entryPrice
      // P&L = shares * (1 - entryPrice) if won, -size if lost
      const shares = trade.size / trade.entryPrice;
      const pnl = won ? shares * (1 - trade.entryPrice) : -trade.size;

      trade.resolved = true;
      trade.won = won;
      trade.pnl = Math.round(pnl * 100) / 100;
      trade.resolutionPrice = resolutionPrice;

      resolved.push(trade);
    }

    // Remove resolved from pending
    this.pendingTrades = this.pendingTrades.filter((t) => !t.resolved);

    return resolved;
  }

  /**
   * Get comprehensive session statistics.
   */
  getStats(): SessionStats {
    const resolvedTrades = this.trades.filter((t) => t.resolved);

    const byToken = {} as SessionStats["byToken"];
    for (const t of TOKENS) {
      byToken[t] = { trades: 0, wins: 0, pnl: 0 };
    }

    let totalPnl = 0;
    let totalWagered = 0;
    let wins = 0;

    for (const trade of resolvedTrades) {
      totalPnl += trade.pnl ?? 0;
      totalWagered += trade.size;
      if (trade.won) wins++;

      byToken[trade.token].trades++;
      if (trade.won) byToken[trade.token].wins++;
      byToken[trade.token].pnl += trade.pnl ?? 0;
    }

    // Track peak P&L and max drawdown
    if (totalPnl > this.peakPnl) this.peakPnl = totalPnl;
    const currentDrawdown = this.peakPnl - totalPnl;
    if (currentDrawdown > this.maxDrawdown) this.maxDrawdown = currentDrawdown;

    return {
      totalTrades: resolvedTrades.length,
      wins,
      losses: resolvedTrades.length - wins,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalWagered: Math.round(totalWagered * 100) / 100,
      winRate:
        resolvedTrades.length > 0 ? wins / resolvedTrades.length : 0,
      peakPnl: Math.round(this.peakPnl * 100) / 100,
      maxDrawdown: Math.round(this.maxDrawdown * 100) / 100,
      byToken,
    };
  }

  getPendingTrades(): PaperTrade[] {
    return [...this.pendingTrades];
  }

  getAllTrades(): PaperTrade[] {
    return [...this.trades];
  }
}
