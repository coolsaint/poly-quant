import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import type { PaperTrade } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "trades.db");

// Ensure data directory exists
import { mkdirSync } from "fs";
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for better concurrent read/write
db.pragma("journal_mode = WAL");

// ── Schema ──

db.exec(`
  CREATE TABLE IF NOT EXISTS paper_trades (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price REAL NOT NULL,
    size REAL NOT NULL,
    reference_price REAL NOT NULL,
    current_price_at_entry REAL NOT NULL,
    window_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    won INTEGER,
    pnl REAL,
    resolution_price REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trades_window ON paper_trades(window_id);
  CREATE INDEX IF NOT EXISTS idx_trades_token ON paper_trades(token);
  CREATE INDEX IF NOT EXISTS idx_trades_resolved ON paper_trades(resolved);
  CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON paper_trades(timestamp);

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    total_trades INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    total_pnl REAL DEFAULT 0,
    total_wagered REAL DEFAULT 0,
    peak_pnl REAL DEFAULT 0,
    max_drawdown REAL DEFAULT 0
  );
`);

// ── Prepared Statements ──

const insertTrade = db.prepare(`
  INSERT INTO paper_trades (id, token, direction, entry_price, size, reference_price, current_price_at_entry, window_id, timestamp, resolved)
  VALUES (@id, @token, @direction, @entryPrice, @size, @referencePrice, @currentPriceAtEntry, @windowId, @timestamp, 0)
`);

const resolveTrade = db.prepare(`
  UPDATE paper_trades SET resolved = 1, won = @won, pnl = @pnl, resolution_price = @resolutionPrice
  WHERE id = @id
`);

const getUnresolved = db.prepare(`
  SELECT * FROM paper_trades WHERE resolved = 0
`);

const getResolvedTrades = db.prepare(`
  SELECT * FROM paper_trades WHERE resolved = 1 ORDER BY timestamp DESC LIMIT @limit
`);

const getAllResolved = db.prepare(`
  SELECT * FROM paper_trades WHERE resolved = 1 ORDER BY timestamp ASC
`);

const getTradesByToken = db.prepare(`
  SELECT token,
    COUNT(*) as trades,
    SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END) as wins,
    COALESCE(SUM(pnl), 0) as pnl
  FROM paper_trades WHERE resolved = 1
  GROUP BY token
`);

const getOverallStats = db.prepare(`
  SELECT
    COUNT(*) as total_trades,
    COALESCE(SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END), 0) as wins,
    COALESCE(COUNT(*) - SUM(CASE WHEN won = 1 THEN 1 ELSE 0 END), 0) as losses,
    COALESCE(SUM(pnl), 0) as total_pnl,
    COALESCE(SUM(size), 0) as total_wagered
  FROM paper_trades WHERE resolved = 1
`);

// ── Public API ──

export function saveTrade(trade: PaperTrade): void {
  insertTrade.run({
    id: trade.id,
    token: trade.token,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    size: trade.size,
    referencePrice: trade.referencePrice,
    currentPriceAtEntry: trade.currentPriceAtEntry,
    windowId: trade.windowId,
    timestamp: trade.timestamp,
  });
}

export function updateTradeResolution(trade: PaperTrade): void {
  resolveTrade.run({
    id: trade.id,
    won: trade.won ? 1 : 0,
    pnl: trade.pnl,
    resolutionPrice: trade.resolutionPrice,
  });
}

export function loadUnresolvedTrades(): PaperTrade[] {
  const rows = getUnresolved.all() as any[];
  return rows.map(rowToTrade);
}

export function loadRecentTrades(limit = 50): PaperTrade[] {
  const rows = getResolvedTrades.all({ limit }) as any[];
  return rows.map(rowToTrade);
}

export function loadAllResolvedTrades(): PaperTrade[] {
  const rows = getAllResolved.all() as any[];
  return rows.map(rowToTrade);
}

export function loadStats() {
  const overall = getOverallStats.get() as any;
  const byToken = getTradesByToken.all() as any[];

  const tokenStats: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const row of byToken) {
    tokenStats[row.token] = { trades: row.trades, wins: row.wins, pnl: row.pnl };
  }

  return {
    totalTrades: overall.total_trades,
    wins: overall.wins,
    losses: overall.losses,
    totalPnl: Math.round(overall.total_pnl * 100) / 100,
    totalWagered: Math.round(overall.total_wagered * 100) / 100,
    byToken: tokenStats,
  };
}

function rowToTrade(row: any): PaperTrade {
  return {
    id: row.id,
    token: row.token,
    direction: row.direction,
    entryPrice: row.entry_price,
    size: row.size,
    referencePrice: row.reference_price,
    currentPriceAtEntry: row.current_price_at_entry,
    windowId: row.window_id,
    timestamp: row.timestamp,
    resolved: row.resolved === 1,
    won: row.won === null ? null : row.won === 1,
    pnl: row.pnl,
    resolutionPrice: row.resolution_price,
  };
}

export function closeDb(): void {
  db.close();
}
