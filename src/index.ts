import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { CopyWatcher } from "./feeds/copy-watcher.js";
import type { CopySignal } from "./feeds/copy-watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001");

// ── Express App ──

const app = express();
const server = createServer(app);

const dashboardDist = path.join(__dirname, "..", "dashboard", "dist");
app.use(express.static(dashboardDist));

// ── WebSocket Server ──

const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`WS client connected (${clients.size} total)`);
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

// ── Copy Watcher ──

const copyWatcher = new CopyWatcher(3000);

let recentCopySignals: CopySignal[] = [];

copyWatcher.on("copy-signal", (signal: CopySignal) => {
  console.log(
    `🚨 COPY: ${signal.source} → ${signal.token} ${signal.outcome} @ ${(signal.price * 100).toFixed(0)}¢ | $${signal.usdcSize.toFixed(0)} | ${signal.timeframe}`
  );

  recentCopySignals.push(signal);
  if (recentCopySignals.length > 50) recentCopySignals = recentCopySignals.slice(-50);

  broadcast({ type: "copy-signal", data: signal });
  broadcast({ type: "snapshot", data: getSnapshot() });
});

copyWatcher.on("profiles-updated", () => {
  broadcast({ type: "snapshot", data: getSnapshot() });
});

// ── Snapshot ──

function getSnapshot() {
  return {
    profiles: copyWatcher.getProfiles(),
    copySignals: recentCopySignals.slice(-20),
    connected: true,
  };
}

// ── API Routes ──

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

app.get("/api/snapshot", (_req, res) => {
  res.json(getSnapshot());
});

// SPA fallback
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(dashboardDist, "index.html"));
});

// ── Start ──

server.listen(PORT, () => {
  console.log(`Poly-Quant Copy Bot running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  copyWatcher.start();
});

// ── Graceful Shutdown ──

function shutdown(): void {
  console.log("Shutting down...");
  copyWatcher.stop();
  wss.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
