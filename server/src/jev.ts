import {
  TypeSafeClient,
  choice,
  noul,
  score,
  type ChoiceCriteria,
  type Questions,
  type ScoreCriteria,
} from '@typesafe-ai/sdk';
import type { Agent, DeskMode, MarketSnapshot, Stance, Utterance } from '../../shared/types.js';
import { ROLE_LABEL } from '../../shared/types.js';

/**
 * The decision layer.
 *
 * Jev is a System One model: unstructured state in, typed probabilistic
 * decisions out. It cannot emit prose — that is voice.ts's job. Every judgement
 * on this floor (stance, conviction, dissent, position size, whether to hire)
 * is a Jev question, so the trading decisions are genuinely model-made rather
 * than rule-made.
 *
 * With no API key the same questions are answered by a local calibrated
 * heuristic, so the floor is always demo-able. `jev` on each answer records
 * which brain actually produced it, and the UI badges it honestly.
 */

let client: TypeSafeClient | null = null;
let clientTried = false;
/** Set when Jev returns an unrecoverable error (bad key, no quota). */
let disabled = false;
let lastError: string | null = null;

/** How Jev is being reached, for the startup log and the UI. */
export let jevRoute: 'typesafe' | 'gateway' | 'none' = 'none';

/**
 * Two ways in: a TypeSafe key talks to TypeSafe directly; a Vercel AI Gateway
 * key (vck_…) goes through the gateway's TypeSafe-compatible endpoint, which
 * accepts the same SDK with a different base URL and model slug.
 */
function getClient(): TypeSafeClient | null {
  if (clientTried) return client;
  clientTried = true;
  const gatewayKey = process.env.AI_GATEWAY_API_KEY?.trim();
  const typesafeKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!gatewayKey && !typesafeKey) return null;
  try {
    client = gatewayKey
      ? new TypeSafeClient({
          apiKey: gatewayKey,
          baseURL: 'https://ai-gateway.vercel.sh/typesafe',
          defaultModel: 'typesafe-ai/jev',
          timeout: 12_000,
          logLevel: 'error',
        })
      : new TypeSafeClient({
          apiKey: typesafeKey,
          defaultModel: process.env.JEV_MODEL?.trim() || 'jev-latest',
          timeout: 12_000,
          logLevel: 'error',
        });
    jevRoute = gatewayKey ? 'gateway' : 'typesafe';
  } catch (err) {
    lastError = String(err);
    client = null;
  }
  return client;
}

export function jevIsLive(): boolean {
  return getClient() !== null && !disabled;
}

export function jevError(): string | null {
  return lastError;
}

/** Ask Jev, or fall back. Never throws — the floor must keep running. */
async function ask<Q extends Questions>(
  state: unknown,
  questions: Q,
  fallback: () => LocalAnswers,
): Promise<{ answers: Record<string, LocalAnswer>; jev: boolean }> {
  const c = getClient();
  if (!c || disabled) return { answers: fallback(), jev: false };
  try {
    const res = await c.systemOne({ state: state as never, questions });
    const out: Record<string, LocalAnswer> = {};
    for (const [k, v] of Object.entries(res.answers as Record<string, unknown>)) {
      const a = v as {
        type: string;
        choice?: string;
        confidence?: number;
        probabilities?: Record<string, number>;
        score?: number;
        noul?: number;
      };
      if (a.type === 'choice') {
        out[k] = {
          kind: 'choice',
          choice: a.choice ?? '',
          confidence: a.confidence ?? 0.5,
          probabilities: a.probabilities ?? {},
        };
      } else if (a.type === 'score') {
        out[k] = {
          kind: 'score',
          score: a.score ?? 0,
          confidence: a.confidence ?? 0.5,
        };
      } else {
        out[k] = { kind: 'noul', noul: a.noul ?? 0.5 };
      }
    }
    lastError = null;
    return { answers: out, jev: true };
  } catch (err) {
    lastError = String(err);
    const msg = lastError.toLowerCase();
    // Auth and quota problems will not fix themselves; stop hammering the API.
    if (msg.includes('authentication') || msg.includes('401') || msg.includes('403')) {
      disabled = true;
    }
    return { answers: fallback(), jev: false };
  }
}

export type LocalAnswer =
  | { kind: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { kind: 'score'; score: number; confidence: number }
  | { kind: 'noul'; noul: number };

type LocalAnswers = Record<string, LocalAnswer>;

// ── Local fallback brain ───────────────────────────────────────────────────

/** Squash any real number into 0..1. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function softmax(xs: number[]): number[] {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/**
 * A directional score in roughly -1..1 from the indicator stack, tilted by the
 * agent's personality. Mean-reversion and trend pull against each other, which
 * is what makes the room disagree.
 */
export function signalScore(s: MarketSnapshot, a: Agent): number {
  const i = s.indicators;

  // Trend following: EMA stack and MACD.
  const emaSpread = i.ema50 > 0 ? (i.ema20 - i.ema50) / i.ema50 : 0;
  const trend = Math.tanh(emaSpread * 120) * 0.6 + Math.tanh(i.macd_hist / (i.atr14 || 1)) * 0.4;

  // Mean reversion: RSI extremes and position in the range.
  const rsiPull = -Math.tanh((i.rsi14 - 50) / 18);
  const rangePull = -(i.range_pos - 0.5) * 2;
  const revert = rsiPull * 0.6 + rangePull * 0.4;

  // Analytical agents weight the systematic trend; intuitive ones fade extremes.
  const w = a.personality.analytical;
  let sig = trend * w + revert * (1 - w) * 0.9;

  // Momentum kicker from the 24h move, scaled by how much vol there is.
  sig += Math.tanh(i.change24h / 6) * 0.25;

  // Contrarians actively lean against the raw signal.
  sig *= 1 - a.personality.contrarianism * 0.8;
  if (a.personality.contrarianism > 0.7) sig = -sig * 0.7 + sig * 0.3;

  // Risk-averse agents shrink toward flat when volatility is elevated.
  if (i.atr_pct > 2.2) sig *= 1 - (1 - a.personality.risk_appetite) * 0.5;

  // A little idiosyncratic noise so the same inputs don't give a scripted room.
  sig += (Math.random() - 0.5) * 0.18;

  return Math.max(-1, Math.min(1, sig));
}

function localDebateAnswers(
  s: MarketSnapshot,
  a: Agent,
  priorStance: Stance | undefined,
): LocalAnswers {
  const sig = signalScore(s, a);
  const i = s.indicators;

  // Flat gets more attractive as the signal weakens and vol rises.
  const modeBias = deskMode === 'conservative' ? 0.35 : deskMode === 'aggressive' ? -0.35 : 0;
  const flatBias = 0.55 - Math.abs(sig) * 1.6 + (i.atr_pct > 2.5 ? 0.35 : 0) + modeBias;
  // Deliberately soft — a peaked softmax makes every agent sound certain, which
  // is both miscalibrated and obviously fake on screen.
  const probs = softmax([sig * 1.7, -sig * 1.7, flatBias]);
  const labels: Stance[] = ['long', 'short', 'flat'];
  let best = 0;
  for (let k = 1; k < 3; k++) if (probs[k]! > probs[best]!) best = k;
  const stance = labels[best]!;

  // Conviction tracks how far the winning branch beat the runner-up, not its
  // raw probability — a 40/35/25 split is a weak view, however you normalise it.
  const sorted = [...probs].sort((x, y) => y - x);
  const margin = sorted[0]! - sorted[1]!;
  const conviction = Math.min(
    0.94,
    Math.max(0.12, (0.32 + margin * 1.5) * (0.78 + a.personality.risk_appetite * 0.34)),
  );

  // Dissent rises with contrarianism and when this agent's stance differs.
  const differs = priorStance !== undefined && priorStance !== stance;
  const dissent = sigmoid(
    (differs ? 1.5 : -1.2) + a.personality.contrarianism * 2.2 - 0.6,
  );

  return {
    stance: {
      kind: 'choice',
      choice: stance,
      confidence: conviction,
      probabilities: { long: probs[0]!, short: probs[1]!, flat: probs[2]! },
    },
    // Report on the rubric's own 0..(levels-1) scale, exactly as Jev would —
    // formView normalises by the rubric length, so any other scale inflates.
    conviction: {
      kind: 'score',
      score: conviction * (CONVICTION_RUBRIC.length - 1),
      confidence: conviction,
    },
    dissent: { kind: 'noul', noul: dissent },
  };
}

// ── State serialisation ────────────────────────────────────────────────────

/** Everything an agent knows when forming a view. This is Jev's `state`. */
function debateState(
  agent: Agent,
  s: MarketSnapshot,
  priors: Utterance[],
  userInput: string | undefined,
  portfolioNote: string,
) {
  const i = s.indicators;
  return {
    you: {
      name: agent.name,
      role: ROLE_LABEL[agent.role],
      mandate: MANDATE[agent.role],
      // Personality in words. Bare 0..1 numbers give Jev nothing to reason
      // with, and every agent collapses to the same answer.
      temperament: temperament(agent),
      background: agent.personality.blurb,
      how_you_read_the_market: LENS[agent.role],
      track_record: `${agent.calls_won}/${agent.calls} calls profitable`,
    },
    desk: deskRules(),
    market: {
      symbol: s.symbol,
      price: s.price,
      spread_bps: Number(s.spread_bps.toFixed(2)),
      change_24h_pct: Number(i.change24h.toFixed(2)),
      rsi_14: Number(i.rsi14.toFixed(1)),
      ema_20: Number(i.ema20.toFixed(2)),
      ema_50: Number(i.ema50.toFixed(2)),
      ema20_above_ema50: i.ema20 > i.ema50,
      macd_histogram: Number(i.macd_hist.toFixed(3)),
      atr_pct_of_price: Number(i.atr_pct.toFixed(2)),
      atr_1h_pct_of_price: Number(i.atr1h_pct.toFixed(2)),
      position_in_20_bar_range_pct: Number((i.range_pos * 100).toFixed(0)),
      realised_vol_annualised_pct: Number(i.vol20.toFixed(1)),
    },
    book: portfolioNote,
    discussion_so_far: priors.slice(-8).map((u) => ({
      speaker: u.agent_name,
      role: u.role === 'user' ? 'Firm owner' : ROLE_LABEL[u.role],
      said: u.text,
      their_stance: u.stance ?? null,
    })),
    owner_instruction: userInput ?? null,
  };
}

let deskMode: DeskMode = 'normal';
export function setDeskMode(m: DeskMode): void {
  deskMode = m;
}

const DESK_BASE =
  'Intraday crypto prop desk. Positions are 2% to 10% of equity, held for minutes to a few hours, ' +
  'and always protected by an automatic stop at 1.2x the 1-hour ATR with a target at 2.0x the 1-hour ATR, so a ' +
  'wrong call is a capped loss and a right one has room to work. Positions may carry leverage of 1x to 10x, which ' +
  'multiplies both the gain and the loss on the capital committed. ';

/**
 * The firm's trading mandate, per desk mode. This is the only thing the mode
 * changes on the Jev side: the rules are stated openly and Jev decides within
 * them, so "flat" means the case wasn't made under today's rules.
 */
const MODE_RULES: Record<DeskMode, string> = {
  conservative:
    'The desk is in CONSERVATIVE mode today: it takes a position only when the signals clearly agree and the ' +
    'risk/reward is clearly favourable. Missing a trade is fine; a poor trade is not. When in doubt, stay flat.',
  normal:
    'The desk is in NORMAL mode: it takes a position whenever there is a reasonable directional lean over the next ' +
    'few hours with acceptable risk/reward; it does not wait for certainty. It stays flat when signals genuinely ' +
    'conflict or when risk/reward is poor.',
  aggressive:
    'The desk is in AGGRESSIVE mode today: it takes a small position whenever there is any directional lean over ' +
    'the next few hours, even a modest one, because the stop caps the loss. It stays flat only when the signals ' +
    'are evenly split with no lean either way.',
};

function deskRules(): string {
  return DESK_BASE + MODE_RULES[deskMode];
}

/** Each seat looks at the same tape through a different lens. */
const LENS: Record<Agent['role'], string> = {
  ceo: 'Weighs the whole room and the firm\'s risk. Backs the side with the stronger argument.',
  manager: 'Looks for trades that can add to desk P&L today; impatient with sitting out when there is a lean.',
  team_lead: 'Synthesises trend (EMA20 vs EMA50, MACD) and position in the range into one call for the desk.',
  quant_analyst: 'Reads the indicator stack: EMA20 vs EMA50 trend, MACD histogram sign and size, and RSI relative to 50.',
  research_analyst: 'Reads the day\'s context: the size of the 24h move, where price sits in its range, and whether the move looks like continuation or exhaustion.',
  trader: 'Reads short-term momentum (MACD histogram, 24h change) and execution: tight spread and deep volume mean a trade is cheap to put on and take off.',
  risk_manager: 'Asks whether the stop-protected risk/reward is acceptable given volatility (ATR) and the open book.',
  compliance: 'Checks exposure and concentration; objects only when a trade would crowd the book.',
};

function temperament(a: Agent): string {
  const p = a.personality;
  const bits: string[] = [];
  bits.push(
    p.risk_appetite > 0.65
      ? 'aggressive — takes a position on moderate evidence'
      : p.risk_appetite < 0.35
        ? 'protective of capital — needs a clearly favourable risk/reward'
        : 'balanced on risk',
  );
  if (p.contrarianism > 0.6) bits.push('contrarian — distrusts whatever the room already agrees on');
  else if (p.contrarianism < 0.3) bits.push('tends to build on the prevailing view');
  bits.push(p.analytical > 0.65 ? 'trusts indicators over narrative' : p.analytical < 0.4 ? 'trades on read and feel over indicators' : 'mixes indicators with judgement');
  return bits.join('; ');
}

const MANDATE: Record<Agent['role'], string> = {
  ceo: 'Final authority. Balances conviction against firm survival. Breaks ties.',
  manager: 'Owns desk P&L. Pushes for trades that clear the return hurdle.',
  team_lead: 'Runs the floor, calls the meetings, synthesises the room.',
  quant_analyst: 'Systematic signals only. Trusts the indicator stack over narrative.',
  research_analyst: 'Regime, flows and structure. Thinks in scenarios, not ticks.',
  trader: 'Execution quality, spread and slippage. Cares how the fill actually gets done.',
  risk_manager: 'Protects capital. Sizes positions and vetoes anything that risks the book.',
  compliance: 'Exposure limits and concentration. The brake, not the engine.',
};

// ── Public brain calls ─────────────────────────────────────────────────────

const STANCE_CRITERIA = {
  long: 'Buy — through your lens, the lean over the next few hours is up and the stop-protected risk/reward is acceptable',
  short: 'Sell — through your lens, the lean over the next few hours is down and the stop-protected risk/reward is acceptable',
  flat: 'No position — through your lens the signals genuinely conflict, or the risk/reward is poor',
} satisfies ChoiceCriteria;

const CONVICTION_RUBRIC = [
  'No conviction — could argue either side equally',
  'Weak lean — would not size this',
  'Moderate — a normal position',
  'Strong — above-average size justified',
  'Very strong — this is the best setup on the board',
] satisfies ScoreCriteria;

export interface DebateView {
  stance: Stance;
  conviction: number;
  dissent: number;
  jev: boolean;
}

/** One agent's typed view on one symbol, given the room so far. */
export async function formView(
  agent: Agent,
  s: MarketSnapshot,
  priors: Utterance[],
  userInput: string | undefined,
  portfolioNote: string,
): Promise<DebateView> {
  const prev = [...priors].reverse().find((u) => u.stance !== undefined);
  const state = debateState(agent, s, priors, userInput, portfolioNote);

  const questions = {
    stance: choice(
      `You are ${agent.name}, ${ROLE_LABEL[agent.role]} (${temperament(agent)}). ` +
        `Reading the tape the way you do — ${LENS[agent.role]} — what intraday position should the desk take on ${s.symbol} right now?`,
      STANCE_CRITERIA,
    ),
    conviction: score('How strong is your conviction in that position?', CONVICTION_RUBRIC),
    dissent: noul(
      'You disagree with the most recent speaker in the discussion and want to push back on them',
      {
        true: 'Your read materially conflicts with what they just argued',
        false: 'You broadly agree with them, or nobody has spoken yet',
      },
    ),
  } satisfies Questions;

  const { answers, jev } = await ask(state, questions, () =>
    localDebateAnswers(s, agent, prev?.stance),
  );

  const st = answers.stance;
  const cv = answers.conviction;
  const ds = answers.dissent;

  const stance: Stance =
    st?.kind === 'choice' && ['long', 'short', 'flat'].includes(st.choice)
      ? (st.choice as Stance)
      : 'flat';

  // Jev's score comes back on the rubric's 0..4 index scale; normalise to 0..1.
  const conviction =
    cv?.kind === 'score'
      ? Math.min(1, Math.max(0.05, cv.score / (CONVICTION_RUBRIC.length - 1)))
      : st?.kind === 'choice'
        ? st.confidence
        : 0.5;

  return {
    stance,
    conviction,
    dissent: ds?.kind === 'noul' ? ds.noul : 0.4,
    jev,
  };
}

const ACTION_CRITERIA = {
  execute_long: 'Open a long position now',
  execute_short: 'Open a short position now',
  stand_down: 'No trade — the room has not made the case',
} satisfies ChoiceCriteria;

const SIZE_RUBRIC = [
  'No size — do not trade',
  'Token size, roughly 2% of equity',
  'Small, roughly 4% of equity',
  'Normal, roughly 6% of equity',
  'Large, roughly 8% of equity',
  'Maximum, roughly 10% of equity — reserved for the highest conviction',
] satisfies ScoreCriteria;

/** Maps each SIZE_RUBRIC level to the fraction of equity it describes. */
const SIZE_LEVELS = [0, 0.02, 0.04, 0.06, 0.08, 0.1];

export interface Verdict {
  action: 'execute_long' | 'execute_short' | 'stand_down';
  size_pct: number;
  /** Multiplier applied to the committed capital, 1–10. */
  leverage: number;
  confidence: number;
  jev: boolean;
}

const LEVERAGE_RUBRIC = [
  'No leverage — 1x, capital only',
  'Light — 2x',
  'Moderate — 3x',
  'Firm — 5x',
  'Heavy — 8x',
  'Maximum — 10x, only for the clearest setup with room to the stop',
] satisfies ScoreCriteria;

const LEVERAGE_LEVELS = [1, 2, 3, 5, 8, 10];

/** The CEO's binding call after the room has argued. */
export async function decide(
  ceo: Agent,
  s: MarketSnapshot,
  transcript: Utterance[],
  tally: { long: number; short: number; flat: number },
  portfolioNote: string,
  riskNote: string,
): Promise<Verdict> {
  const state = {
    you: { name: ceo.name, role: 'CEO', mandate: MANDATE.ceo },
    desk: deskRules(),
    market: debateState(ceo, s, [], undefined, portfolioNote).market,
    book: portfolioNote,
    risk_limits: riskNote,
    vote_tally: tally,
    full_discussion: transcript.map((u) => ({
      speaker: u.agent_name,
      role: u.role === 'user' ? 'Firm owner' : ROLE_LABEL[u.role],
      said: u.text,
      stance: u.stance ?? null,
      conviction: u.conviction ?? null,
    })),
  };

  const questions = {
    action: choice(
      'You are the CEO. The floor has argued. What does the firm do right now?',
      ACTION_CRITERIA,
    ),
    size: score(
      'How much of the firm\'s equity should this trade commit as margin, given the conviction in the room and the volatility?',
      SIZE_RUBRIC,
    ),
    leverage: score(
      'How much leverage should that margin carry? Leverage multiplies both the gain and the loss, and the stop is fixed at 1.2x the 1-hour ATR, so heavy leverage on a wide stop risks a large loss.',
      LEVERAGE_RUBRIC,
    ),
  } satisfies Questions;

  const fallback = (): LocalAnswers => {
    const net = tally.long - tally.short;
    const total = Math.max(1, tally.long + tally.short + tally.flat);
    const margin = Math.abs(net) / total;
    const flatShare = tally.flat / total;
    // Need a real majority and a room that isn't mostly sidelined; how much of
    // one depends on the desk mode.
    const need = deskMode === 'conservative' ? 0.4 : deskMode === 'aggressive' ? 0.12 : 0.25;
    const maxFlat = deskMode === 'conservative' ? 0.45 : deskMode === 'aggressive' ? 0.8 : 0.6;
    const go = margin >= need && flatShare < maxFlat;
    const action = !go ? 'stand_down' : net > 0 ? 'execute_long' : 'execute_short';
    const level = !go ? 0 : Math.min(5, Math.max(1, Math.round(margin * 5 + 0.5)));
    return {
      action: {
        kind: 'choice',
        choice: action,
        confidence: 0.5 + margin * 0.45,
        probabilities: {},
      },
      size: { kind: 'score', score: level, confidence: 0.5 + margin * 0.4 },
      leverage: {
        kind: 'score',
        // Leverage follows the desk's appetite and how one-sided the room is.
        score: !go ? 0 : Math.min(5, Math.round((deskMode === 'aggressive' ? 2.5 : deskMode === 'conservative' ? 0.5 : 1.5) + margin * 2)),
        confidence: 0.5,
      },
    };
  };

  const { answers, jev } = await ask(state, questions, fallback);
  const act = answers.action;
  const sz = answers.size;

  const action =
    act?.kind === 'choice' && act.choice in ACTION_CRITERIA
      ? (act.choice as Verdict['action'])
      : 'stand_down';

  let size_pct = 0;
  if (sz?.kind === 'score') {
    // Interpolate between rubric levels — Jev returns a fractional expected score.
    const lo = Math.floor(sz.score);
    const hi = Math.min(SIZE_LEVELS.length - 1, lo + 1);
    const frac = sz.score - lo;
    size_pct =
      (SIZE_LEVELS[Math.min(lo, SIZE_LEVELS.length - 1)] ?? 0) * (1 - frac) +
      (SIZE_LEVELS[hi] ?? 0) * frac;
  }
  const lv = answers.leverage;
  let leverage = 1;
  if (lv?.kind === 'score') {
    const lo = Math.floor(lv.score);
    const hi = Math.min(LEVERAGE_LEVELS.length - 1, lo + 1);
    const frac = lv.score - lo;
    leverage =
      (LEVERAGE_LEVELS[Math.min(lo, LEVERAGE_LEVELS.length - 1)] ?? 1) * (1 - frac) +
      (LEVERAGE_LEVELS[hi] ?? 1) * frac;
  }
  leverage = Math.max(1, Math.min(10, Math.round(leverage)));

  if (action === 'stand_down') size_pct = 0;
  // Hard cap regardless of what the model says. Risk limits are not negotiable.
  size_pct = Math.min(size_pct, 0.1);

  return {
    action,
    size_pct,
    leverage: action === 'stand_down' ? 1 : leverage,
    confidence: act?.kind === 'choice' ? act.confidence : 0.5,
    jev,
  };
}

/** Does the floor need another head, and in which seat? */
export async function assessHiring(
  workload: {
    open_positions: number;
    meetings_last_hour: number;
    symbols_covered: number;
    headcount: number;
    idle_agents: number;
    avg_fatigue: number;
    roles_present: string[];
    session_pnl_pct: number;
  },
): Promise<{ hire: boolean; role: string; confidence: number; jev: boolean }> {
  const questions = {
    need: noul('The desk is under-staffed for its current workload and should hire', {
      true: 'Agents are saturated, coverage is thin, or a critical seat is missing',
      false: 'Current headcount comfortably covers the workload',
    }),
    role: choice('Which seat would add the most value to this desk right now?', {
      quant_analyst: 'More systematic signal coverage across symbols',
      research_analyst: 'More regime and structure work',
      trader: 'More execution capacity for the open book',
      risk_manager: 'Tighter control of position sizing and drawdown',
      compliance: 'Exposure and concentration oversight',
      team_lead: 'Another pod lead to run parallel discussions',
    }),
  } satisfies Questions;

  const fallback = (): LocalAnswers => {
    const load =
      workload.open_positions / Math.max(1, workload.headcount) +
      workload.meetings_last_hour / 8 +
      workload.avg_fatigue * 0.5 -
      workload.idle_agents * 0.35;
    const p = sigmoid((load - 0.85) * 2.4);
    const missing = ['risk_manager', 'compliance', 'trader', 'quant_analyst'].find(
      (r) => !workload.roles_present.includes(r),
    );
    return {
      need: { kind: 'noul', noul: missing ? Math.max(p, 0.8) : p },
      role: {
        kind: 'choice',
        choice: missing ?? (workload.open_positions > 3 ? 'trader' : 'quant_analyst'),
        confidence: 0.6,
        probabilities: {},
      },
    };
  };

  const { answers, jev } = await ask(workload, questions, fallback);
  const need = answers.need;
  const role = answers.role;
  return {
    hire: need?.kind === 'noul' ? need.noul > 0.66 : false,
    role: role?.kind === 'choice' ? role.choice : 'quant_analyst',
    confidence: need?.kind === 'noul' ? need.noul : 0.5,
    jev,
  };
}

/** What an idle agent chooses to do with itself. Drives the office animation. */
export async function chooseActivity(
  agent: Agent,
  ctx: { open_positions: number; fatigue: number; minutes_since_meeting: number },
): Promise<{ activity: 'work' | 'break' | 'idle'; jev: boolean }> {
  const questions = {
    activity: choice('What should this person do for the next few minutes?', {
      work: 'Stay at the desk, monitor the book and refresh their models',
      break: 'Step away to the cafeteria — they have been heads-down a while',
      idle: 'Hang back at the desk without active work',
    }),
  } satisfies Questions;

  const fallback = (): LocalAnswers => {
    const p = ctx.fatigue > 0.75 ? 'break' : ctx.open_positions > 0 ? 'work' : Math.random() < 0.3 ? 'idle' : 'work';
    return {
      activity: { kind: 'choice', choice: p, confidence: 0.6, probabilities: {} },
    };
  };

  const { answers, jev } = await ask(
    { person: { name: agent.name, role: ROLE_LABEL[agent.role], fatigue: agent.fatigue }, ...ctx },
    questions,
    fallback,
  );
  const a = answers.activity;
  const activity =
    a?.kind === 'choice' && ['work', 'break', 'idle'].includes(a.choice)
      ? (a.choice as 'work' | 'break' | 'idle')
      : 'work';
  return { activity, jev };
}

/**
 * One tiny real call at startup, so a bad or exhausted key shows up in the
 * activity feed immediately instead of the floor quietly running on fallback.
 */
export async function probeJev(): Promise<{ ok: boolean; detail: string }> {
  const c = getClient();
  if (!c) return { ok: false, detail: 'no key configured' };
  try {
    const res = await c.systemOne({
      state: 'BTC is up 5% today on heavy volume.',
      questions: { up: noul('Is the asset up on the day?') },
    });
    const a = res.answers.up as { noul?: number };
    return { ok: true, detail: `${res.model} answered (p=${(a.noul ?? 0).toFixed(2)})` };
  } catch (err) {
    lastError = String(err);
    const msg = lastError.toLowerCase();
    if (msg.includes('authentication') || msg.includes('401') || msg.includes('403')) disabled = true;
    return { ok: false, detail: lastError.slice(0, 160) };
  }
}

const MANAGE_CRITERIA = {
  hold: 'Keep the open position — the case still stands; the stop and target stay where they are',
  close: 'Close the open position now — the case has weakened, or the room no longer backs it',
  flip: 'Close it and reverse into the opposite side — the room now clearly favours the other direction',
} satisfies ChoiceCriteria;

export interface ManageVerdict {
  action: 'hold' | 'close' | 'flip';
  confidence: number;
  jev: boolean;
}

/**
 * The CEO's call when the desk already holds a position on this coin: keep it,
 * cut it, or reverse it. Replaces "open a trade" so meetings manage the book
 * instead of stacking duplicates.
 */
export async function manage(
  ceo: Agent,
  s: MarketSnapshot,
  transcript: Utterance[],
  tally: { long: number; short: number; flat: number },
  position: { side: 'long' | 'short'; line: string },
  portfolioNote: string,
): Promise<ManageVerdict> {
  const state = {
    you: { name: ceo.name, role: 'CEO', mandate: MANAGE_MANDATE },
    desk: deskRules(),
    market: debateState(ceo, s, [], undefined, portfolioNote).market,
    open_position_on_this_coin: position.line,
    book: portfolioNote,
    vote_tally: tally,
    what_the_room_thinks_of_this_trade: roomVerdict(tally, position.side),
    full_discussion: transcript.map((u) => ({
      speaker: u.agent_name,
      role: u.role === 'user' ? 'Firm owner' : ROLE_LABEL[u.role],
      said: u.text,
      stance: u.stance ?? null,
    })),
  };
  const questions = {
    action: choice(
      'You are the CEO. The desk already holds this position. Given the discussion, what do you do with it now?',
      MANAGE_CRITERIA,
    ),
  } satisfies Questions;

  const fallback = (): LocalAnswers => {
    const total = Math.max(1, tally.long + tally.short + tally.flat);
    const same = tally[position.side];
    const opp = position.side === 'long' ? tally.short : tally.long;
    const action =
      opp > same && opp / total >= 0.4 ? 'flip' : tally.flat > same && tally.flat / total >= 0.5 ? 'close' : 'hold';
    return { action: { kind: 'choice', choice: action, confidence: 0.55, probabilities: {} } };
  };

  const { answers, jev } = await ask(state, questions, fallback);
  const a = answers.action;
  const action =
    a?.kind === 'choice' && a.choice in MANAGE_CRITERIA ? (a.choice as ManageVerdict['action']) : 'hold';
  return { action, confidence: a?.kind === 'choice' ? a.confidence : 0.5, jev };
}

const MANAGE_MANDATE =
  'Final authority on the open book, and follows the room it runs: keeps a position the room still backs, ' +
  'closes it when most of the room has gone flat on it, and reverses it when most of the room now favours ' +
  'the other side. A position nobody believes in is not held out of habit.';

/** Spell out what the vote means for the open trade, so it isn't just numbers. */
function roomVerdict(t: { long: number; short: number; flat: number }, side: 'long' | 'short'): string {
  const total = Math.max(1, t.long + t.short + t.flat);
  const same = t[side];
  const opp = side === 'long' ? t.short : t.long;
  const other = side === 'long' ? 'SHORT' : 'LONG';
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  if (opp > same && opp >= t.flat) return `${opp} of ${total} (${pct(opp)}) now favour ${other} — the opposite of the open ${side.toUpperCase()}. Most of the room has turned against this trade.`;
  if (t.flat > same && t.flat >= opp) return `${t.flat} of ${total} (${pct(t.flat)}) now want no position. Most of the room no longer backs this trade.`;
  return `${same} of ${total} (${pct(same)}) still back the open ${side.toUpperCase()}. The room still supports this trade.`;
}
