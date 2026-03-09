export function formatPrice(token, price) {
  if (!price) return "—";
  if (token === "BTC") return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (token === "ETH") return `$${price.toFixed(1)}`;
  return `$${price.toFixed(4)}`;
}

export function formatPnl(pnl) {
  if (pnl == null) return "—";
  const sign = pnl >= 0 ? "+" : "";
  return `${sign}$${pnl.toFixed(2)}`;
}

export function formatPct(pct) {
  if (pct == null) return "—";
  return `${pct.toFixed(3)}%`;
}
