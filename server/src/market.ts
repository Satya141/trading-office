import type { Candle, MarketSnapshot } from '../../shared/types.js';
import { atr, computeIndicators } from './indicators.js';

/**
 * Live crypto market data. Binance is the primary source; Coinbase covers the
 * case where Binance is geo-blocked. Everything downstream only sees
 * MarketSnapshot, so the source is swappable.
 */

const BINANCE = 'https://api.binance.com/api/v3';
const COINBASE = 'https://api.exchange.coinbase.com';

async function getJSON<T>(url: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'trading-office/1.0' },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** BTCUSDT → BTC-USD, for the Coinbase fallback. */
function toCoinbaseProduct(symbol: string): string {
  const base = symbol.replace(/USDT$|USD$/, '');
  return `${base}-USD`;
}

export function displaySymbol(symbol: string): string {
  return symbol.replace(/USDT$/, '/USDT').replace(/USD$/, '/USD');
}

type BinanceKline = [
  number, string, string, string, string, string,
  number, string, number, string, string, string,
];

async function binanceCandles(symbol: string, interval: string, limit: number) {
  const raw = await getJSON<BinanceKline[]>(
    `${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  );
  return raw.map<Candle>((k) => ({
    t: k[0],
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
  }));
}

interface CoinbaseCandle extends Array<number> {}

async function coinbaseCandles(symbol: string, granularity: number) {
  const product = toCoinbaseProduct(symbol);
  // Coinbase returns [time, low, high, open, close, volume], newest first.
  const raw = await getJSON<CoinbaseCandle[]>(
    `${COINBASE}/products/${product}/candles?granularity=${granularity}`,
  );
  return raw
    .slice()
    .reverse()
    .map<Candle>((k) => ({
      t: (k[0] ?? 0) * 1000,
      l: k[1] ?? 0,
      h: k[2] ?? 0,
      o: k[3] ?? 0,
      c: k[4] ?? 0,
      v: k[5] ?? 0,
    }));
}

interface Book {
  bid: number;
  ask: number;
  volume24h: number;
  change24h: number;
}

async function binanceBook(symbol: string): Promise<Book> {
  const [bt, t24] = await Promise.all([
    getJSON<{ bidPrice: string; askPrice: string }>(
      `${BINANCE}/ticker/bookTicker?symbol=${symbol}`,
    ),
    getJSON<{ quoteVolume: string; priceChangePercent: string }>(
      `${BINANCE}/ticker/24hr?symbol=${symbol}`,
    ),
  ]);
  return {
    bid: Number(bt.bidPrice),
    ask: Number(bt.askPrice),
    volume24h: Number(t24.quoteVolume),
    change24h: Number(t24.priceChangePercent),
  };
}

async function coinbaseBook(symbol: string): Promise<Book> {
  const product = toCoinbaseProduct(symbol);
  const [tick, stats] = await Promise.all([
    getJSON<{ bid: string; ask: string; volume: string }>(
      `${COINBASE}/products/${product}/ticker`,
    ),
    getJSON<{ open: string; last: string; volume: string }>(
      `${COINBASE}/products/${product}/stats`,
    ),
  ]);
  const open = Number(stats.open);
  const last = Number(stats.last);
  return {
    bid: Number(tick.bid),
    ask: Number(tick.ask),
    volume24h: Number(stats.volume) * last,
    change24h: open > 0 ? ((last - open) / open) * 100 : 0,
  };
}

export class MarketFeed {
  private candles = new Map<string, Candle[]>();
  private snapshots = new Map<string, MarketSnapshot>();
  /** Flips to true the first time Binance fails, so we stop retrying it. */
  private useCoinbase = false;
  private lastError: string | null = null;

  /** When the 5-minute history was last re-pulled in full. */
  private lastCandles = 0;
  /** Fewer bars than this and the indicators are meaningless (RSI 50, ATR 0). */
  static readonly MIN_BARS = 50;

  /** 1-hour candles, used only for stop and target sizing. */
  private hourly = new Map<string, Candle[]>();
  private lastHourly = 0;

  constructor(private symbols: string[]) {}

  /** Refresh hourly candles; cheap, and only needed every few minutes. */
  private async refreshHourly(): Promise<void> {
    this.lastHourly = Date.now();
    await Promise.all(
      this.symbols.map(async (s) => {
        try {
          const c = this.useCoinbase ? await coinbaseCandles(s, 3600) : await binanceCandles(s, '1h', 60);
          if (c.length > 0) this.hourly.set(s, c);
        } catch {
          // Keep the previous hourly series; stops fall back to scaled 5m ATR.
        }
      }),
    );
  }

  get sourceName(): string {
    return this.useCoinbase ? 'Coinbase' : 'Binance';
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Pull ~200 five-minute candles per symbol so indicators are warm at boot. */
  async warmup(): Promise<void> {
    for (const s of this.symbols) {
      try {
        const c = this.useCoinbase
          ? await coinbaseCandles(s, 300)
          : await binanceCandles(s, '5m', 200);
        this.candles.set(s, c);
      } catch (err) {
        if (!this.useCoinbase) {
          this.useCoinbase = true;
          try {
            this.candles.set(s, await coinbaseCandles(s, 300));
            continue;
          } catch (err2) {
            this.lastError = String(err2);
          }
        }
        this.lastError = String(err);
        // Keep the last good history; only start empty if there never was any.
        if (!this.candles.has(s)) this.candles.set(s, []);
      }
    }
  }

  async refresh(): Promise<void> {
    // Re-pull history every 5 minutes, and straight away for any coin that is
    // missing it. Previously history was fetched once at boot, so one failed
    // request left the desks debating an empty, dead-flat tape all session.
    const stale = Date.now() - this.lastCandles > 5 * 60_000;
    const missing = this.symbols.some((s) => !this.isWarm(s));
    if (stale || missing) {
      await this.warmup();
      this.lastCandles = Date.now();
    }
    if (Date.now() - this.lastHourly > 5 * 60_000) await this.refreshHourly();
    await Promise.all(this.symbols.map((s) => this.refreshOne(s)));
  }

  private async refreshOne(symbol: string): Promise<void> {
    try {
      const book = this.useCoinbase
        ? await coinbaseBook(symbol)
        : await binanceBook(symbol);

      const price = (book.bid + book.ask) / 2;
      const series = this.candles.get(symbol) ?? [];

      // Roll the live price into the most recent candle so indicators move
      // between five-minute closes instead of sitting stale.
      if (series.length > 0) {
        const last = series[series.length - 1]!;
        last.c = price;
        if (price > last.h) last.h = price;
        if (price < last.l) last.l = price;
      }

      const ind = computeIndicators(series, book.change24h);
      // Stops are sized from hourly swings. Without hourly data, scale the
      // 5-minute ATR up by sqrt(12), which is how volatility scales with time.
      const hourlySeries = this.hourly.get(symbol) ?? [];
      ind.atr1h = hourlySeries.length > 2 ? atr(hourlySeries, 14) : ind.atr14 * Math.sqrt(12);
      ind.atr1h_pct = price > 0 ? (ind.atr1h / price) * 100 : 0;
      const spread = price > 0 ? ((book.ask - book.bid) / price) * 10_000 : 0;

      this.snapshots.set(symbol, {
        symbol,
        price,
        bid: book.bid,
        ask: book.ask,
        spread_bps: spread,
        volume24h: book.volume24h,
        indicators: ind,
        spark: series.slice(-60).map((c) => c.c),
        updated: Date.now(),
      });
      this.lastError = null;
    } catch (err) {
      this.lastError = String(err);
      if (!this.useCoinbase) {
        // One-time failover, then the next tick retries through Coinbase.
        this.useCoinbase = true;
        await this.warmup();
      }
    }
  }

  /** Re-pull full candles periodically so closed bars are authoritative. */
  async recandle(): Promise<void> {
    await this.warmup();
  }

  get(symbol: string): MarketSnapshot | undefined {
    return this.snapshots.get(symbol);
  }

  all(): Record<string, MarketSnapshot> {
    return Object.fromEntries(this.snapshots);
  }

  /** True once a coin has enough real history for its indicators to mean anything. */
  isWarm(symbol: string): boolean {
    return (this.candles.get(symbol)?.length ?? 0) >= MarketFeed.MIN_BARS;
  }

  get ready(): boolean {
    return this.snapshots.size > 0;
  }
}

/** USD→INR, refreshed hourly. Falls back to a recent static rate. */
export class FxFeed {
  private rate = 88.4;
  private fetched = 0;

  get value(): number {
    return this.rate;
  }

  async refresh(): Promise<number> {
    const hour = 60 * 60 * 1000;
    if (Date.now() - this.fetched < hour) return this.rate;
    try {
      const data = await getJSON<{ rates: Record<string, number> }>(
        'https://open.er-api.com/v6/latest/USD',
      );
      const inr = data.rates?.INR;
      if (typeof inr === 'number' && inr > 0) {
        this.rate = inr;
        this.fetched = Date.now();
      }
    } catch {
      // Keep the previous rate; a stale FX print beats crashing the floor.
    }
    return this.rate;
  }
}
