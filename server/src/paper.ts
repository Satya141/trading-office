import type {
  Fill,
  MarketSnapshot,
  Portfolio,
  Position,
  Side,
  TradeMeta,
} from '../../shared/types.js';

/**
 * Paper trading engine.
 *
 * Fills cross the real spread (buy the ask, sell the bid) and pay a taker fee,
 * so the P&L is not the fantasy you get from marking at mid. Stops and targets
 * are set from live ATR, which means a volatile tape automatically produces
 * wider brackets rather than the same fixed percentage every time.
 *
 * Everything is denominated internally in USD and reported in INR.
 */

/** Binance-style taker fee, 5bps a side. */
const TAKER_FEE = 0.0005;
/**
 * Stop and target as multiples of 1-hour ATR. The first version used 5-minute
 * ATR, which put stops ~0.3% from entry on BTC — inside ordinary noise, so
 * trades were stopped out before the idea could play out.
 */
const STOP_ATR = 1.2;
const TARGET_ATR = 2.0;
export const STOP_BASIS = `${STOP_ATR}x / ${TARGET_ATR}x 1h ATR`;
/**
 * Limits apply to margin — the capital actually at risk — not to exposure,
 * because a levered trade's exposure is a multiple of the money committed.
 */
const MAX_SYMBOL_EXPOSURE = 0.25;
const MAX_GROSS_EXPOSURE = 0.6;
/** Ceiling on leverage the desks may use. */
export const MAX_LEVERAGE = 10;

let fillSeq = 0;
let posSeq = 0;

export interface OpenRequest {
  symbol: string;
  side: Side;
  size_pct: number;
  snapshot: MarketSnapshot;
  backers: string[];
  meeting_id: string;
  meta?: Omit<TradeMeta, 'entry_fee_inr' | 'stop_basis'>;
  /** Desk leverage, 1–10. Exposure is margin × leverage. */
  leverage?: number;
  /** Owner trades set their own size and skip the desk's exposure caps. */
  manual?: { margin_inr: number; leverage: number };
}

export type CloseReason = 'stop' | 'target' | 'manual' | 'flip' | 'desk';

export class PaperBook {
  private positions: Position[] = [];
  private fills: Fill[] = [];
  /**
   * The book is kept in INR, because that is the currency the firm actually
   * holds. Crypto exposure is USD-denominated, so only position maths converts.
   * Booking in USD instead makes the starting capital move with the FX rate,
   * which shows up as phantom P&L before a single trade has closed.
   */
  private cashInr: number;
  private readonly startInr: number;
  private realisedInr = 0;
  private feesInr = 0;
  private wins = 0;
  private losses = 0;
  private peakEquityInr: number;
  private maxDdPct = 0;
  /** Called for every closed position, whatever closed it. */
  onClose?: (p: Position, f: Fill) => void;

  constructor(
    startingCapitalInr: number,
    private usdinr: () => number,
  ) {
    this.startInr = startingCapitalInr;
    this.cashInr = startingCapitalInr;
    this.peakEquityInr = startingCapitalInr;
  }

  get openPositions(): Position[] {
    return this.positions;
  }

  /** Cash not already committed as margin on open positions. */
  freeCashInr(): number {
    return this.cashInr - this.positions.reduce((a, p) => a + p.margin_inr, 0);
  }

  private equityInr(): number {
    return this.cashInr + this.positions.reduce((a, p) => a + this.upnlInr(p), 0);
  }

  /** Equity expressed in USD, for sizing against dollar-quoted notionals. */
  private equityUsd(): number {
    return this.equityInr() / this.usdinr();
  }

  private upnlUsd(p: Position): number {
    const dir = p.side === 'long' ? 1 : -1;
    return ((p.mark - p.entry) / p.entry) * p.notional_usd * dir;
  }

  private upnlInr(p: Position): number {
    return this.upnlUsd(p) * this.usdinr();
  }

  /** Reasons this trade cannot be taken, empty when it can. */
  preTradeCheck(req: OpenRequest): string[] {
    const reasons: string[] = [];
    const eq = this.equityUsd();

    // An owner trade is sized by its margin and leverage, and is only limited
    // by free cash — the desk's exposure caps govern the desks, not the owner.
    if (req.manual) {
      const marginInr = req.manual.margin_inr;
      if (marginInr <= 0 || req.manual.leverage <= 0) reasons.push('zero size');
      if (marginInr > this.freeCashInr()) {
        reasons.push(`margin ₹${Math.round(marginInr).toLocaleString('en-IN')} exceeds free cash ₹${Math.round(this.freeCashInr()).toLocaleString('en-IN')}`);
      }
      if (req.snapshot.spread_bps > 25) reasons.push('spread too wide to pay');
      return reasons;
    }

    const marginUsd = eq * req.size_pct;
    const lev = Math.max(1, Math.min(MAX_LEVERAGE, req.leverage ?? 1));

    if (req.size_pct <= 0) reasons.push('zero size');
    if (marginUsd * lev < 25) reasons.push('size below minimum ticket');

    const symMargin =
      this.positions
        .filter((p) => p.symbol === req.symbol)
        .reduce((a, p) => a + p.margin_inr, 0) / this.usdinr() + marginUsd;
    if (symMargin > eq * MAX_SYMBOL_EXPOSURE) {
      reasons.push(`would breach ${(MAX_SYMBOL_EXPOSURE * 100).toFixed(0)}% single-symbol margin cap`);
    }

    const grossMargin =
      this.positions.reduce((a, p) => a + p.margin_inr, 0) / this.usdinr() + marginUsd;
    if (grossMargin > eq * MAX_GROSS_EXPOSURE) {
      reasons.push(`would breach ${(MAX_GROSS_EXPOSURE * 100).toFixed(0)}% total margin cap`);
    }

    if (req.snapshot.spread_bps > 25) reasons.push('spread too wide to pay');
    if (this.freeCashInr() / this.usdinr() < marginUsd) reasons.push('insufficient free cash');

    return reasons;
  }

  /**
   * An existing opposite-side position in the same symbol is closed before the
   * new one opens, rather than running a hedged book nobody asked for.
   */
  open(req: OpenRequest): { position?: Position; fills: Fill[]; rejected?: string } {
    const out: Fill[] = [];

    for (const p of this.positions.filter(
      (p) => p.symbol === req.symbol && p.side !== req.side,
    )) {
      const f = this.close(p, req.snapshot, 'flip');
      if (f) out.push(f);
    }

    const reasons = this.preTradeCheck(req);
    if (reasons.length > 0) return { fills: out, rejected: reasons.join('; ') };

    const s = req.snapshot;
    // Cross the spread — longs lift the ask, shorts hit the bid.
    const entry = req.side === 'long' ? s.ask : s.bid;
    const leverage = Math.max(1, Math.min(MAX_LEVERAGE, req.manual?.leverage ?? req.leverage ?? 1));
    const marginInr = req.manual
      ? req.manual.margin_inr
      : this.equityUsd() * req.size_pct * this.usdinr();
    const notional = (marginInr * leverage) / this.usdinr();
    const atr = s.indicators.atr1h || s.indicators.atr14 * Math.sqrt(12) || entry * 0.01;

    const pos: Position = {
      id: `pos_${++posSeq}`,
      symbol: req.symbol,
      side: req.side,
      notional_usd: notional,
      entry,
      mark: entry,
      stop: req.side === 'long' ? entry - atr * STOP_ATR : entry + atr * STOP_ATR,
      take_profit:
        req.side === 'long' ? entry + atr * TARGET_ATR : entry - atr * TARGET_ATR,
      opened: Date.now(),
      upnl_inr: 0,
      backers: req.backers,
      meeting_id: req.meeting_id,
      leverage,
      margin_inr: marginInr,
    };

    const feeInr = notional * TAKER_FEE * this.usdinr();
    this.cashInr -= feeInr;
    this.feesInr += feeInr;
    if (req.meta) pos.meta = { ...req.meta, entry_fee_inr: feeInr, stop_basis: STOP_BASIS };
    this.positions.push(pos);

    const fill: Fill = {
      id: `fill_${++fillSeq}`,
      symbol: req.symbol,
      side: req.side,
      kind: 'open',
      price: entry,
      notional_usd: notional,
      pnl_inr: 0,
      fee_inr: feeInr,
      at: Date.now(),
      meeting_id: req.meeting_id,
    };
    this.fills.unshift(fill);
    out.push(fill);

    return { position: pos, fills: out };
  }

  private close(p: Position, s: MarketSnapshot, reason: CloseReason): Fill | null {
    const idx = this.positions.indexOf(p);
    if (idx === -1) return null;

    // Exit also crosses the spread, in the opposite direction.
    const exit = p.side === 'long' ? s.bid : s.ask;
    const dir = p.side === 'long' ? 1 : -1;
    const rate = this.usdinr();
    const grossUsd = ((exit - p.entry) / p.entry) * p.notional_usd * dir;
    const feeUsd = p.notional_usd * TAKER_FEE;
    const netInr = (grossUsd - feeUsd) * rate;
    const feeInr = feeUsd * rate;

    this.cashInr += netInr;
    this.realisedInr += netInr;
    this.feesInr += feeInr;
    if (netInr >= 0) this.wins++;
    else this.losses++;
    this.positions.splice(idx, 1);

    const fill: Fill = {
      id: `fill_${++fillSeq}`,
      symbol: p.symbol,
      side: p.side,
      kind: reason,
      price: exit,
      notional_usd: p.notional_usd,
      pnl_inr: netInr,
      fee_inr: feeInr,
      at: Date.now(),
      meeting_id: p.meeting_id,
    };
    this.fills.unshift(fill);
    if (this.fills.length > 200) this.fills.length = 200;
    this.onClose?.(p, fill);
    return fill;
  }

  closeById(
    id: string,
    snapshots: Record<string, MarketSnapshot>,
    reason: CloseReason = 'manual',
  ): Fill | null {
    const p = this.positions.find((x) => x.id === id);
    if (!p) return null;
    const s = snapshots[p.symbol];
    if (!s) return null;
    return this.close(p, s, reason);
  }

  /** One plain line about an open position, for the room to argue over. */
  describePosition(p: Position): string {
    const mins = Math.round((Date.now() - p.opened) / 60_000);
    const pnl = this.upnlInr(p);
    const toStop = (Math.abs(p.stop - p.mark) / p.mark) * 100;
    const toTarget = (Math.abs(p.take_profit - p.mark) / p.mark) * 100;
    return (
      `${p.side.toUpperCase()} ${p.symbol} from ${p.entry.toFixed(2)}, now ${p.mark.toFixed(2)}, ` +
      `${pnl >= 0 ? 'up' : 'down'} ₹${Math.abs(Math.round(pnl)).toLocaleString('en-IN')}, open ${mins} min; ` +
      `stop ${p.stop.toFixed(2)} (${toStop.toFixed(2)}% away), target ${p.take_profit.toFixed(2)} (${toTarget.toFixed(2)}% away)`
    );
  }

  /**
   * Mark every position and fire any stop or target that the new print has
   * crossed. Returns the fills so the floor can narrate them.
   */
  mark(snapshots: Record<string, MarketSnapshot>): Fill[] {
    const triggered: Fill[] = [];

    for (const p of [...this.positions]) {
      const s = snapshots[p.symbol];
      if (!s) continue;
      p.mark = s.price;
      p.upnl_inr = this.upnlInr(p);

      const hitStop =
        p.side === 'long' ? s.bid <= p.stop : s.ask >= p.stop;
      const hitTarget =
        p.side === 'long' ? s.bid >= p.take_profit : s.ask <= p.take_profit;

      // Stop wins ties — assume the worse path within the bar.
      if (hitStop) {
        const f = this.close(p, s, 'stop');
        if (f) triggered.push(f);
      } else if (hitTarget) {
        const f = this.close(p, s, 'target');
        if (f) triggered.push(f);
      }
    }

    const eq = this.equityInr();
    if (eq > this.peakEquityInr) this.peakEquityInr = eq;
    const dd =
      this.peakEquityInr > 0
        ? ((this.peakEquityInr - eq) / this.peakEquityInr) * 100
        : 0;
    if (dd > this.maxDdPct) this.maxDdPct = dd;

    return triggered;
  }

  snapshot(): Portfolio {
    const unrealisedInr = this.positions.reduce((a, p) => a + this.upnlInr(p), 0);
    const equityInr = this.cashInr + unrealisedInr;
    const pnlInr = equityInr - this.startInr;

    return {
      equity_inr: equityInr,
      cash_inr: this.cashInr,
      // Closed-trade P&L net of every fee paid so far, including entry fees on
      // positions still open. Keeps Realised + Open = Today's P&L exactly.
      realised_today_inr: this.cashInr - this.startInr,
      unrealised_inr: unrealisedInr,
      pnl_today_inr: pnlInr,
      pnl_today_pct: this.startInr > 0 ? (pnlInr / this.startInr) * 100 : 0,
      starting_capital_inr: this.startInr,
      positions: this.positions.map((p) => ({ ...p })),
      fills: this.fills.slice(0, 60),
      wins: this.wins,
      losses: this.losses,
      fees_inr: this.feesInr,
      max_drawdown_pct: this.maxDdPct,
      // "Deployed" is the capital committed; exposure is that times leverage.
      deployed_inr: this.positions.reduce((a, p) => a + p.margin_inr, 0),
      exposure_inr: this.positions.reduce((a, p) => a + p.notional_usd, 0) * this.usdinr(),
      margin_inr: this.positions.reduce((a, p) => a + p.margin_inr, 0),
      deploy_cap_inr: equityInr * MAX_GROSS_EXPOSURE,
    };
  }

  /** Short natural-language summary of the book, handed to Jev as state. */
  describe(): string {
    const pnl = `Session realised P&L ${this.realisedInr >= 0 ? '+' : ''}₹${Math.round(this.realisedInr).toLocaleString('en-IN')}, ${this.wins}W/${this.losses}L.`;
    if (this.positions.length === 0) return `Flat. No open positions. ${pnl}`;
    const legs = this.positions
      .map(
        (p) =>
          `${p.side.toUpperCase()} ${p.symbol} $${p.notional_usd.toFixed(0)} notional from ${p.entry.toFixed(2)}, now ${p.mark.toFixed(2)} (${this.upnlUsd(p) >= 0 ? '+' : ''}$${this.upnlUsd(p).toFixed(0)})`,
      )
      .join('; ');
    return `${this.positions.length} open: ${legs}. ${pnl}`;
  }

  /** Current risk headroom, also handed to Jev. */
  describeRisk(): string {
    const eq = this.equityUsd();
    const margin = this.positions.reduce((a, p) => a + p.margin_inr, 0) / this.usdinr();
    const gross = this.positions.reduce((a, p) => a + p.notional_usd, 0);
    return [
      `Equity $${eq.toFixed(0)}.`,
      `Capital committed as margin $${margin.toFixed(0)} of a $${(eq * MAX_GROSS_EXPOSURE).toFixed(0)} cap; exposure after leverage $${gross.toFixed(0)}.`,
      `Max single-symbol margin $${(eq * MAX_SYMBOL_EXPOSURE).toFixed(0)}.`,
      `Leverage available up to ${MAX_LEVERAGE}x.`,
      `Session drawdown ${this.maxDdPct.toFixed(2)}%.`,
      `Single-trade size is hard-capped at 10% of equity.`,
    ].join(' ');
  }
}
