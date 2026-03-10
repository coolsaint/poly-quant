import { EventEmitter } from "events";

/**
 * Copy-Trading Watcher
 *
 * Polls the Polymarket Data API every few seconds to detect new trades
 * from target wallets (cryptoaus, solidtaken). When a new crypto up/down
 * BUY is detected, emits a "copy-signal" event.
 *
 * Strategy: These traders have 100% win rate on 4-hour crypto markets.
 * We copy their trades as soon as they appear.
 */

interface WatchTarget {
  name: string;
  address: string;
}

export interface CopySignal {
  source: string; // trader name
  sourceAddress: string;
  market: string; // e.g., "Bitcoin Up or Down - March 9, 4:00PM-8:00PM ET"
  slug: string; // e.g., "btc-updown-4h-1773086400"
  conditionId: string;
  outcome: string; // "Up" or "Down"
  outcomeIndex: number;
  asset: string; // CLOB token ID
  price: number; // price they paid (e.g., 0.47)
  size: number; // shares
  usdcSize: number; // dollar amount
  timestamp: number; // unix seconds
  token: string; // extracted: BTC, ETH, SOL, XRP
  timeframe: string; // extracted: 4h, 15m, 1h, etc.
}

const DATA_API = "https://data-api.polymarket.com";

// Target traders to copy
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

// Slugs we care about (crypto up/down markets)
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
  // Older format: just has the hourly time like "btc-updown-1773086400"
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

export class CopyWatcher extends EventEmitter {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastSeenTimestamp = new Map<string, number>(); // address → latest timestamp
  private seenTxHashes = new Set<string>(); // dedup by tx hash
  private pollFrequencyMs: number;

  constructor(pollFrequencyMs = 3000) {
    super();
    this.pollFrequencyMs = pollFrequencyMs;

    // Initialize last-seen to "now" so we don't replay old trades
    const now = Math.floor(Date.now() / 1000);
    for (const target of TARGETS) {
      this.lastSeenTimestamp.set(target.address, now);
    }
  }

  start(): void {
    console.log(
      `👀 Copy-watcher started — polling ${TARGETS.length} traders every ${this.pollFrequencyMs / 1000}s`
    );
    for (const t of TARGETS) {
      console.log(`   📎 ${t.name}: ${t.address}`);
    }
    this.poll(); // immediate first poll
    this.pollInterval = setInterval(() => this.poll(), this.pollFrequencyMs);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log("👀 Copy-watcher stopped");
  }

  /**
   * Add a new trader to watch.
   */
  addTarget(name: string, address: string): void {
    // Don't add duplicates
    if (TARGETS.find((t) => t.address === address)) return;
    TARGETS.push({ name, address });
    this.lastSeenTimestamp.set(address, Math.floor(Date.now() / 1000));
    console.log(`👀 Now watching: ${name} (${address})`);
  }

  getTargets(): WatchTarget[] {
    return [...TARGETS];
  }

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

      if (!res.ok) {
        this.emit("error", {
          target: target.name,
          error: `API ${res.status}`,
        });
        return;
      }

      const activities: RawActivity[] = await res.json();

      for (const activity of activities) {
        // Skip if already seen
        if (this.seenTxHashes.has(activity.transactionHash)) continue;

        // Skip if older than our start time
        const lastSeen = this.lastSeenTimestamp.get(target.address) ?? 0;
        if (activity.timestamp <= lastSeen) continue;

        // Mark as seen
        this.seenTxHashes.add(activity.transactionHash);

        // Update last seen timestamp
        if (activity.timestamp > lastSeen) {
          this.lastSeenTimestamp.set(target.address, activity.timestamp);
        }

        // Only care about BUY trades on crypto up/down markets
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

      // Keep seenTxHashes from growing forever (keep last 500)
      if (this.seenTxHashes.size > 500) {
        const arr = [...this.seenTxHashes];
        this.seenTxHashes = new Set(arr.slice(-200));
      }
    } catch (err: any) {
      this.emit("error", {
        target: target.name,
        error: err.message,
      });
    }
  }
}
