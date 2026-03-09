import WebSocket from "ws";
import { EventEmitter } from "events";
import type { Token, PriceUpdate } from "../types.js";
import { BINANCE_PAIRS, TOKENS } from "../types.js";

/**
 * Binance WebSocket feed — connects to trade streams for all tokens.
 * Emits 'price' events with { token, price, timestamp }.
 */
export class BinanceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private prices: Map<Token, number> = new Map();

  connect(): void {
    // Combined stream for all pairs
    const streams = TOKENS.map(
      (t) => `${BINANCE_PAIRS[t]}@trade`
    ).join("/");
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    console.log("📡 Connecting to Binance WebSocket...");

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("✅ Binance WebSocket connected");
      this.emit("connected");
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        const data = msg.data;
        if (!data || !data.s || !data.p) return;

        const symbol = data.s as string; // e.g., "BTCUSDT"
        const price = parseFloat(data.p);
        const timestamp = data.T as number;

        // Map symbol back to token
        const token = this.symbolToToken(symbol);
        if (!token) return;

        this.prices.set(token, price);

        const update: PriceUpdate = { token, price, timestamp };
        this.emit("price", update);
      } catch {
        // Skip malformed messages
      }
    });

    this.ws.on("close", () => {
      console.log("⚠️  Binance WebSocket closed, reconnecting in 3s...");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      console.error("❌ Binance WebSocket error:", err.message);
      this.ws?.close();
    });
  }

  getPrice(token: Token): number {
    return this.prices.get(token) ?? 0;
  }

  private symbolToToken(symbol: string): Token | null {
    const upper = symbol.toUpperCase();
    for (const token of TOKENS) {
      if (upper === BINANCE_PAIRS[token].toUpperCase()) {
        return token;
      }
    }
    return null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
