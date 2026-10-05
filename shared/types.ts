/**
 * The wire contract between the trading floor (server) and the office view (web).
 * Everything the UI renders is a projection of FloorState.
 */

// ── Roles & staff ──────────────────────────────────────────────────────────

export type Role =
  | 'ceo'
  | 'manager'
  | 'team_lead'
  | 'quant_analyst'
  | 'research_analyst'
  | 'trader'
  | 'risk_manager'
  | 'compliance';

export const ROLE_LABEL: Record<Role, string> = {
  ceo: 'CEO',
  manager: 'Managing Director',
  team_lead: 'Team Lead',
  quant_analyst: 'Quant Analyst',
  research_analyst: 'Research Analyst',
  trader: 'Execution Trader',
  risk_manager: 'Risk Manager',
  compliance: 'Compliance',
};

/** Seniority decides who speaks last and whose veto sticks. */
export const ROLE_RANK: Record<Role, number> = {
  ceo: 100,
  manager: 80,
  risk_manager: 70,
  team_lead: 60,
  compliance: 55,
  quant_analyst: 40,
  research_analyst: 40,
  trader: 30,
};

export type AgentStatus =
  | 'working'
  | 'idle'
  | 'in_meeting'
  | 'walking'
  | 'break'
  | 'onboarding';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working',
  idle: 'Idle',
  in_meeting: 'In meeting',
  walking: 'Walking',
  break: 'On break',
  onboarding: 'Onboarding',
};

/** Personality knobs. These bias the agent's Jev prompt, not the maths. */
export interface Personality {
  /** 0 = permabear caution, 1 = swings big. */
  risk_appetite: number;
  /** 0 = follows the room, 1 = argues with everyone. */
  contrarianism: number;
  /** 0 = waits to be asked, 1 = interrupts constantly. */
  talkativeness: number;
  /** 0 = pure gut, 1 = wants the numbers first. */
  analytical: number;
  /** Free-text flavour handed to the voice model. */
  blurb: string;
}

export interface Agent {
  id: string;
  name: string;
  role: Role;
  status: AgentStatus;
  /** Grid position on the office floor. */
  x: number;
  y: number;
  /** Where they're headed, if walking. */
  target?: { x: number; y: number };
  /** Their own desk, to return to after a meeting. */
  desk: { x: number; y: number };
  personality: Personality;
  /** Cumulative realised P&L attributable to trades they voted for, in INR. */
  pnl_inr: number;
  /** Calls made, calls that made money. */
  calls: number;
  calls_won: number;
  /** Rises while working, falls on break. Drives cafeteria trips. */
  fatigue: number;
  /** Day the agent joined. Auto-hires show up mid-run. */
  hired_on: number;
  /** What they're doing right now, one short line for the desk tooltip. */
  activity: string;
  /** Avatar palette index. */
  hue: number;
  /** Status to adopt once they finish walking. Server-side bookkeeping. */
  arrivalStatus?: AgentStatus;
  /** Meetings whose trades this agent voted for, for P&L attribution. */
  backedMeetings?: string[];
  /** Remaining waypoints after `target`, routed through doors and corridors. */
  path?: { x: number; y: number }[];
  /** Final destination of the current walk. */
  dest?: { x: number; y: number };
  /** Desk team id, or 'leadership' for firm-wide seats. */
  team: string;
}

/** A trading desk: a team that covers one symbol and meets on its own cycle. */
export interface TeamInfo {
  id: string;
  name: string;
  symbol: string;
  color: string;
  lead_id: string;
  /** Row of the trading floor the team sits in. */
  row: number;
  members: string[];
  last_meeting: number;
  meetings: number;
}

// ── Market ─────────────────────────────────────────────────────────────────

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Indicators {
  rsi14: number;
  ema20: number;
  ema50: number;
  macd: number;
  macd_signal: number;
  macd_hist: number;
  atr14: number;
  /** ATR as a percentage of price — the volatility number humans quote. */
  atr_pct: number;
  /** Percent change over the last 24h. */
  change24h: number;
  /** Where price sits in the 20-period range, 0..1. */
  range_pos: number;
  /** Realised vol over 20 periods, annualised percentage. */
  vol20: number;
  /** ATR on 1-hour candles — what stops and targets are sized from. */
  atr1h: number;
  atr1h_pct: number;
}

export interface MarketSnapshot {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  spread_bps: number;
  volume24h: number;
  indicators: Indicators;
  /** Last 60 closes, for the sparkline. */
  spark: number[];
  updated: number;
}

// ── Trading ────────────────────────────────────────────────────────────────

export type Side = 'long' | 'short';

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  /** Position size in USD notional. */
  notional_usd: number;
  entry: number;
  /** Live mark price. */
  mark: number;
  stop: number;
  take_profit: number;
  opened: number;
  /** Unrealised, in INR. */
  upnl_inr: number;
  /** Agents who voted for this trade — they carry its P&L. */
  backers: string[];
  /** The meeting that produced it. */
  meeting_id: string;
  /** Who and what produced the trade, carried through to the trade history. */
  meta?: TradeMeta;
  /** 1 for ordinary desk trades; higher when the owner takes a levered position. */
  leverage: number;
  /** Cash set aside as margin, in INR. Equals notional/leverage. */
  margin_inr: number;
}

export interface TradeMeta {
  team: string;
  decided_by: 'jev' | 'rules' | 'owner';
  desk_mode: DeskMode;
  confidence: number;
  size_pct: number;
  entry_fee_inr: number;
  stop_basis: string;
}

/** One completed round trip, persisted to disk so it survives restarts. */
export interface TradeRecord {
  id: string;
  symbol: string;
  side: Side;
  team: string;
  opened_at: number;
  closed_at: number;
  entry: number;
  exit: number;
  stop: number;
  target: number;
  notional_usd: number;
  /** Net of both entry and exit fees, in INR. */
  pnl_inr: number;
  fees_inr: number;
  reason: 'stop' | 'target' | 'manual' | 'flip' | 'desk';
  decided_by: 'jev' | 'rules' | 'owner';
  leverage: number;
  desk_mode: DeskMode;
  confidence: number;
  size_pct: number;
  stop_basis: string;
}

export interface HistoryStats {
  trades: number;
  wins: number;
  pnl_inr: number;
  avg_minutes: number;
  by_reason: Record<string, number>;
  jev: { trades: number; wins: number; pnl_inr: number };
  rules: { trades: number; wins: number; pnl_inr: number };
  owner: { trades: number; wins: number; pnl_inr: number };
}

export interface Fill {
  id: string;
  symbol: string;
  side: Side;
  /** 'open' or the reason it closed. */
  kind: 'open' | 'stop' | 'target' | 'manual' | 'flip' | 'desk';
  price: number;
  notional_usd: number;
  /** Realised P&L in INR — zero on an opening fill. */
  pnl_inr: number;
  fee_inr: number;
  at: number;
  meeting_id: string;
}

export interface Portfolio {
  /** Cash + unrealised, in INR. */
  equity_inr: number;
  cash_inr: number;
  realised_today_inr: number;
  unrealised_inr: number;
  /** Realised + unrealised for the session. This is the big number on the left. */
  pnl_today_inr: number;
  pnl_today_pct: number;
  starting_capital_inr: number;
  positions: Position[];
  /** Newest first. */
  fills: Fill[];
  wins: number;
  losses: number;
  fees_inr: number;
  /** Peak-to-trough on session equity, percent. */
  max_drawdown_pct: number;
  /** Capital tied up in open positions (their notional), in INR. */
  deployed_inr: number;
  /** Most the risk rules allow deployed at once (gross exposure cap), in INR. */
  deploy_cap_inr: number;
  /** Cash committed as margin on levered positions, in INR. */
  margin_inr: number;
  /** Total position size after leverage, in INR. */
  exposure_inr: number;
}

// ── Discussion ─────────────────────────────────────────────────────────────

export type Stance = 'long' | 'short' | 'flat';

/** How readily the desk puts risk on. Changes the rules Jev is given. */
export type DeskMode = 'conservative' | 'normal' | 'aggressive';

export interface Utterance {
  id: string;
  meeting_id: string;
  agent_id: string;
  /** 'user' for your own interjections. */
  agent_name: string;
  role: Role | 'user';
  text: string;
  /** The typed decision underneath the words. Absent for user messages. */
  stance?: Stance;
  /** Jev conviction, 0..1 — rendered as the percentage badge. */
  conviction?: number;
  /** Jev's probability that this agent disagrees with the previous speaker. */
  dissent?: number;
  /** True when the decision came from real Jev rather than the fallback brain. */
  jev: boolean;
  at: number;
  round: number;
  /** Desk team whose meeting this was said in. */
  team?: string;
}

export type MeetingPhase =
  | 'gathering'
  | 'opening'
  | 'debate'
  | 'rebuttal'
  | 'decision'
  | 'done';

export interface Decision {
  /** Opening a new trade, or — when the desk already holds one — managing it. */
  action: 'execute_long' | 'execute_short' | 'stand_down' | 'hold' | 'close' | 'flip';
  /** Fraction of equity to commit, 0..1. */
  size_pct: number;
  confidence: number;
  rationale: string;
  /** Vote tally that led here. */
  tally: { long: number; short: number; flat: number };
  decided_by: string;
  jev: boolean;
}

export interface Meeting {
  id: string;
  symbol: string;
  team: string;
  team_name: string;
  /** Why the lead called it. */
  trigger: string;
  phase: MeetingPhase;
  round: number;
  max_rounds: number;
  participants: string[];
  decision?: Decision;
  started: number;
  ended?: number;
  /** Snapshot of the market when the meeting opened, so the debate is anchored. */
  snapshot: MarketSnapshot;
}

// ── Office ─────────────────────────────────────────────────────────────────

export type ZoneKind =
  | 'desk'
  | 'meeting_room'
  | 'cafeteria'
  | 'ceo_cabin'
  | 'reception'
  | 'corridor'
  | 'wall'
  | 'plant'
  | 'server_room'
  | 'lounge'
  | 'booths';

export interface Zone {
  kind: ZoneKind;
  label?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OfficeMap {
  width: number;
  height: number;
  zones: Zone[];
}

// ── Events (the right-hand ticker) ─────────────────────────────────────────

export type EventKind =
  | 'trade'
  | 'meeting'
  | 'hire'
  | 'risk'
  | 'market'
  | 'system'
  | 'user';

export interface FloorEvent {
  id: string;
  kind: EventKind;
  text: string;
  at: number;
  /** Optional confidence badge, 0..1. */
  confidence?: number;
}

// ── Top-level state ────────────────────────────────────────────────────────

export interface FloorState {
  /** Simulated trading day. */
  day: number;
  /** Wall-clock ms since the floor opened. */
  clock: number;
  running: boolean;
  speed: number;
  agents: Agent[];
  market: Record<string, MarketSnapshot>;
  portfolio: Portfolio;
  meeting?: Meeting;
  /** Newest last — the left panel scrolls to the bottom. */
  transcript: Utterance[];
  events: FloorEvent[];
  office: OfficeMap;
  /** USD → INR, live. */
  usdinr: number;
  /** Whether a real Jev key is wired up. */
  jev_live: boolean;
  /** Whether the local voice model answered its last call. */
  voice_live: boolean;
  headcount_target: number;
  teams: TeamInfo[];
  /** Milliseconds until each team is next eligible to meet. */
  next_meeting_in: Record<string, number>;
  desk_mode: DeskMode;
  /** Closed trades, newest first (most recent 100), across restarts. */
  history: TradeRecord[];
  history_stats: HistoryStats;
}

// ── Client → server ────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'say'; text: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'speed'; value: number }
  | { type: 'call_meeting'; symbol: string }
  | { type: 'close_position'; id: string }
  | { type: 'hire'; role: Role }
  | { type: 'desk_mode'; value: DeskMode }
  | { type: 'manual_trade'; symbol: string; side: Side; margin_inr: number; leverage: number };

export type ServerMessage =
  | { type: 'state'; state: FloorState }
  | { type: 'patch'; patch: Partial<FloorState> }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'event'; event: FloorEvent };
