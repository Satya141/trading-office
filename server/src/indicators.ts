import type { Candle, Indicators } from '../../shared/types.js';

/** Exponential moving average over the last `period` closes. */
export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values so short series stay sane.
  const seedLen = Math.min(period, values.length);
  let acc = 0;
  for (let i = 0; i < seedLen; i++) acc += values[i]!;
  let out = acc / seedLen;
  for (let i = seedLen; i < values.length; i++) {
    out = values[i]! * k + out * (1 - k);
  }
  return out;
}

/** Full EMA series — needed because MACD's signal line is an EMA of an EMA. */
function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const seedLen = Math.min(period, values.length);
  let acc = 0;
  for (let i = 0; i < seedLen; i++) acc += values[i]!;
  let cur = acc / seedLen;
  const out: number[] = new Array(values.length).fill(cur);
  for (let i = seedLen; i < values.length; i++) {
    cur = values[i]! * k + cur * (1 - k);
    out[i] = cur;
  }
  return out;
}

/** Wilder's RSI. Returns 50 on insufficient data rather than throwing. */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    // Wilder smoothing: prior average carries (period-1)/period of the weight.
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range, Wilder-smoothed. */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    trs.push(
      Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)),
    );
  }
  if (trs.length < period) {
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }
  let acc = 0;
  for (let i = 0; i < period; i++) acc += trs[i]!;
  let out = acc / period;
  for (let i = period; i < trs.length; i++) {
    out = (out * (period - 1) + trs[i]!) / period;
  }
  return out;
}

export function macd(closes: number[]): {
  macd: number;
  signal: number;
  hist: number;
} {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const line = closes.map((_, i) => fast[i]! - slow[i]!);
  const sig = emaSeries(line, 9);
  const m = line[line.length - 1]!;
  const s = sig[sig.length - 1]!;
  return { macd: m, signal: s, hist: m - s };
}

/** Annualised realised volatility as a percentage, from log returns. */
function realisedVol(closes: number[], period = 20, barsPerYear = 105_120): number {
  const slice = closes.slice(-(period + 1));
  if (slice.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1]!;
    if (prev > 0) rets.push(Math.log(slice[i]! / prev));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(barsPerYear) * 100;
}

/** Where the last close sits inside the recent high-low band, 0..1. */
function rangePosition(candles: Candle[], period = 20): number {
  const slice = candles.slice(-period);
  if (slice.length === 0) return 0.5;
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of slice) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  const last = slice[slice.length - 1]!.c;
  if (hi === lo) return 0.5;
  return Math.min(1, Math.max(0, (last - lo) / (hi - lo)));
}

export function computeIndicators(candles: Candle[], change24h: number): Indicators {
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1] ?? 0;
  const m = macd(closes);
  const a = atr(candles, 14);
  return {
    rsi14: rsi(closes, 14),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    macd: m.macd,
    macd_signal: m.signal,
    macd_hist: m.hist,
    atr14: a,
    atr_pct: last > 0 ? (a / last) * 100 : 0,
    change24h,
    range_pos: rangePosition(candles, 20),
    vol20: realisedVol(closes, 20),
    atr1h: 0,
    atr1h_pct: 0,
  };
}
