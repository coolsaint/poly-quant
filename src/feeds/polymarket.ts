import { EventEmitter } from "events";
import type { Token } from "../types.js";

/**
 * Polymarket CLOB API slugs for 15-minute crypto markets.
 *
 * Slug pattern: {token}-updown-15m-{window_start_unix}
 * Windows align to 15-minute boundaries in UTC.
 *
 * Resolution source: Chainlink data streams (e.g., btc-usd)
 */

const SLUG_PREFIX: Record<Token, string> = {
  BTC: "btc-updown-15m",
  ETH: "eth-updown-15m",
  SOL: "sol-updown-15m",
  XRP: "xrp-updown-15m",
};

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

interface MarketInfo {
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  slug: string;
  windowStart: number; // unix seconds
}

interface PricePoint {
  time: number;
  mid: number;
}

interface TokenMarketState {
  market: MarketInfo | null;
  upPrice: number;
  downPrice: number;
  midpoint: number; // Up midpoint
  bookDepth: number; // estimated from best bid/ask sizes
  lastFetch: number;
  lastDepthFetch: number;
  fetchError: string | null;
  // Price history for detecting lag/momentum
  priceHistory: PricePoint[]; // last 60s of midpoints
}

/**
 * Real Polymarket feed that polls CLOB API for live prices.
 *
 * For each 15-min window:
 * 1. Computes the slug from the window start timestamp
 * 2. Looks up the market via Gamma API → gets condition_id + token_ids
 * 3. Polls CLOB midpoint for real prices
 */
export class PolymarketFeed extends EventEmitter {
  private states = new Map<Token, TokenMarketState>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private marketLookupCache = new Map<string, MarketInfo>(); // slug → MarketInfo
  private currentWindowStart = 0;

  constructor(private tokens: Token[]) {
    super();
    for (const token of tokens) {
      this.states.set(token, {
        market: null,
        upPrice: 0.5,
        downPrice: 0.5,
        midpoint: 0.5,
        bookDepth: 100,
        lastFetch: 0,
        lastDepthFetch: 0,
        fetchError: null,
        priceHistory: [],
      });
    }
  }

  /**
   * Start polling Polymarket every 3 seconds.
   */
  start(): void {
    this.poll(); // immediate first poll
    this.pollInterval = setInterval(() => this.poll(), 3000);
    console.log("📡 Polymarket feed started (3s polling)");
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Get the current window start timestamp (15-min aligned, UTC).
   */
  private getWindowStart(): number {
    const now = Math.floor(Date.now() / 1000);
    return now - (now % 900); // align to 15-min boundary
  }

  /**
   * Build the event slug for a token's current window.
   */
  private getSlug(token: Token, windowStart: number): string {
    return `${SLUG_PREFIX[token]}-${windowStart}`;
  }

  /**
   * Look up market info from Gamma API by slug.
   */
  private async lookupMarket(
    token: Token,
    slug: string
  ): Promise<MarketInfo | null> {
    // Check cache first
    if (this.marketLookupCache.has(slug)) {
      return this.marketLookupCache.get(slug)!;
    }

    try {
      const url = `${GAMMA_BASE}/events/slug/${slug}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        // Market might not exist yet (created ~1 min before window starts)
        if (res.status === 404) return null;
        throw new Error(`Gamma API ${res.status}`);
      }

      const event = await res.json();
      const market = event.markets?.[0];
      if (!market?.clobTokenIds) return null;

      // clobTokenIds is a JSON string like '["tokenId1","tokenId2"]'
      // outcomes is like '["Up","Down"]'
      let tokenIds: string[];
      let outcomes: string[];
      try {
        tokenIds =
          typeof market.clobTokenIds === "string"
            ? JSON.parse(market.clobTokenIds)
            : market.clobTokenIds;
        outcomes =
          typeof market.outcomes === "string"
            ? JSON.parse(market.outcomes)
            : market.outcomes;
      } catch {
        // Fallback: tokens array from CLOB market data
        tokenIds = [market.clobTokenIds[0], market.clobTokenIds[1]];
        outcomes = ["Up", "Down"];
      }

      const upIdx = outcomes.indexOf("Up");
      const downIdx = outcomes.indexOf("Down");

      const info: MarketInfo = {
        conditionId: market.conditionId,
        upTokenId: tokenIds[upIdx] ?? tokenIds[0],
        downTokenId: tokenIds[downIdx] ?? tokenIds[1],
        slug,
        windowStart: this.currentWindowStart,
      };

      this.marketLookupCache.set(slug, info);
      this.emit("market-found", { token, slug, conditionId: info.conditionId });
      return info;
    } catch (err: any) {
      this.emit("error", {
        token,
        error: `Market lookup failed: ${err.message}`,
      });
      return null;
    }
  }

  /**
   * Fetch midpoint price from CLOB API for a token ID.
   */
  private async fetchMidpoint(tokenId: string): Promise<number | null> {
    try {
      const url = `${CLOB_BASE}/midpoint?token_id=${tokenId}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.mid ? parseFloat(data.mid) : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch order book to get depth info.
   */
  private async fetchBookDepth(tokenId: string): Promise<number> {
    try {
      const url = `${CLOB_BASE}/book?token_id=${tokenId}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return 100;
      const data = await res.json();

      // Sum up bid sizes as proxy for depth
      let totalBidSize = 0;
      for (const bid of data.bids || []) {
        totalBidSize += parseFloat(bid.size) * parseFloat(bid.price);
      }
      let totalAskSize = 0;
      for (const ask of data.asks || []) {
        totalAskSize += parseFloat(ask.size) * parseFloat(ask.price);
      }

      return Math.max(totalBidSize, totalAskSize, 50);
    } catch {
      return 100;
    }
  }

  /**
   * Main poll cycle — runs every 3 seconds.
   */
  private async poll(): Promise<void> {
    const windowStart = this.getWindowStart();
    const windowChanged = windowStart !== this.currentWindowStart;
    this.currentWindowStart = windowStart;

    // If window changed, clear market cache for old windows
    if (windowChanged) {
      this.marketLookupCache.clear();
      for (const token of this.tokens) {
        const state = this.states.get(token)!;
        state.market = null;
      }
      this.emit("window-change", { windowStart });
    }

    // Poll all tokens in parallel
    await Promise.allSettled(
      this.tokens.map((token) => this.pollToken(token, windowStart))
    );
  }

  private async pollToken(token: Token, windowStart: number): Promise<void> {
    const state = this.states.get(token)!;

    // Step 1: Ensure we have market info
    if (!state.market) {
      const slug = this.getSlug(token, windowStart);
      const market = await this.lookupMarket(token, slug);
      if (!market) {
        state.fetchError = "Market not found yet";
        return;
      }
      state.market = market;
    }

    // Step 2: Fetch midpoint price
    const midpoint = await this.fetchMidpoint(state.market.upTokenId);
    if (midpoint !== null) {
      state.midpoint = midpoint;
      state.upPrice = midpoint;
      state.downPrice = Math.round((1 - midpoint) * 100) / 100;
      state.lastFetch = Date.now();
      state.fetchError = null;

      // Track price history (keep last 90s)
      const now = Date.now();
      state.priceHistory.push({ time: now, mid: midpoint });
      const cutoff = now - 90_000;
      state.priceHistory = state.priceHistory.filter((p) => p.time > cutoff);

      this.emit("price", {
        token,
        upPrice: state.upPrice,
        downPrice: state.downPrice,
        midpoint,
      });
    }

    // Step 3: Fetch book depth less frequently (every ~15s)
    if (Date.now() - state.lastDepthFetch > 15000) {
      const depth = await this.fetchBookDepth(state.market.upTokenId);
      state.bookDepth = depth;
      state.lastDepthFetch = Date.now();
    }
  }

  // ── Public API (used by SignalEngine) ──

  /**
   * Get the real Polymarket "Up" price for this token.
   */
  getUpPrice(token: Token): number {
    return this.states.get(token)?.upPrice ?? 0.5;
  }

  /**
   * Get the real Polymarket "Down" price for this token.
   */
  getDownPrice(token: Token): number {
    return this.states.get(token)?.downPrice ?? 0.5;
  }

  /**
   * Get midpoint (average of best bid/ask for Up token).
   */
  getMidpoint(token: Token): number {
    return this.states.get(token)?.midpoint ?? 0.5;
  }

  /**
   * Get estimated order book depth in USD.
   */
  getBookDepth(token: Token): number {
    return this.states.get(token)?.bookDepth ?? 100;
  }

  /**
   * Whether we have a live market for this token in the current window.
   */
  hasMarket(token: Token): boolean {
    const state = this.states.get(token);
    return !!(state?.market && state.lastFetch > 0);
  }

  /**
   * Get the condition ID for the current market.
   */
  getConditionId(token: Token): string | null {
    return this.states.get(token)?.market?.conditionId ?? null;
  }

  /**
   * Get the Polymarket price from N seconds ago (for detecting lag).
   * Returns null if not enough history.
   */
  getPriceSecsAgo(token: Token, secsAgo: number): number | null {
    const state = this.states.get(token);
    if (!state || state.priceHistory.length < 2) return null;
    const targetTime = Date.now() - secsAgo * 1000;
    // Find the closest point to targetTime
    let closest = state.priceHistory[0];
    for (const p of state.priceHistory) {
      if (Math.abs(p.time - targetTime) < Math.abs(closest.time - targetTime)) {
        closest = p;
      }
    }
    // Only return if within 5s of target
    if (Math.abs(closest.time - targetTime) > 5000) return null;
    return closest.mid;
  }

  /**
   * Get price change over last N seconds.
   * Positive = Up price increasing (market becoming more bullish).
   */
  getPriceChange(token: Token, secsAgo: number): number | null {
    const prev = this.getPriceSecsAgo(token, secsAgo);
    if (prev === null) return null;
    const current = this.getMidpoint(token);
    return current - prev;
  }

  /**
   * Get market state for a token (for dashboard display).
   */
  getState(token: Token): TokenMarketState | undefined {
    return this.states.get(token);
  }
}
