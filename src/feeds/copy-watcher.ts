import { EventEmitter } from "events";

/**
 * Copy-Trading Watcher
 *
 * Monitors target wallets on Polymarket. Detects new crypto up/down
 * BUY trades and emits copy-signal events. Also fetches each trader's
 * recent closed positions for display.
 */

interface WatchTarget {
  name: string;
  address: string;
}

export interface CopySignal {
  source: string;
  sourceAddress: string;
  market: string;
  slug: string;
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  asset: string;
  price: number;
  size: number;
  usdcSize: number;
  timestamp: number;
  token: string;
  timeframe: string;
}

export interface ClosedPosition {
  market: string;
  slug: string;
  outcome: string;
  avgPrice: number;
  size: number;
  totalTraded: number;
  amountWon: number;
  pnl: number;
  won: boolean;
}

export interface TraderProfile {
  name: string;
  address: string;
  pnl: number | null;
  positionsValue: number | null;
  recentClosed: ClosedPosition[];
  lastFetch: number;
}

const DATA_API = "https://data-api.polymarket.com";

const TARGETS: WatchTarget[] = [
  {
    name: "cryptoaus",
    address: "0x89c630ef6f8f25faf6a71d590f161d2de4086f63",
  },
  {
    name: "solidtaken",
    address: "0x2c892a47f462dd409a5920d7ba9b042ec53298c3",
  },
];

const CRYPTO_SLUG_PATTERNS = [
  "btc-updown-",
  "eth-updown-",
  "sol-updown-",
  "xrp-updown-",
];

function extractTokenFromSlug(slug: string): string | null {
  if (slug.startsWith("btc-")) return "BTC";
  if (slug.startsWith("eth-")) return "ETH";
  if (slug.startsWith("sol-")) return "SOL";
  if (slug.startsWith("xrp-")) return "XRP";
  return null;
}

function extractTimeframeFromSlug(slug: string): string {
  if (slug.includes("-4h-")) return "4h";
  if (slug.includes("-15m-")) return "15m";
  if (slug.includes("-5m-")) return "5m";
  if (slug.includes("-1h-")) return "1h";
  return "unknown";
}

function isCryptoUpDown(slug: string): boolean {
  return CRYPTO_SLUG_PATTERNS.some((p) => slug.startsWith(p));
}

interface RawActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  name: string;
}

interface RawClosedPosition {
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
}

export class CopyWatcher extends EventEmitter {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private profileInterval: ReturnType<typeof setInterval> | null = null;
  private lastSeenTimestamp = new Map<string, number>();
  private seenTxHashes = new Set<string>();
  private pollFrequencyMs: number;
  private profiles = new Map<string, TraderProfile>();

  constructor(pollFrequencyMs = 3000) {
    super();
    this.pollFrequencyMs = pollFrequencyMs;

    const now = Math.floor(Date.now() / 1000);
    for (const target of TARGETS) {
      this.lastSeenTimestamp.set(target.address, now);
      this.profiles.set(target.address, {
        name: target.name,
        address: target.address,
        pnl: null,
        positionsValue: null,
        recentClosed: [],
        lastFetch: 0,
      });
    }
  }

  start(): void {
    console.log(
      `👀 Copy-watcher started — polling ${TARGETS.length} traders every ${this.pollFrequencyMs / 1000}s`
    );
    for (const t of TARGETS) {
      console.log(`   📎 ${t.name}: ${t.address}`);
    }

    this.poll();
    this.pollInterval = setInterval(() => this.poll(), this.pollFrequencyMs);

    // Fetch profiles immediately, then every 60s
    this.fetchAllProfiles();
    this.profileInterval = setInterval(() => this.fetchAllProfiles(), 60000);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.profileInterval) {
      clearInterval(this.profileInterval);
      this.profileInterval = null;
    }
    console.log("👀 Copy-watcher stopped");
  }

  addTarget(name: string, address: string): void {
    if (TARGETS.find((t) => t.address === address)) return;
    TARGETS.push({ name, address });
    this.lastSeenTimestamp.set(address, Math.floor(Date.now() / 1000));
    this.profiles.set(address, {
      name,
      address,
      pnl: null,
      positionsValue: null,
      recentClosed: [],
      lastFetch: 0,
    });
    this.fetchProfile({ name, address });
    console.log(`👀 Now watching: ${name} (${address})`);
  }

  getTargets(): WatchTarget[] {
    return [...TARGETS];
  }

  getProfiles(): TraderProfile[] {
    return TARGETS.map(
      (t) =>
        this.profiles.get(t.address) ?? {
          name: t.name,
          address: t.address,
          pnl: null,
          positionsValue: null,
          recentClosed: [],
          lastFetch: 0,
        }
    );
  }

  // ── Activity polling (new trade detection) ──

  private async poll(): Promise<void> {
    await Promise.allSettled(
      TARGETS.map((target) => this.pollTarget(target))
    );
  }

  private async pollTarget(target: WatchTarget): Promise<void> {
    try {
      const url = `${DATA_API}/activity?user=${target.address}&limit=5`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      });

      if (!res.ok) return;

      const activities: RawActivity[] = await res.json();

      for (const activity of activities) {
        if (this.seenTxHashes.has(activity.transactionHash)) continue;

        const lastSeen = this.lastSeenTimestamp.get(target.address) ?? 0;
        if (activity.timestamp <= lastSeen) continue;

        this.seenTxHashes.add(activity.transactionHash);
        if (activity.timestamp > lastSeen) {
          this.lastSeenTimestamp.set(target.address, activity.timestamp);
        }

        if (activity.type !== "TRADE") continue;
        if (activity.side !== "BUY") continue;

        const slug = activity.eventSlug || activity.slug;
        if (!slug || !isCryptoUpDown(slug)) continue;

        const token = extractTokenFromSlug(slug);
        if (!token) continue;

        const signal: CopySignal = {
          source: target.name,
          sourceAddress: target.address,
          market: activity.title,
          slug,
          conditionId: activity.conditionId,
          outcome: activity.outcome,
          outcomeIndex: activity.outcomeIndex,
          asset: activity.asset,
          price: activity.price,
          size: activity.size,
          usdcSize: activity.usdcSize,
          timestamp: activity.timestamp,
          token,
          timeframe: extractTimeframeFromSlug(slug),
        };

        console.log(
          `\n🚨 COPY SIGNAL: ${target.name} bought ${token} ${activity.outcome} @ ${(activity.price * 100).toFixed(0)}¢ | $${activity.usdcSize.toFixed(0)} | ${activity.title}`
        );

        this.emit("copy-signal", signal);
      }

      if (this.seenTxHashes.size > 500) {
        const arr = [...this.seenTxHashes];
        this.seenTxHashes = new Set(arr.slice(-200));
      }
    } catch {
      // transient errors, don't spam
    }
  }

  // ── Profile fetching (closed positions) ──

  private async fetchAllProfiles(): Promise<void> {
    await Promise.allSettled(
      TARGETS.map((target) => this.fetchProfile(target))
    );
    this.emit("profiles-updated", this.getProfiles());
  }

  private async fetchProfile(target: WatchTarget): Promise<void> {
    try {
      const url = `${DATA_API}/closed-positions?user=${target.address}&limit=5&sortBy=endDate&sortOrder=desc`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/json" },
      });

      if (!res.ok) return;

      const positions: RawClosedPosition[] = await res.json();

      const recentClosed: ClosedPosition[] = positions.map((p) => ({
        market: p.title,
        slug: p.eventSlug || p.slug,
        outcome: p.outcome,
        avgPrice: p.avgPrice,
        size: p.totalBought,
        totalTraded: p.totalBought * p.avgPrice,
        amountWon: p.realizedPnl + p.totalBought * p.avgPrice,
        pnl: p.realizedPnl,
        won: p.realizedPnl > 0,
      }));

      const profile = this.profiles.get(target.address);
      if (profile) {
        profile.recentClosed = recentClosed;
        profile.lastFetch = Date.now();

        // Compute simple stats from these 5 trades
        const wins = recentClosed.filter((p) => p.won).length;
        console.log(
          `📊 ${target.name}: ${wins}/${recentClosed.length} wins in last 5 closed`
        );
      }
    } catch {
      // transient
    }
  }
}
