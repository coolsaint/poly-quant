import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { BinanceFeed } from "./feeds/binance.js";
import { PolymarketFeed } from "./feeds/polymarket.js";
import { CopyWatcher } from "./feeds/copy-watcher.js";
import type { CopySignal } from "./feeds/copy-watcher.js";
import { WindowManager } from "./engine/window.js";
import { SignalEngine } from "./engine/signal.js";
import { PaperTrader } from "./paper/trader.js";
import { TOKENS } from "./types.js";
import type { Token, Signal } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001");

// ── Express App ──

const app = express();
const server = createServer(app);

// Serve dashboard static files in production
const dashboardDist = path.join(__dirname, "..", "dashboard", "dist");
app.use(express.static(dashboardDist));

// ── WebSocket Server ──

const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`WS client connected (${clients.size} total)`);

  // Send current state immediately
  ws.send(JSON.stringify({ type: "snapshot", data: getSnapshot() }));

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`WS client disconnected (${clients.size} total)`);
  });
});

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ── Engine Components ──

const binance = new BinanceFeed();
const polymarket = new PolymarketFeed(TOKENS);
const copyWatcher = new CopyWatcher(3000); // poll every 3 seconds
const windowManager = new WindowManager();
const signalEngine = new SignalEngine(windowManager, polymarket);
const paperTrader = new PaperTrader(windowManager);

let connected = false;
let previousWindowId = "";
let lastSignals = new Map<Token, Signal>();
let recentLogs: string[] = [];
let recentCopySignals: CopySignal[] = [];

function addLog(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  const entry = `[${ts}] ${msg}`;
  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs = recentLogs.slice(-200);
  broadcast({ type: "log", data: entry });
}

// ── Build Snapshot ──

function getSnapshot() {
  const window = windowManager.getCurrentWindow();
  const timeLeft = window.timeRemainingMs / 1000;

  const prices: Record<string, any> = {};
  for (const token of TOKENS) {
    const state = windowManager.getState(token);
    const gap = windowManager.getGap(token);
    const vol = windowManager.getVolatility(token);
    const polyState = polymarket.getState(token);
    prices[token] = {
      current: state.currentPrice,
      reference: state.referencePrice,
      direction: gap.direction,
      gapPercent: gap.gapPercent,
      absGapPercent: gap.absGapPercent,
      gap: gap.gap,
      volatility: vol > 100 ? null : vol,
      // Polymarket real data
      polyUpPrice: polyState?.upPrice ?? null,
      polyDownPrice: polyState?.downPrice ?? null,
      polyMidpoint: polyState?.midpoint ?? null,
      polyBookDepth: polyState?.bookDepth ?? null,
      polyHasMarket: polymarket.hasMarket(token),
      polyConditionId: polymarket.getConditionId(token),
    };
  }

  const signals: Record<string, any> = {};
  for (const [token, signal] of lastSignals) {
    signals[token] = signal;
  }

  const stats = paperTrader.getStats();
  const pending = paperTrader.getPendingTrades();
  const allTrades = paperTrader.getAllTrades().filter((t) => t.resolved).slice(-50);

  return {
    window: {
      startTime: window.windowStartTime.toISOString(),
      endTime: window.windowEndTime.toISOString(),
      timeLeftSec: timeLeft,
      timeElapsedSec: window.timeElapsedMs / 1000,
      windowId: window.windowId,
      inZone: timeLeft <= 60 && timeLeft >= 5,
    },
    prices,
    signals,
    stats,
    pending,
    recentTrades: allTrades,
    copySignals: recentCopySignals.slice(-20),
    copyTargets: copyWatcher.getTargets(),
    logs: recentLogs.slice(-50),
    connected,
  };
}

// ── API Routes ──

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", connected, uptime: process.uptime() });
});

app.get("/api/snapshot", (_req, res) => {
  res.json(getSnapshot());
});

app.get("/api/trades", (_req, res) => {
  res.json(paperTrader.getAllTrades().filter((t) => t.resolved));
});

app.get("/api/stats", (_req, res) => {
  res.json(paperTrader.getStats());
});

// SPA fallback (Express 5 wildcard syntax)
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(dashboardDist, "index.html"));
});

// ── Binance Feed ──

binance.on("connected", () => {
  connected = true;
  addLog("Binance WebSocket connected");
});

// ── Polymarket Feed ──

polymarket.on("market-found", ({ token, slug, conditionId }: any) => {
  addLog(`📡 ${token} market found: ${slug} (${conditionId.slice(0, 10)}…)`);
});

polymarket.on("price", ({ token, upPrice, downPrice }: any) => {
  // Prices are broadcast as part of the tick snapshot
});

polymarket.on("window-change", () => {
  addLog("📡 Polymarket: new window, refreshing markets…");
});

polymarket.on("error", ({ token, error }: any) => {
  // Don't spam logs — only log occasionally
});

// ── Copy Watcher ──

copyWatcher.on("copy-signal", (signal: CopySignal) => {
  const msg = `🚨 COPY: ${signal.source} → ${signal.token} ${signal.outcome} @ ${(signal.price * 100).toFixed(0)}¢ | $${signal.usdcSize.toFixed(0)} | ${signal.timeframe} window`;
  addLog(msg);

  // Store for dashboard display
  recentCopySignals.push(signal);
  if (recentCopySignals.length > 50) recentCopySignals = recentCopySignals.slice(-50);

  // Broadcast immediately to all dashboard clients
  broadcast({ type: "copy-signal", data: signal });
});

copyWatcher.on("error", ({ target, error }: any) => {
  // Don't spam — these are usually transient network issues
});

binance.on("price", ({ token, price, timestamp }) => {
  const newWindow = windowManager.updatePrice(token as Token, price, timestamp);

  if (newWindow && previousWindowId) {
    const resolved = paperTrader.resolveWindow(previousWindowId);
    if (resolved.length > 0) {
      let windowPnl = 0;
      for (const t of resolved) {
        const icon = t.won ? "WIN" : "LOSS";
        const pnlStr = (t.pnl ?? 0) >= 0 ? `+$${(t.pnl ?? 0).toFixed(2)}` : `-$${Math.abs(t.pnl ?? 0).toFixed(2)}`;
        addLog(`${icon}: ${t.token} ${t.direction} → ${pnlStr}`);
        windowPnl += t.pnl ?? 0;
      }
      addLog(`Window total: ${windowPnl >= 0 ? "+" : ""}$${windowPnl.toFixed(2)}`);
      broadcast({ type: "resolved", data: resolved });
    }
  }

  if (newWindow) {
    const window = windowManager.getCurrentWindow();
    previousWindowId = window.windowId;
    addLog(`New window: ${window.windowStartTime.toLocaleTimeString()} → ${window.windowEndTime.toLocaleTimeString()}`);
  }
});

// ── Main Loop — runs every second ──

setInterval(() => {
  if (!connected) return;

  const allHaveData = TOKENS.every((t) => windowManager.getState(t).currentPrice > 0);
  if (!allHaveData) return;

  // Generate signals
  for (const token of TOKENS) {
    const signal = signalEngine.generateSignal(token);
    lastSignals.set(token, signal);

    if (signal.shouldBet) {
      const trade = paperTrader.placeTrade(signal);
      addLog(`BET: ${trade.token} ${trade.direction} @ ${(trade.entryPrice * 100).toFixed(0)}¢ | $${trade.size.toFixed(2)}`);
      broadcast({ type: "trade", data: trade });
    }
  }

  // Broadcast state update every second
  broadcast({ type: "tick", data: getSnapshot() });
}, 1000);

// ── Start ──

server.listen(PORT, () => {
  console.log(`Poly-Quant server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
  binance.connect();
  polymarket.start();
  copyWatcher.start();
});

// ── Graceful Shutdown ──

function shutdown(): void {
  console.log("Shutting down...");
  binance.disconnect();
  polymarket.stop();
  copyWatcher.stop();
  wss.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
