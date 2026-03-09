import React from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";
import { formatPrice, formatPnl, formatPct } from "./lib/formatters.js";

const TOKENS = ["BTC", "ETH", "SOL", "XRP"];

function Header({ connected }) {
  return (
    <div className="header">
      <h1>POLY-QUANT</h1>
      <span className="mode">PAPER</span>
      <div className="status">
        <span className={`dot ${connected ? "on" : ""}`} />
        {connected ? "Live" : "Disconnected"}
      </div>
    </div>
  );
}

function WindowBar({ window: w }) {
  if (!w) return null;
  const total = 15 * 60;
  const pct = (w.timeElapsedSec / total) * 100;
  const zoneClass = w.inZone ? "active" : w.timeLeftSec < 5 ? "late" : "waiting";
  const zoneLabel = w.inZone ? "ACTIVE ZONE" : w.timeLeftSec < 5 ? "TOO LATE" : "WAITING";

  const fillColor = w.inZone
    ? "linear-gradient(90deg, #22c55e, #16a34a)"
    : w.timeLeftSec < 60
      ? "linear-gradient(90deg, #ef4444, #dc2626)"
      : "linear-gradient(90deg, #3b82f6, #2563eb)";

  const start = new Date(w.startTime).toLocaleTimeString();
  const end = new Date(w.endTime).toLocaleTimeString();

  return (
    <div className="window-bar">
      <div className="row">
        <span style={{ color: "#6b7280" }}>{start} → {end}</span>
        <span className="time-left">{Math.floor(w.timeLeftSec)}s</span>
        <span className={`zone ${zoneClass}`}>{zoneLabel}</span>
      </div>
      <div className="progress-track">
        <div
          className="progress-fill"
          style={{ width: `${Math.min(100, pct)}%`, background: fillColor }}
        />
      </div>
    </div>
  );
}

function TokenCard({ token, data }) {
  if (!data) return (
    <div className="token-card">
      <div className="token-header"><span className="token-name">{token}</span></div>
      <div className="price" style={{ color: "#6b7280" }}>Waiting...</div>
    </div>
  );

  const gapClass = data.absGapPercent < 0.01 ? "flat" : data.direction === "Up" ? "up" : "down";
  const arrow = data.direction === "Up" ? "▲" : "▼";

  return (
    <div className="token-card">
      <div className="token-header">
        <span className="token-name">{token}</span>
        <span className={`gap ${gapClass}`}>
          {arrow} {formatPct(data.absGapPercent)}
        </span>
      </div>
      <div className="price">{formatPrice(token, data.current)}</div>
      <div className="meta">
        <span>Ref: {formatPrice(token, data.reference)}</span>
        <span>Vol: {data.volatility != null ? `${data.volatility.toFixed(4)}%` : "n/a"}</span>
      </div>
      {data.polyHasMarket && (
        <div className="poly-prices">
          <span className="poly-badge">LIVE</span>
          <span className="up">{(data.polyUpPrice * 100).toFixed(1)}¢</span>
          <span style={{ color: "#6b7280" }}>/</span>
          <span className="down">{(data.polyDownPrice * 100).toFixed(1)}¢</span>
          <span style={{ color: "#4b5563", fontSize: 10 }}>depth ${Math.round(data.polyBookDepth)}</span>
        </div>
      )}
    </div>
  );
}

function SignalCard({ token, signal }) {
  if (!signal) return (
    <div className="signal-card">
      <div className="signal-header">{token}</div>
      <div style={{ color: "#6b7280", fontSize: 12 }}>No data</div>
    </div>
  );

  const gates = [
    { label: "Time", value: `${signal.timeLeftSec?.toFixed(0) || "—"}s`, pass: signal.timeLeftSec <= 90 && signal.timeLeftSec >= 5 },
    { label: "Gap", value: formatPct(Math.abs(signal.gapPercent)), pass: Math.abs(signal.gapPercent) >= 0.05 },
    { label: "Vol", value: signal.volatility != null && signal.volatility < 100 ? `${signal.volatility.toFixed(4)}%` : "n/a", pass: signal.volatility != null && signal.volatility <= 0.15 },
    { label: "Poly", value: signal.polymarketPrice ? `${(signal.polymarketPrice * 100).toFixed(0)}¢` : "—", pass: signal.polymarketPrice > 0 && signal.polymarketPrice <= 0.75 },
    { label: "Edge", value: signal.edge ? `${(signal.edge * 100).toFixed(1)}%` : "—", pass: signal.edge >= 0.03 },
  ];

  return (
    <div className="signal-card" style={signal.shouldBet ? { borderColor: "#22c55e" } : {}}>
      <div className="signal-header">
        {token} {signal.shouldBet && <span style={{ color: "#22c55e" }}>● BET</span>}
      </div>
      {gates.map((g, i) => (
        <div className="gate" key={i}>
          <span className="label">{g.label}</span>
          <span className={`value ${g.pass ? "pass" : signal.timeLeftSec > 60 ? "wait" : "fail"}`}>
            {g.value}
          </span>
        </div>
      ))}
      <div className="signal-reason">{signal.reason}</div>
    </div>
  );
}

function StatsPanel({ stats }) {
  if (!stats) return null;
  const roi = stats.totalWagered > 0 ? (stats.totalPnl / stats.totalWagered) * 100 : 0;
  const pnlClass = stats.totalPnl >= 0 ? "pnl-positive" : "pnl-negative";

  return (
    <div className="stats-panel">
      <h2>Session Stats</h2>
      <div className="stat-row">
        <span className="label">Trades</span>
        <span className="value">{stats.totalTrades}</span>
      </div>
      <div className="stat-row">
        <span className="label">W / L</span>
        <span className="value">{stats.wins} / {stats.losses}</span>
      </div>
      <div className="stat-row">
        <span className="label">Win Rate</span>
        <span className="value">{(stats.winRate * 100).toFixed(1)}%</span>
      </div>
      <div className="stat-row">
        <span className="label">P&L</span>
        <span className={`value ${pnlClass}`}>{formatPnl(stats.totalPnl)}</span>
      </div>
      <div className="stat-row">
        <span className="label">Wagered</span>
        <span className="value">${stats.totalWagered.toFixed(2)}</span>
      </div>
      <div className="stat-row">
        <span className="label">ROI</span>
        <span className={`value ${pnlClass}`}>{roi.toFixed(1)}%</span>
      </div>
      <div className="stat-row">
        <span className="label">Peak P&L</span>
        <span className="value">${stats.peakPnl.toFixed(2)}</span>
      </div>
      <div className="stat-row">
        <span className="label">Max Drawdown</span>
        <span className="value" style={{ color: "#ef4444" }}>${stats.maxDrawdown.toFixed(2)}</span>
      </div>
      {stats.byToken && (
        <>
          <h2 style={{ marginTop: 16 }}>By Token</h2>
          {TOKENS.map((t) => {
            const ts = stats.byToken[t];
            if (!ts || ts.trades === 0) return null;
            const wr = ((ts.wins / ts.trades) * 100).toFixed(0);
            return (
              <div className="stat-row" key={t}>
                <span className="label">{t}</span>
                <span className="value">
                  {ts.wins}/{ts.trades} ({wr}%) <span className={ts.pnl >= 0 ? "pnl-positive" : "pnl-negative"}>{formatPnl(ts.pnl)}</span>
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function TradeLog({ trades, pending }) {
  return (
    <div className="trade-log">
      <h2>Trade Log</h2>
      {pending && pending.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          {pending.map((t) => (
            <span className="pending-badge" key={t.id}>
              {t.token} {t.direction} @ {(t.entryPrice * 100).toFixed(0)}c | ${t.size.toFixed(2)}
            </span>
          ))}
        </div>
      )}
      {(!trades || trades.length === 0) ? (
        <div style={{ color: "#6b7280", fontSize: 12 }}>No trades yet</div>
      ) : (
        [...trades].reverse().map((t) => (
          <div className="trade-entry" key={t.id}>
            <span className="icon">{t.won ? "✅" : "❌"}</span>
            <span className="details">
              {t.token} {t.direction} @ {(t.entryPrice * 100).toFixed(0)}c
              {" "}(ref {formatPrice(t.token, t.referencePrice)} → {formatPrice(t.token, t.resolutionPrice)})
            </span>
            <span className={`pnl ${(t.pnl ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}`}>
              {formatPnl(t.pnl)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function ActivityLog({ logs }) {
  return (
    <div className="activity-log" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
      <h2>Activity</h2>
      {(logs || []).map((line, i) => (
        <div className="log-line" key={i}>{line}</div>
      ))}
    </div>
  );
}

export default function App() {
  const { data, connected } = useWebSocket();

  return (
    <div className="container">
      <Header connected={connected} />
      <WindowBar window={data?.window} />

      <div className="grid grid-4">
        {TOKENS.map((t) => (
          <TokenCard key={t} token={t} data={data?.prices?.[t]} />
        ))}
      </div>

      <div className="grid grid-4">
        {TOKENS.map((t) => (
          <SignalCard key={t} token={t} signal={data?.signals?.[t]} />
        ))}
      </div>

      <div className="grid grid-3">
        <StatsPanel stats={data?.stats} />
        <TradeLog trades={data?.recentTrades} pending={data?.pending} />
        <ActivityLog logs={data?.logs} />
      </div>
    </div>
  );
}
