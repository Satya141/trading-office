/** Indian-numbering helpers. The whole left rail reports in rupees. */

/** ₹12,34,567 — full precision, Indian digit grouping. */
export function inr(v: number, decimals = 0): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** ₹1.23L / ₹4.56Cr — compact, for tight cells. */
export function inrShort(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)}k`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Explicit sign, for P&L where "+0" matters. */
export function signed(v: number, fn: (n: number) => string = inr): string {
  return v > 0 ? `+${fn(v)}` : fn(v);
}

export function pct(v: number, decimals = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
}

export function usd(v: number): string {
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: v < 10 ? 4 : 2,
    maximumFractionDigits: v < 10 ? 4 : 2,
  })}`;
}

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('en-IN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function sym(s: string): string {
  return s.replace(/USDT$/, '/USDT').replace(/(?<!\/)USD$/, '/USD');
}
