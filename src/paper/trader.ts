import type { Token, Signal, PaperTrade, SessionStats } from "../types.js";
import { TOKENS } from "../types.js";
import { WindowManager } from "../engine/window.js";
import {
  saveTrade,
  updateTradeResolution,
  loadUnresolvedTrades,
  loadRecentTrades,
  loadAllResolvedTrades,
  loadStats,
} from "../db.js";

/**
 * Paper trading execution and tracking.
 * All trades persisted to SQLite — survives restarts.
 */
export class PaperTrader {
  private pendingTrades: PaperTrade[] = [];
  private tradeCounter = 0;
  private peakPnl = 0;
  private maxDrawdown = 0;

  constructor(private windowManager: WindowManager) {
    this.restore();
  }

  /**
   * Restore unresolved trades and stats from DB on startup.
   */
  private restore(): void {
    // Restore pending trades from previous session
    const unresolved = loadUnresolvedTrades();
    this.pendingTrades = unresolved;

    // Set trade counter from DB
    const dbStats = loadStats();
    const pendingCount = unresolved.length;
    this.tradeCounter = dbStats.totalTrades + pendingCount;

    // Recalculate peak/drawdown from all historical trades
    const allTrades = loadAllResolvedTrades();
    let runningPnl = 0;
    for (const trade of allTrades) {
      runningPnl += trade.pnl ?? 0;
      if (runningPnl > this.peakPnl) this.peakPnl = runningPnl;
      const dd = this.peakPnl - runningPnl;
      if (dd > this.maxDrawdown) this.maxDrawdown = dd;
    }

    if (this.tradeCounter > 0) {
      console.log(
        `📂 Restored ${dbStats.totalTrades} resolved trades, ${pendingCount} pending | P&L: $${dbStats.totalPnl.toFixed(2)}`
      );
    }
  }

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
    this.windowManager.markBetPlaced(signal.token);

    // Persist to SQLite
    saveTrade(trade);

    return trade;
  }

  /**
   * Resolve all pending trades for the previous window.
   */
  resolveWindow(previousWindowId: string): PaperTrade[] {
    const resolved: PaperTrade[] = [];

    for (const trade of this.pendingTrades) {
      if (trade.windowId !== previousWindowId) continue;

      const state = this.windowManager.getState(trade.token);
      const resolutionPrice = state.currentPrice;

      const priceWentUp = resolutionPrice > trade.referencePrice;
      const priceWentDown = resolutionPrice < trade.referencePrice;

      let won: boolean;
      if (trade.direction === "Up") {
        won = priceWentUp;
      } else {
        won = priceWentDown;
      }

      if (resolutionPrice === trade.referencePrice) {
        won = false;
      }

      const shares = trade.size / trade.entryPrice;
      const pnl = won ? shares * (1 - trade.entryPrice) : -trade.size;

      trade.resolved = true;
      trade.won = won;
      trade.pnl = Math.round(pnl * 100) / 100;
      trade.resolutionPrice = resolutionPrice;

      // Persist resolution to SQLite
      updateTradeResolution(trade);

      resolved.push(trade);
    }

    this.pendingTrades = this.pendingTrades.filter((t) => !t.resolved);
    return resolved;
  }

  /**
   * Get comprehensive session statistics (from DB).
   */
  getStats(): SessionStats {
    const dbStats = loadStats();

    const byToken = {} as SessionStats["byToken"];
    for (const t of TOKENS) {
      byToken[t] = dbStats.byToken[t] || { trades: 0, wins: 0, pnl: 0 };
    }

    // Update peak/drawdown
    if (dbStats.totalPnl > this.peakPnl) this.peakPnl = dbStats.totalPnl;
    const currentDrawdown = this.peakPnl - dbStats.totalPnl;
    if (currentDrawdown > this.maxDrawdown) this.maxDrawdown = currentDrawdown;

    return {
      totalTrades: dbStats.totalTrades,
      wins: dbStats.wins,
      losses: dbStats.losses,
      totalPnl: dbStats.totalPnl,
      totalWagered: dbStats.totalWagered,
      winRate: dbStats.totalTrades > 0 ? dbStats.wins / dbStats.totalTrades : 0,
      peakPnl: Math.round(this.peakPnl * 100) / 100,
      maxDrawdown: Math.round(this.maxDrawdown * 100) / 100,
      byToken,
    };
  }

  getPendingTrades(): PaperTrade[] {
    return [...this.pendingTrades];
  }

  getAllTrades(): PaperTrade[] {
    return loadRecentTrades(50);
  }
}
