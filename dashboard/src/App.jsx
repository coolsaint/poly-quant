import React from "react";
import { useWebSocket } from "./hooks/useWebSocket.js";

function Header({ connected }) {
  return (
    <div className="header">
      <h1>POLY-QUANT</h1>
      <span className="mode">COPY BOT</span>
      <div className="status">
        <span className={`dot ${connected ? "on" : ""}`} />
        {connected ? "Live" : "Disconnected"}
      </div>
    </div>
  );
}

function TraderCard({ profile }) {
  if (!profile) return null;

  const closed = profile.recentClosed || [];
  const wins = closed.filter((p) => p.won).length;
  const losses = closed.length - wins;

  return (
    <div className="trader-card">
      <div className="trader-header">
        <span className="trader-name">{profile.name}</span>
        <span className="trader-address">
          {profile.address.slice(0, 6)}...{profile.address.slice(-4)}
        </span>
      </div>
      <div className="trader-stats">
        <span className="win">{wins}W</span>
        <span className="sep">/</span>
        <span className="loss">{losses}L</span>
        <span className="of">last {closed.length}</span>
      </div>
      <div className="trader-trades">
        {closed.length === 0 ? (
          <div className="empty">Loading trades...</div>
        ) : (
          closed.map((t, i) => (
            <div className={`trade-row ${t.won ? "won" : "lost"}`} key={i}>
              <span className="result">{t.won ? "W" : "L"}</span>
              <span className="market">{t.market}</span>
              <span className="outcome">{t.outcome} @ {(t.avgPrice * 100).toFixed(0)}c</span>
              <span className={`pnl ${t.pnl >= 0 ? "pos" : "neg"}`}>
                {t.pnl >= 0 ? "+" : ""}{t.pnl.toFixed(2)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function CopyAlerts({ signals }) {
  if (!signals || signals.length === 0) return null;

  return (
    <div className="copy-alerts">
      <h2>Live Alerts</h2>
      {[...signals].reverse().map((s, i) => {
        const time = new Date(s.timestamp * 1000).toLocaleTimeString();
        return (
          <div className="alert-row" key={i}>
            <span className="alert-badge">COPY</span>
            <span className="alert-info">
              <strong>{s.source}</strong> {s.token} {s.outcome} @ {(s.price * 100).toFixed(0)}c | ${s.usdcSize.toFixed(0)} | {s.timeframe}
            </span>
            <span className="alert-time">{time}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const { data, connected } = useWebSocket();

  const profiles = data?.profiles || [];
  const signals = data?.copySignals || [];

  return (
    <div className="container">
      <Header connected={connected} />
      <CopyAlerts signals={signals} />
      <div className="traders-grid">
        {profiles.map((p) => (
          <TraderCard key={p.address} profile={p} />
        ))}
        {profiles.length === 0 && (
          <div className="empty">Connecting to traders...</div>
        )}
      </div>
    </div>
  );
}
