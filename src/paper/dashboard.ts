import type { Token, Signal, PaperTrade, SessionStats, WindowInfo } from "../types.js";
import { TOKENS } from "../types.js";
import { WindowManager } from "../engine/window.js";

/**
 * Terminal dashboard for the paper trading simulator.
 */
export class Dashboard {
  private lastSignals: Map<Token, Signal> = new Map();
  private lastWindowId = "";

  constructor(private windowManager: WindowManager) {}

  /**
   * Clear screen and redraw.
   */
  render(
    signals: Map<Token, Signal>,
    stats: SessionStats,
    pending: PaperTrade[]
  ): void {
    const window = this.windowManager.getCurrentWindow();
    const timeLeft = window.timeRemainingMs / 1000;

    // Only redraw every second (avoid flicker)
    process.stdout.write("\x1B[2J\x1B[H"); // Clear screen

    this.renderHeader(window, timeLeft);
    this.renderPrices();
    this.renderSignals(signals, timeLeft);
    this.renderPending(pending);
    this.renderStats(stats);
  }

  private renderHeader(window: WindowInfo, timeLeft: number): void {
    const now = new Date();
    const windowEnd = window.windowEndTime;

    // Time bar
    const totalSec = 15 * 60;
    const elapsed = totalSec - timeLeft;
    const pct = elapsed / totalSec;
    const barWidth = 40;
    const filled = Math.round(pct * barWidth);
    const bar =
      "█".repeat(filled) + "░".repeat(barWidth - filled);

    const inZone = timeLeft <= 60 && timeLeft >= 5;
    const zoneIndicator = inZone ? " 🟢 ACTIVE ZONE" : timeLeft < 5 ? " 🔴 TOO LATE" : "";

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log(`║  POLY-QUANT Paper Trader          ${now.toLocaleTimeString()}          ║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(
      `║  Window: ${window.windowStartTime.toLocaleTimeString()} → ${windowEnd.toLocaleTimeString()}    ⏱️  ${timeLeft.toFixed(0)}s left${zoneIndicator}`
    );
    console.log(`║  [${bar}]  ${(pct * 100).toFixed(0)}%`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
  }

  private renderPrices(): void {
    const parts: string[] = [];
    for (const token of TOKENS) {
      const state = this.windowManager.getState(token);
      if (state.currentPrice === 0) {
        parts.push(`${token}: waiting...`);
        continue;
      }
      const { direction, absGapPercent, gap } =
        this.windowManager.getGap(token);
      const arrow = direction === "Up" ? "▲" : "▼";
      const color = direction === "Up" ? "\x1b[32m" : "\x1b[31m";
      const reset = "\x1b[0m";

      const priceStr =
        token === "BTC"
          ? `$${state.currentPrice.toFixed(0)}`
          : token === "ETH"
            ? `$${state.currentPrice.toFixed(1)}`
            : `$${state.currentPrice.toFixed(4)}`;

      parts.push(
        `${token} ${priceStr} ${color}${arrow}${absGapPercent.toFixed(3)}%${reset} (ref ${
          token === "BTC"
            ? `$${state.referencePrice.toFixed(0)}`
            : token === "ETH"
              ? `$${state.referencePrice.toFixed(1)}`
              : `$${state.referencePrice.toFixed(4)}`
        })`
      );
    }
    console.log(`║  ${parts.join("  |  ")}`);

    // Volatility line
    const vols: string[] = [];
    for (const token of TOKENS) {
      const vol = this.windowManager.getVolatility(token);
      const volStr = vol > 100 ? "n/a" : `${vol.toFixed(4)}%`;
      const ok = vol <= 0.03 ? "✅" : vol <= 0.05 ? "⚠️" : "❌";
      vols.push(`${token}:${volStr}${ok}`);
    }
    console.log(`║  Vol: ${vols.join("  ")}`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
  }

  private renderSignals(signals: Map<Token, Signal>, timeLeft: number): void {
    console.log("║  SIGNALS:");

    for (const token of TOKENS) {
      const signal = signals.get(token);
      if (!signal) {
        console.log(`║    ${token}: No data`);
        continue;
      }
      console.log(`║    ${signal.reason}`);
    }
    console.log("╠══════════════════════════════════════════════════════════════╣");
  }

  private renderPending(pending: PaperTrade[]): void {
    if (pending.length === 0) {
      console.log("║  PENDING: none");
    } else {
      console.log("║  PENDING BETS:");
      for (const t of pending) {
        console.log(
          `║    ${t.id} ${t.token} ${t.direction} @ ${(t.entryPrice * 100).toFixed(0)}¢ | $${t.size.toFixed(2)} | Ref $${t.referencePrice.toFixed(2)}`
        );
      }
    }
    console.log("╠══════════════════════════════════════════════════════════════╣");
  }

  private renderStats(stats: SessionStats): void {
    const winRatePct = (stats.winRate * 100).toFixed(1);
    const pnlColor =
      stats.totalPnl >= 0 ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";

    console.log("║  SESSION STATS:");
    console.log(
      `║    Trades: ${stats.totalTrades} | W/L: ${stats.wins}/${stats.losses} | Win Rate: ${winRatePct}%`
    );
    console.log(
      `║    P&L: ${pnlColor}$${stats.totalPnl.toFixed(2)}${reset} | Wagered: $${stats.totalWagered.toFixed(2)} | Peak: $${stats.peakPnl.toFixed(2)} | Drawdown: $${stats.maxDrawdown.toFixed(2)}`
    );

    // Per-token breakdown
    const tokenParts: string[] = [];
    for (const token of TOKENS) {
      const ts = stats.byToken[token];
      if (ts.trades === 0) continue;
      const wr =
        ts.trades > 0
          ? ((ts.wins / ts.trades) * 100).toFixed(0)
          : "0";
      tokenParts.push(`${token}: ${ts.wins}/${ts.trades} (${wr}%) $${ts.pnl.toFixed(2)}`);
    }
    if (tokenParts.length > 0) {
      console.log(`║    ${tokenParts.join(" | ")}`);
    }

    console.log("╚══════════════════════════════════════════════════════════════╝");
  }

  /**
   * Log a trade execution.
   */
  logTrade(trade: PaperTrade): void {
    console.log(
      `\n📝 PAPER: Bought ${trade.token} ${trade.direction} @ ${(trade.entryPrice * 100).toFixed(0)}¢ | Size: $${trade.size.toFixed(2)} | ${trade.id}`
    );
  }

  /**
   * Log trade resolutions.
   */
  logResolutions(resolved: PaperTrade[]): void {
    if (resolved.length === 0) return;

    console.log("\n────── WINDOW RESOLVED ──────");
    let windowPnl = 0;
    for (const t of resolved) {
      const icon = t.won ? "✅" : "❌";
      const pnlStr =
        (t.pnl ?? 0) >= 0
          ? `+$${(t.pnl ?? 0).toFixed(2)}`
          : `-$${Math.abs(t.pnl ?? 0).toFixed(2)}`;
      console.log(
        `${icon} ${t.token} ${t.direction} → ${t.won ? "WIN" : "LOSS"} → ${pnlStr} (ref $${t.referencePrice.toFixed(2)} → $${(t.resolutionPrice ?? 0).toFixed(2)})`
      );
      windowPnl += t.pnl ?? 0;
    }
    console.log(
      `📊 Window total: ${windowPnl >= 0 ? "+" : ""}$${windowPnl.toFixed(2)}`
    );
    console.log("──────────────────────────────\n");
  }
}
