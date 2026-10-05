import type { Agent, Personality, Role } from '../../shared/types.js';
import { CEO_DESK, DESK_COLS, DESK_ROWS } from '../../shared/layout.js';

/**
 * The staff. Personalities are not decoration — they are fed into Jev as part of
 * the state, so a contrarian risk manager genuinely reaches different typed
 * conclusions from the same tape than an aggressive trader does. That
 * difference is what makes a meeting an argument instead of a chorus.
 *
 * The firm is organised as desk teams — one per covered symbol — plus a
 * leadership group. Each team sits together in one row of the trading floor.
 */

let seq = 0;
const nextId = () => `agent_${++seq}`;

export const LEADERSHIP = 'leadership';

interface Seed {
  name: string;
  role: Role;
  personality: Personality;
}

const P = (
  risk_appetite: number,
  contrarianism: number,
  talkativeness: number,
  analytical: number,
  blurb: string,
): Personality => ({ risk_appetite, contrarianism, talkativeness, analytical, blurb });

const CEO: Seed = {
  name: 'Aarav Mehta',
  role: 'ceo',
  personality: P(0.55, 0.3, 0.5, 0.6,
    'Founded the firm after nine years running a macro book. Listens to the whole room, then decides in one sentence and does not revisit it.'),
};

/** Firm-wide seats. Each sits at the end of one team row. */
const LEADERS: Seed[] = [
  {
    name: 'Kavya Iyer',
    role: 'manager',
    personality: P(0.72, 0.35, 0.7, 0.5,
      'Carries the firm P&L target. Impatient with analysis that does not end in a position. Pushes for size when she smells an edge.'),
  },
  {
    name: 'Kabir Malhotra',
    role: 'risk_manager',
    personality: P(0.18, 0.6, 0.75, 0.8,
      'Paid to say no. Sizes every position against drawdown, not upside. Has killed more trades than anyone else has put on.'),
  },
  {
    name: 'Farah Siddiqui',
    role: 'compliance',
    personality: P(0.15, 0.5, 0.4, 0.75,
      'Watches exposure and concentration limits. Speaks rarely, and when she does the trade usually shrinks.'),
  },
];

/** One roster per desk team, in seat order: lead, quant, research, two traders. */
const TEAMS: Seed[][] = [
  [
    { name: 'Rohan Desai', role: 'team_lead', personality: P(0.5, 0.4, 0.85, 0.65,
      'Runs the desk. Calls the meetings, keeps the argument on the numbers, and summarises where the room actually stands.') },
    { name: 'Rhea Kapoor', role: 'quant_analyst', personality: P(0.6, 0.25, 0.6, 0.95,
      'Pure systematic. Quotes RSI and MACD before she quotes price. Deeply suspicious of anything that cannot be backtested.') },
    { name: 'Ananya Rao', role: 'research_analyst', personality: P(0.5, 0.45, 0.65, 0.4,
      'Thinks in regimes and scenarios rather than indicators. Asks what has to be true for the trade to work, and what breaks it.') },
    { name: 'Zaid Qureshi', role: 'trader', personality: P(0.65, 0.3, 0.5, 0.45,
      'Ten years on an execution desk. Cares about spread, depth and slippage more than the thesis. Will tell you when a good idea is un-fillable.') },
    { name: 'Ishaan Verma', role: 'trader', personality: P(0.82, 0.2, 0.75, 0.3,
      'Young, fast and aggressive. Trades the tape by feel and wants to be in the move before the analysts finish talking.') },
  ],
  [
    { name: 'Meera Joshi', role: 'team_lead', personality: P(0.55, 0.35, 0.8, 0.7,
      'Former sell-side strategist. Frames every meeting around one question and does not let the room drift off it.') },
    { name: 'Vikram Nair', role: 'quant_analyst', personality: P(0.45, 0.75, 0.55, 0.85,
      'The desk contrarian. Enjoys finding the hole in whatever the room has already agreed on. Right about a third of the time, which is enough.') },
    { name: 'Priya Menon', role: 'research_analyst', personality: P(0.45, 0.4, 0.55, 0.55,
      'On-chain and flows specialist. Watches staking, exchange balances and funding before she believes a price move.') },
    { name: 'Arjun Sethi', role: 'trader', personality: P(0.6, 0.35, 0.45, 0.5,
      'Methodical executor. Scales in and out, never fills the whole size at once, and hates chasing.') },
    { name: 'Sana Khatri', role: 'trader', personality: P(0.7, 0.55, 0.65, 0.4,
      'Momentum trader with a short fuse for losers. Happy to flip direction the moment the tape changes its mind.') },
  ],
  [
    { name: 'Devansh Shah', role: 'team_lead', personality: P(0.62, 0.4, 0.8, 0.6,
      'Runs the high-beta desk. Comfortable with volatility, uncomfortable with indecision.') },
    { name: 'Nikhil Bose', role: 'quant_analyst', personality: P(0.55, 0.45, 0.5, 0.9,
      'Volatility modeller. Thinks in realised versus implied, and sizes everything off ATR.') },
    { name: 'Tara Pillai', role: 'research_analyst', personality: P(0.5, 0.5, 0.6, 0.45,
      'Ecosystem analyst. Tracks upgrades, unlocks and narratives, and argues about catalysts more than charts.') },
    { name: 'Omar Ansari', role: 'trader', personality: P(0.58, 0.3, 0.45, 0.5,
      'Liquidity-first execution trader. Knows exactly how much size the book can absorb before it moves.') },
    { name: 'Divya Krishnan', role: 'trader', personality: P(0.75, 0.4, 0.7, 0.35,
      'Scalper. Lives on the five-minute chart and wants tight stops and quick exits.') },
  ],
];

/** Names drawn on for auto-hires, so new staff feel like real people. */
const HIRE_NAMES = [
  'Aditi Chauhan', 'Rudra Ghosh', 'Neel Bhatt', 'Kunal Raina', 'Sneha Kulkarni',
  'Harsh Agarwal', 'Pooja Reddy', 'Aryan Kapoor', 'Nisha Patel', 'Yash Malhotra',
  'Ritika Sen', 'Varun Gupta',
];

/** Personality templates by seat, jittered per hire so no two are identical. */
const ROLE_TEMPLATE: Record<Role, Personality> = {
  ceo: CEO.personality,
  manager: LEADERS[0]!.personality,
  team_lead: P(0.5, 0.4, 0.8, 0.65, 'Runs a pod. Keeps discussions tight and pushes for a decision rather than another round.'),
  quant_analyst: P(0.55, 0.4, 0.55, 0.9, 'Systematic signals across the board. Will not take a view the indicator stack does not support.'),
  research_analyst: P(0.5, 0.45, 0.6, 0.45, 'Works the regime and the structure. More interested in why a move is happening than that it is.'),
  trader: P(0.62, 0.3, 0.5, 0.45, 'Execution first. Judges every idea by whether it can actually be filled at a sane price.'),
  risk_manager: P(0.2, 0.6, 0.7, 0.8, 'Guards the book. Thinks in drawdown and correlation, and is comfortable being the least popular voice.'),
  compliance: P(0.15, 0.5, 0.4, 0.7, 'Watches exposure and concentration limits. Speaks rarely, and when they do the trade usually shrinks.'),
};

function jitter(p: Personality): Personality {
  const j = (v: number) => Math.min(0.97, Math.max(0.05, v + (Math.random() - 0.5) * 0.22));
  return {
    risk_appetite: j(p.risk_appetite),
    contrarianism: j(p.contrarianism),
    talkativeness: j(p.talkativeness),
    analytical: j(p.analytical),
    blurb: p.blurb,
  };
}

function makeAgent(seed: Seed, desk: { x: number; y: number }, team: string, day: number): Agent {
  const n = seq;
  return {
    id: nextId(),
    name: seed.name,
    role: seed.role,
    status: 'working',
    x: desk.x,
    y: desk.y,
    desk,
    team,
    personality: seed.personality,
    pnl_inr: 0,
    calls: 0,
    calls_won: 0,
    fatigue: Math.random() * 0.25,
    hired_on: day,
    activity: 'Reviewing the overnight tape',
    hue: (n * 47) % 360,
  };
}

const seat = (row: number, col: number) => ({ x: DESK_COLS[col]!, y: DESK_ROWS[row]! });

/** Seats 0–4 of a row go to the team, seat 7 to a leader, 5–6 are spare. */
export const LEADER_COL = DESK_COLS.length - 1;

export function foundingRoster(teamIds: string[]): Agent[] {
  const out: Agent[] = [makeAgent(CEO, CEO_DESK, LEADERSHIP, 1)];
  teamIds.forEach((id, row) => {
    const roster = TEAMS[row % TEAMS.length]!;
    roster.forEach((s, col) => out.push(makeAgent(s, seat(row, col), id, 1)));
  });
  LEADERS.forEach((s, row) => out.push(makeAgent(s, seat(row % DESK_ROWS.length, LEADER_COL), LEADERSHIP, 1)));
  return out;
}

/** Build a new hire for a seat, avoiding name collisions with current staff. */
export function hireAgent(
  role: Role,
  existing: Agent[],
  day: number,
  team: string,
  desk: { x: number; y: number },
): Agent {
  const taken = new Set(existing.map((a) => a.name));
  const name =
    HIRE_NAMES.find((n) => !taken.has(n)) ??
    `${HIRE_NAMES[Math.floor(Math.random() * HIRE_NAMES.length)]} ${existing.length}`;
  const agent = makeAgent({ name, role, personality: jitter(ROLE_TEMPLATE[role]) }, desk, team, day);
  // New hires spend their first stretch settling in rather than trading.
  agent.status = 'onboarding';
  agent.activity = 'First day — getting set up';
  return agent;
}
