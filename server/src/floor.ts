import { randomUUID } from 'node:crypto';
import type {
  Agent,
  Decision,
  DeskMode,
  Fill,
  FloorEvent,
  FloorState,
  Meeting,
  Position,
  Role,
  Side,
  Stance,
  TeamInfo,
  TradeRecord,
  Utterance,
} from '../../shared/types.js';
import { ROLE_LABEL, ROLE_RANK } from '../../shared/types.js';
import { foundingRoster, hireAgent, LEADERSHIP } from './agents.js';
import { assessHiring, chooseActivity, decide, formView, jevIsLive, jevRoute, manage, probeJev, setDeskMode } from './jev.js';
import { displaySymbol, FxFeed, MarketFeed } from './market.js';
import { allocateDesk, cafeSpot, headSeat, meetingSeat, OFFICE, route, stepToward } from './office.js';
import { appendHistory, historyStats, startFreshHistory } from './history.js';
import { PaperBook, STOP_BASIS } from './paper.js';
import { speak, voiceIsLive, warmVoice } from './voice.js';

/** Milliseconds between simulation ticks. Movement and marking happen here. */
const TICK_MS = 250;
/** Market is re-polled this often; the API does not need 4Hz. */
const MARKET_MS = 5_000;
/** One boardroom: minimum gap between any meeting ending and the next starting. */
const MEETING_GAP_MS = 20_000;
/** A desk team can't be pulled into the boardroom again for this long. */
const TEAM_COOLDOWN_MS = 150_000;
/** A team that has gone this long without a setup gets a scheduled review. */
const TEAM_MAX_IDLE_MS = 170_000;
/** Seats on the floor plus the CEO's cabin. */
const MAX_HEADCOUNT = 25;

/** Desk identity per covered symbol. */
const DESK_STYLE: Record<string, { name: string; color: string }> = {
  BTC: { name: 'BTC Desk', color: '#f7931a' },
  ETH: { name: 'ETH Desk', color: '#8c8cf7' },
  SOL: { name: 'SOL Desk', color: '#14c98a' },
};
/** How often the desk reconsiders its headcount. */
const HIRING_INTERVAL_MS = 150_000;

export type Broadcast = (msg: unknown) => void;

export class Floor {
  private agents: Agent[];
  private teams: TeamInfo[];
  /** Closed trades for this run, oldest first. Each restart starts empty. */
  private history: TradeRecord[] = (startFreshHistory(), []);
  private market: MarketFeed;
  private fx = new FxFeed();
  private book: PaperBook;
  private transcript: Utterance[] = [];
  private events: FloorEvent[] = [];
  private meeting?: Meeting;

  private day = 1;
  private started = Date.now();
  private running = true;
  private deskMode: DeskMode = 'normal';
  private speed = 1;

  private lastMarket = 0;
  private lastMeetingEnd = 0;
  private lastHiringCheck = Date.now();
  private meetingRunning = false;
  /** Whether we've already warned about missing price history. */
  private dataWarned = false;
  private meetingCount = 0;
  private meetingTimes: number[] = [];

  /** Owner messages waiting to be injected into the current discussion. */
  private pendingUserInput: string[] = [];

  private timer?: NodeJS.Timeout;

  constructor(
    private symbols: string[],
    startingCapitalInr: number,
    private broadcast: Broadcast,
  ) {
    this.market = new MarketFeed(symbols);
    this.book = new PaperBook(startingCapitalInr, () => this.fx.value);

    // One desk team per covered symbol, up to the three rows on the floor.
    this.teams = symbols.slice(0, 3).map((sym, row) => {
      const base = sym.replace(/USDT$|USD$/, '');
      const style = DESK_STYLE[base] ?? { name: `${base} Desk`, color: '#4da3ff' };
      return {
        id: base.toLowerCase(),
        name: style.name,
        symbol: sym,
        color: style.color,
        lead_id: '',
        row,
        members: [],
        last_meeting: 0,
        meetings: 0,
      };
    });
    this.agents = foundingRoster(this.teams.map((t) => t.id));
    this.book.onClose = (p, f) => this.recordClose(p, f);
    for (const t of this.teams) {
      t.lead_id = this.agents.find((a) => a.team === t.id && a.role === 'team_lead')?.id ?? '';
    }
  }

  /** Persist a closed round trip with who decided it and why it ended. */
  private recordClose(p: Position, f: Fill): void {
    if (f.kind === 'open') return;
    const m = p.meta;
    const rec: TradeRecord = {
      id: p.id + '_' + p.opened,
      symbol: p.symbol,
      side: p.side,
      team: m?.team ?? '',
      opened_at: p.opened,
      closed_at: f.at,
      entry: p.entry,
      exit: f.price,
      stop: p.stop,
      target: p.take_profit,
      notional_usd: p.notional_usd,
      pnl_inr: f.pnl_inr - (m?.entry_fee_inr ?? 0),
      fees_inr: f.fee_inr + (m?.entry_fee_inr ?? 0),
      reason: f.kind,
      decided_by: m?.decided_by ?? 'rules',
      desk_mode: m?.desk_mode ?? this.deskMode,
      confidence: m?.confidence ?? 0,
      size_pct: m?.size_pct ?? 0,
      stop_basis: m?.stop_basis ?? STOP_BASIS,
      leverage: p.leverage,
    };
    this.history.push(rec);
    appendHistory(rec);
  }

  private teamOf(id: string): TeamInfo | undefined {
    return this.teams.find((t) => t.id === id);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.fx.refresh();
    await this.market.warmup();
    await this.market.refresh();
    this.lastMarket = Date.now();
    // Open on a working floor: the first desk is called in ~15s, the others
    // become eligible in turn after it.
    const now = Date.now();
    this.lastMeetingEnd = now - MEETING_GAP_MS;
    this.teams.forEach((t, i) => {
      t.last_meeting = now - TEAM_COOLDOWN_MS + 15_000 + i * 5_000;
    });

    this.emit('system', `Floor open. ${this.agents.length} staff on the desk, covering ${this.symbols.map(displaySymbol).join(', ')}.`);
    if (jevIsLive()) {
      const probe = await probeJev();
      const via = jevRoute === 'gateway' ? 'via Vercel AI Gateway' : 'via TypeSafe';
      this.emit(
        probe.ok ? 'system' : 'risk',
        probe.ok
          ? `Decision engine: Jev live ${via} — ${probe.detail}.`
          : `Jev key rejected ${via}: ${probe.detail}. Running on local fallback.`,
      );
    } else {
      this.emit('system', 'Decision engine: local fallback — add AI_GATEWAY_API_KEY or TYPESAFE_API_KEY in .env for live Jev.');
    }

    void warmVoice().then(() => {
      this.emit(
        'system',
        voiceIsLive()
          ? 'Voice model connected.'
          : 'Voice model unreachable — agents will speak in composed phrasing.',
      );
    });

    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── Tick ─────────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.running) {
      this.push();
      return;
    }

    const now = Date.now();

    if (now - this.lastMarket > MARKET_MS / this.speed) {
      this.lastMarket = now;
      void this.refreshMarket();
    }

    this.moveAgents();

    // Everyone not in the boardroom carries on with their day.
    this.idleBehaviour();
    if (!this.meetingRunning) {
      const call = this.shouldMeet(now);
      if (call) void this.runMeeting(call.team, call.trigger);
    }

    if (now - this.lastHiringCheck > HIRING_INTERVAL_MS / this.speed) {
      this.lastHiringCheck = now;
      void this.considerHiring();
    }

    this.push();
  }

  private async refreshMarket(): Promise<void> {
    await this.market.refresh();
    void this.fx.refresh();

    // Say so when a coin has no price history, rather than let a desk debate
    // an empty tape. Warn once per outage, and once when it recovers.
    const cold = this.symbols.filter((s) => !this.market.isWarm(s));
    if (cold.length > 0 && !this.dataWarned) {
      this.dataWarned = true;
      this.emit('risk', `No price history for ${cold.map(displaySymbol).join(', ')} (${this.market.error ?? 'feed not responding'}). Retrying — those desks won't meet until data is back.`);
    } else if (cold.length === 0 && this.dataWarned) {
      this.dataWarned = false;
      this.emit('system', 'Price history restored for all coins — desks back in session.');
    }

    const snaps = this.market.all();
    const triggered = this.book.mark(snaps);

    for (const f of triggered) {
      const pnl = f.pnl_inr;
      const verb = f.kind === 'stop' ? 'Stopped out of' : 'Target hit on';
      this.emit(
        'trade',
        `${verb} ${f.side.toUpperCase()} ${displaySymbol(f.symbol)} at $${f.price.toFixed(2)} — ${pnl >= 0 ? '+' : ''}${fmtInr(pnl)}`,
      );
      this.creditBackers(f.meeting_id, pnl);
    }
  }

  /** Split a closed trade's P&L across the agents who voted for it. */
  private creditBackers(meetingId: string, pnlInr: number): void {
    const backers = this.agents.filter((a) => a.backedMeetings?.includes(meetingId));
    if (backers.length === 0) return;
    const share = pnlInr / backers.length;
    for (const a of backers) {
      a.pnl_inr += share;
      if (pnlInr > 0) a.calls_won++;
    }
  }

  // ── Movement & idle life ─────────────────────────────────────────────────

  private moveAgents(): void {
    for (const a of this.agents) {
      if (!a.target) continue;
      // Brisk walking pace, in tiles per tick. Leftover distance carries into
      // the next waypoint so corners don't cost a tick each.
      let budget = 0.62 * this.speed;
      let next = stepToward(a, a.target, budget);
      while (next.arrived && a.path && a.path.length > 0) {
        budget -= Math.hypot(next.x - a.x, next.y - a.y);
        a.x = next.x;
        a.y = next.y;
        a.target = a.path.shift();
        next = stepToward(a, a.target!, Math.max(0.01, budget));
      }
      a.x = next.x;
      a.y = next.y;
      if (next.arrived) {
        a.target = undefined;
        a.path = undefined;
        a.dest = undefined;
        if (a.status === 'walking') {
          // Where they were heading decides what they do on arrival.
          a.status = a.arrivalStatus ?? 'working';
          a.arrivalStatus = undefined;
        }
      }
    }
  }

  private send(a: Agent, to: { x: number; y: number }, onArrive: Agent['status']): void {
    // Each person keeps to a slightly different line through corridors, so a
    // group walking together reads as a crowd rather than one stacked sprite.
    const lane = ((parseInt(a.id.replace(/\D/g, ''), 10) || 0) % 7 - 3) * 0.11;
    const path = route({ x: a.x, y: a.y }, to).map((p, i, all) =>
      i < all.length - 1 ? { x: p.x + lane, y: p.y + lane } : { ...p },
    );
    a.dest = { ...to };
    a.target = path.shift() ?? { ...to };
    a.path = path;
    a.status = 'walking';
    a.arrivalStatus = onArrive;
  }

  private idleBehaviour(): void {
    const open = this.book.openPositions.length;
    for (const a of this.agents) {
      // Onboarding wears off after a short settling-in period.
      if (a.status === 'onboarding') {
        if (Math.random() < 0.004 * this.speed) {
          a.status = 'working';
          a.activity = 'Up to speed, watching the tape';
          this.emit('hire', `${a.name} is now live on the desk.`);
        }
        continue;
      }

      if (a.status === 'working') {
        a.fatigue = Math.min(1, a.fatigue + 0.0012 * this.speed);
      } else if (a.status === 'break') {
        a.fatigue = Math.max(0, a.fatigue - 0.006 * this.speed);
        if (a.fatigue < 0.15 && Math.random() < 0.02) {
          this.send(a, a.desk, 'working');
          a.activity = 'Back at the desk';
        }
      }

      // Occasionally re-evaluate what an agent is doing with itself.
      if (
        (a.status === 'working' || a.status === 'idle') &&
        Math.random() < 0.0025 * this.speed
      ) {
        void this.reassign(a, open);
      }
    }
  }

  private async reassign(a: Agent, openPositions: number): Promise<void> {
    const { activity } = await chooseActivity(a, {
      open_positions: openPositions,
      fatigue: a.fatigue,
      minutes_since_meeting: (Date.now() - this.lastMeetingEnd) / 60_000,
    });
    if (a.status === 'in_meeting' || a.status === 'walking') return;

    if (activity === 'break' && a.fatigue > 0.4) {
      const idx = this.agents.filter((x) => x.status === 'break').length;
      this.send(a, cafeSpot(idx), 'break');
      a.activity = 'Coffee break';
    } else if (activity === 'idle') {
      a.status = 'idle';
      a.activity = IDLE_ACTIVITIES[Math.floor(Math.random() * IDLE_ACTIVITIES.length)]!;
    } else {
      if (a.x !== a.desk.x || a.y !== a.desk.y) this.send(a, a.desk, 'working');
      else a.status = 'working';
      a.activity = WORK_ACTIVITIES[Math.floor(Math.random() * WORK_ACTIVITIES.length)]!;
    }
  }

  // ── Meetings ─────────────────────────────────────────────────────────────

  /**
   * Pick which desk team, if any, goes into the boardroom next. A team is
   * eligible once its own cooldown has passed; among eligible teams the one
   * whose symbol shows the strongest setup wins, and a team that has gone too
   * long without a setup gets a scheduled review.
   */
  private shouldMeet(now: number): { team: string; trigger: string } | null {
    if (!this.market.ready) return null;
    if (now - this.lastMeetingEnd < MEETING_GAP_MS / this.speed) return null;

    const eligible = this.teams.filter(
      (t) => now - t.last_meeting >= TEAM_COOLDOWN_MS / this.speed && this.market.isWarm(t.symbol),
    );
    if (eligible.length === 0) return null;

    let best: { team: string; trigger: string; score: number } | null = null;
    for (const t of eligible) {
      const s = this.market.get(t.symbol);
      if (!s) continue;
      const i = s.indicators;
      const triggers: { text: string; score: number }[] = [];
      if (i.rsi14 < 32) triggers.push({ text: `RSI oversold at ${i.rsi14.toFixed(1)}`, score: (32 - i.rsi14) / 10 });
      if (i.rsi14 > 68) triggers.push({ text: `RSI overbought at ${i.rsi14.toFixed(1)}`, score: (i.rsi14 - 68) / 10 });
      if (Math.abs(i.change24h) > 3.5)
        triggers.push({ text: `${i.change24h > 0 ? 'up' : 'down'} ${Math.abs(i.change24h).toFixed(1)}% on the day`, score: Math.abs(i.change24h) / 5 });
      if (i.atr14 > 0 && Math.abs(i.macd_hist) / i.atr14 > 0.35)
        triggers.push({ text: `MACD histogram diverging at ${i.macd_hist.toFixed(2)}`, score: Math.abs(i.macd_hist) / i.atr14 });
      if (i.range_pos > 0.93) triggers.push({ text: 'pressing the top of the 20-bar range', score: 1.1 });
      if (i.range_pos < 0.07) triggers.push({ text: 'sitting on the bottom of the 20-bar range', score: 1.1 });
      for (const tr of triggers) {
        if (!best || tr.score > best.score) best = { team: t.id, trigger: tr.text, score: tr.score };
      }
    }
    if (best && best.score > 0.45) return { team: best.team, trigger: best.trigger };

    const stalest = [...eligible].sort((a, b) => a.last_meeting - b.last_meeting)[0]!;
    if (now - stalest.last_meeting >= TEAM_MAX_IDLE_MS / this.speed) {
      return { team: stalest.id, trigger: 'scheduled review of the book' };
    }
    return null;
  }

  private async runMeeting(teamId: string, trigger: string): Promise<void> {
    if (this.meetingRunning) return;
    const team = this.teamOf(teamId);
    if (!team) return;
    const symbol = team.symbol;
    const snapshot = this.market.get(symbol);
    if (!snapshot) return;

    this.meetingRunning = true;
    this.meetingCount++;
    this.meetingTimes.push(Date.now());
    team.last_meeting = Date.now();
    team.meetings++;

    // The desk team, plus the CEO who makes the call and Risk who signs it
    // off. The MD sits in on roughly half. Everyone else keeps trading.
    const roster = this.agents.filter(
      (a) =>
        a.status !== 'onboarding' &&
        (a.team === teamId ||
          a.role === 'ceo' ||
          a.role === 'risk_manager' ||
          (a.role === 'manager' && Math.random() < 0.5)),
    );
    // Juniors argue first, seniors respond to what they heard.
    const participants = [...roster].sort(
      (a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role],
    );

    const meeting: Meeting = {
      id: `meet_${randomUUID().slice(0, 8)}`,
      symbol,
      team: team.id,
      team_name: team.name,
      trigger,
      phase: 'gathering',
      round: 0,
      max_rounds: 2,
      participants: participants.map((a) => a.id),
      started: Date.now(),
      snapshot,
    };
    this.meeting = meeting;

    const lead =
      participants.find((a) => a.id === team.lead_id) ??
      participants.find((a) => a.team === teamId && a.role === 'team_lead') ??
      participants[participants.length - 1]!;
    this.emit('meeting', `${team.name}: ${lead.name} calls the room on ${displaySymbol(symbol)} — ${trigger}.`);

    // Everyone walks to the boardroom.
    let seat = 0;
    participants.forEach((a) => {
      // The CEO takes the head of the table; everyone else fills in by seniority.
      this.send(a, a.role === 'ceo' ? headSeat() : meetingSeat(seat++), 'in_meeting');
      a.activity = `In session on ${displaySymbol(symbol)}`;
    });

    await this.waitForSeats(participants);

    try {
      meeting.phase = 'opening';
      this.push();

      const local: Utterance[] = [];
      const views = new Map<string, { stance: Stance; conviction: number }>();

      // Opening frame from the lead, so the room has something to argue with.
      await this.turn(meeting, lead, local, views, 'opening', 0);

      meeting.phase = 'debate';
      for (let round = 0; round < meeting.max_rounds; round++) {
        meeting.round = round + 1;
        if (round === 1) meeting.phase = 'rebuttal';

        for (const agent of participants) {
          if (!this.running) break;
          if (agent.id === lead.id && round === 0) continue;
          // The CEO holds their view for the verdict.
          if (agent.role === 'ceo') continue;

          // Quieter staff skip a turn in the rebuttal round.
          if (round === 1 && Math.random() > agent.personality.talkativeness) continue;
          // Never let the same voice land twice consecutively.
          if (local[local.length - 1]?.agent_id === agent.id) continue;

          await this.turn(
            meeting,
            agent,
            local,
            views,
            round === 0 ? 'debate' : 'rebuttal',
            round + 1,
          );
        }
      }

      meeting.phase = 'decision';
      this.push();
      await this.verdict(meeting, participants, local, views);
    } catch (err) {
      this.emit('system', `Meeting aborted: ${String(err)}`);
    } finally {
      meeting.phase = 'done';
      meeting.ended = Date.now();
      this.lastMeetingEnd = Date.now();
      // The team's cooldown runs from when it walks out, not when it walked in,
      // so a long meeting can't be followed straight away by another.
      team.last_meeting = Date.now();
      this.meetingRunning = false;

      // Back to their desks.
      for (const a of participants) {
        if (a.status === 'in_meeting') {
          this.send(a, a.desk, 'working');
          a.activity = 'Writing up the meeting';
        }
      }
      this.push();
      // Leave the record on screen briefly before clearing the banner.
      setTimeout(() => {
        if (this.meeting?.id === meeting.id) {
          this.meeting = undefined;
          this.push();
        }
      }, 6000);
    }
  }

  /** Give people a moment to actually reach the room, but never hang on it. */
  private async waitForSeats(participants: Agent[]): Promise<void> {
    // Walking is routed through the corridors now, so allow a real walk.
    const deadline = Date.now() + 22_000 / this.speed;
    while (Date.now() < deadline) {
      if (participants.every((a) => a.status === 'in_meeting')) return;
      await sleep(200);
    }
    for (const a of participants) {
      if (a.status === 'walking') {
        if (a.dest) {
          a.x = a.dest.x;
          a.y = a.dest.y;
        }
        a.status = 'in_meeting';
        a.target = undefined;
        a.path = undefined;
        a.dest = undefined;
      }
    }
  }

  /** One agent's turn: Jev forms the view, the voice model says it out loud. */
  private async turn(
    meeting: Meeting,
    agent: Agent,
    local: Utterance[],
    views: Map<string, { stance: Stance; conviction: number }>,
    mode: 'opening' | 'debate' | 'rebuttal',
    round: number,
  ): Promise<void> {
    const snapshot = this.market.get(meeting.symbol) ?? meeting.snapshot;
    const userInput = this.drainUserInput();
    const held = this.book.openPositions.find((p) => p.symbol === meeting.symbol);
    const positionLine = held ? this.book.describePosition(held) : undefined;

    const view = await formView(
      agent,
      snapshot,
      local,
      userInput,
      (positionLine ? `OPEN ON THIS COIN: ${positionLine}. ` : '') + this.book.describe(),
    );

    const text = await speak({
      agent,
      snapshot,
      stance: view.stance,
      conviction: view.conviction,
      dissent: view.dissent,
      priors: local,
      userInput,
      mode,
      position: positionLine,
    });

    const u: Utterance = {
      id: `utt_${randomUUID().slice(0, 8)}`,
      meeting_id: meeting.id,
      agent_id: agent.id,
      agent_name: agent.name,
      role: agent.role,
      text,
      stance: view.stance,
      conviction: view.conviction,
      dissent: view.dissent,
      jev: view.jev,
      at: Date.now(),
      round,
      team: meeting.team,
    };

    views.set(agent.id, { stance: view.stance, conviction: view.conviction });
    this.addUtterance(u, local);

    // A beat between speakers so the transcript is readable rather than a dump.
    await sleep(700 / this.speed);
  }

  private async verdict(
    meeting: Meeting,
    participants: Agent[],
    local: Utterance[],
    views: Map<string, { stance: Stance; conviction: number }>,
  ): Promise<void> {
    const ceo = participants.find((a) => a.role === 'ceo') ?? participants[participants.length - 1]!;
    const snapshot = this.market.get(meeting.symbol) ?? meeting.snapshot;

    const tally = { long: 0, short: 0, flat: 0 };
    for (const v of views.values()) tally[v.stance]++;

    // Already holding this coin: the call is what to do with that trade.
    const heldHere = this.book.openPositions.find((p) => p.symbol === meeting.symbol);
    if (heldHere) {
      await this.manageVerdict(meeting, participants, local, views, heldHere, ceo, snapshot, tally);
      return;
    }

    const v = await decide(
      ceo,
      snapshot,
      local,
      tally,
      this.book.describe(),
      this.book.describeRisk(),
    );

    const decision: Decision = {
      action: v.action,
      size_pct: v.size_pct,
      confidence: v.confidence,
      rationale: '',
      tally,
      decided_by: ceo.name,
      jev: v.jev,
    };
    meeting.decision = decision;

    const text = await speak({
      agent: ceo,
      snapshot,
      stance: v.action === 'execute_long' ? 'long' : v.action === 'execute_short' ? 'short' : 'flat',
      conviction: v.confidence,
      dissent: 0,
      priors: local,
      mode: 'verdict',
      verdict: { action: v.action, size_pct: v.size_pct, tally },
    });
    decision.rationale = text;

    this.addUtterance(
      {
        id: `utt_${randomUUID().slice(0, 8)}`,
        meeting_id: meeting.id,
        agent_id: ceo.id,
        agent_name: ceo.name,
        role: ceo.role,
        text,
        stance: v.action === 'execute_long' ? 'long' : v.action === 'execute_short' ? 'short' : 'flat',
        conviction: v.confidence,
        jev: v.jev,
        at: Date.now(),
        round: 99,
        team: meeting.team,
      },
      local,
    );

    for (const a of participants) a.calls++;

    if (v.action === 'stand_down') {
      this.emit('meeting', `No trade on ${displaySymbol(meeting.symbol)}. Room voted ${tally.long}L / ${tally.short}S / ${tally.flat}F.`, v.confidence);
      return;
    }

    const side = v.action === 'execute_long' ? 'long' : 'short';

    // One position per coin. If the desk already holds this side, the verdict
    // confirms the trade rather than stacking a duplicate on top of it.
    const held = this.book.openPositions.find((p) => p.symbol === meeting.symbol && p.side === side);
    if (held) {
      this.emit(
        'meeting',
        `${meeting.team_name} already holds ${side.toUpperCase()} ${displaySymbol(meeting.symbol)} — keeping it, no duplicate trade.`,
        v.confidence,
      );
      return;
    }

    // Only the agents who actually argued this side carry the P&L.
    const backers = [...views.entries()]
      .filter(([, x]) => x.stance === side)
      .map(([id]) => id);

    const res = this.book.open({
      symbol: meeting.symbol,
      side,
      size_pct: v.size_pct,
      leverage: v.leverage,
      snapshot,
      backers,
      meeting_id: meeting.id,
      meta: {
        team: meeting.team,
        decided_by: v.jev ? 'jev' : 'rules',
        desk_mode: this.deskMode,
        confidence: v.confidence,
        size_pct: v.size_pct,
      },
    });

    if (res.rejected) {
      this.emit('risk', `Order blocked by risk limits: ${res.rejected}.`);
      return;
    }
    if (res.position) {
      for (const a of this.agents) {
        if (backers.includes(a.id)) {
          a.backedMeetings = [...(a.backedMeetings ?? []), meeting.id];
        }
      }
      const p = res.position;
      this.emit(
        'trade',
        `EXECUTED ${side.toUpperCase()} ${displaySymbol(p.symbol)} · ${fmtInr(p.margin_inr)} at ${p.leverage}x = ${fmtInr(p.notional_usd * this.fx.value)} @ $${p.entry.toFixed(2)} · stop ${p.stop.toFixed(2)} · target ${p.take_profit.toFixed(2)}`,
        v.confidence,
      );
    }
  }

  /** Hold, close early, or flip an open position, as the CEO decides. */
  private async manageVerdict(
    meeting: Meeting,
    participants: Agent[],
    local: Utterance[],
    views: Map<string, { stance: Stance; conviction: number }>,
    held: Position,
    ceo: Agent,
    snapshot: NonNullable<ReturnType<MarketFeed['get']>>,
    tally: { long: number; short: number; flat: number },
  ): Promise<void> {
    const line = this.book.describePosition(held);
    const m = await manage(ceo, snapshot, local, tally, { side: held.side, line }, this.book.describe());
    const newSide = held.side === 'long' ? 'short' : 'long';
    const size = held.meta?.size_pct ?? 0.04;

    const decision: Decision = {
      action: m.action,
      size_pct: m.action === 'flip' ? size : 0,
      confidence: m.confidence,
      rationale: '',
      tally,
      decided_by: ceo.name,
      jev: m.jev,
    };
    meeting.decision = decision;
    const stance: Stance = m.action === 'hold' ? held.side : m.action === 'close' ? 'flat' : newSide;

    const text = await speak({
      agent: ceo,
      snapshot,
      stance,
      conviction: m.confidence,
      dissent: 0,
      priors: local,
      mode: 'verdict',
      verdict: { action: m.action, size_pct: decision.size_pct, tally },
      position: line,
    });
    decision.rationale = text;
    this.addUtterance(
      {
        id: `utt_${randomUUID().slice(0, 8)}`,
        meeting_id: meeting.id,
        agent_id: ceo.id,
        agent_name: ceo.name,
        role: ceo.role,
        text,
        stance,
        conviction: m.confidence,
        jev: m.jev,
        at: Date.now(),
        round: 99,
        team: meeting.team,
      },
      local,
    );
    for (const a of participants) a.calls++;

    const sym = displaySymbol(held.symbol);
    if (m.action === 'hold') {
      this.emit(
        'meeting',
        `${meeting.team_name} reviewed ${held.side.toUpperCase()} ${sym} (${fmtInr(held.upnl_inr)}) — holding. Stop ${held.stop.toFixed(2)} · target ${held.take_profit.toFixed(2)}.`,
        m.confidence,
      );
      return;
    }

    if (m.action === 'close') {
      const f = this.book.closeById(held.id, this.market.all(), 'desk');
      if (f) {
        this.emit('trade', `${meeting.team_name} closed ${held.side.toUpperCase()} ${sym} early at $${f.price.toFixed(2)} — ${f.pnl_inr >= 0 ? '+' : ''}${fmtInr(f.pnl_inr)}`, m.confidence);
        this.creditBackers(f.meeting_id, f.pnl_inr);
      }
      return;
    }

    // Flip: opening the other side closes this one first.
    const backers = [...views.entries()].filter(([, x]) => x.stance === newSide).map(([id]) => id);
    const res = this.book.open({
      symbol: held.symbol,
      side: newSide,
      size_pct: size,
      leverage: held.leverage,
      snapshot,
      backers,
      meeting_id: meeting.id,
      meta: {
        team: meeting.team,
        decided_by: m.jev ? 'jev' : 'rules',
        desk_mode: this.deskMode,
        confidence: m.confidence,
        size_pct: size,
      },
    });
    for (const f of res.fills) {
      if (f.kind === 'flip') {
        this.emit('trade', `${meeting.team_name} flipped out of ${held.side.toUpperCase()} ${sym} at $${f.price.toFixed(2)} — ${f.pnl_inr >= 0 ? '+' : ''}${fmtInr(f.pnl_inr)}`, m.confidence);
        this.creditBackers(f.meeting_id, f.pnl_inr);
      }
    }
    if (res.rejected) {
      this.emit('risk', `Flip into ${newSide.toUpperCase()} ${sym} blocked by risk limits: ${res.rejected}.`);
      return;
    }
    if (res.position) {
      for (const a of this.agents) if (backers.includes(a.id)) a.backedMeetings = [...(a.backedMeetings ?? []), meeting.id];
      const p = res.position;
      this.emit(
        'trade',
        `EXECUTED ${newSide.toUpperCase()} ${sym} (flip) · $${p.notional_usd.toFixed(0)} notional @ $${p.entry.toFixed(2)} · stop ${p.stop.toFixed(2)} · target ${p.take_profit.toFixed(2)}`,
        m.confidence,
      );
    }
  }

  // ── Hiring ───────────────────────────────────────────────────────────────

  private async considerHiring(): Promise<void> {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    this.meetingTimes = this.meetingTimes.filter((t) => t > hourAgo);

    const idle = this.agents.filter((a) => a.status === 'idle' || a.status === 'break').length;
    const avgFatigue =
      this.agents.reduce((a, b) => a + b.fatigue, 0) / Math.max(1, this.agents.length);

    const res = await assessHiring({
      open_positions: this.book.openPositions.length,
      meetings_last_hour: this.meetingTimes.length,
      symbols_covered: this.symbols.length,
      headcount: this.agents.length,
      idle_agents: idle,
      avg_fatigue: avgFatigue,
      roles_present: [...new Set(this.agents.map((a) => a.role))],
      session_pnl_pct: this.book.snapshot().pnl_today_pct,
    });

    if (!res.hire) return;
    if (this.agents.length >= MAX_HEADCOUNT) return;

    const role = (['quant_analyst', 'research_analyst', 'trader', 'risk_manager', 'compliance', 'team_lead'] as Role[])
      .includes(res.role as Role)
      ? (res.role as Role)
      : 'quant_analyst';

    this.addHire(role, res.confidence);
  }

  private addHire(role: Role, confidence = 0.7): void {
    if (this.agents.length >= MAX_HEADCOUNT) return;
    // Desk roles join the smallest team; risk and compliance join leadership.
    const firmWide = role === 'risk_manager' || role === 'compliance' || role === 'manager';
    const team = firmWide
      ? undefined
      : [...this.teams].sort(
          (a, b) =>
            this.agents.filter((x) => x.team === a.id).length -
            this.agents.filter((x) => x.team === b.id).length,
        )[0];
    const used = new Set(this.agents.map((a) => `${a.desk.x},${a.desk.y}`));
    const desk = allocateDesk(used, team?.row);
    const agent = hireAgent(role, this.agents, this.day, team?.id ?? LEADERSHIP, desk);
    // New starters arrive through reception and walk to their desk.
    agent.x = 6;
    agent.y = 5.2;
    this.agents.push(agent);
    this.send(agent, desk, 'onboarding');
    this.emit(
      'hire',
      `Headcount approved — ${agent.name} joins ${team ? team.name : 'leadership'} as ${ROLE_LABEL[role]}.`,
      confidence,
    );
  }

  // ── Owner input ──────────────────────────────────────────────────────────

  say(text: string): void {
    const clean = text.trim().slice(0, 400);
    if (!clean) return;
    this.pendingUserInput.push(clean);
    const u: Utterance = {
      id: `utt_${randomUUID().slice(0, 8)}`,
      meeting_id: this.meeting?.id ?? 'floor',
      agent_id: 'user',
      agent_name: 'You',
      role: 'user',
      text: clean,
      jev: false,
      at: Date.now(),
      round: this.meeting?.round ?? 0,
      team: this.meeting?.team,
    };
    this.transcript.push(u);
    if (this.transcript.length > 400) this.transcript.shift();
    this.broadcast({ type: 'utterance', utterance: u });
    this.emit('user', `You spoke to the room: "${truncate(clean, 80)}"`);
    this.push();
  }

  /** Owner input is consumed by the next speaker, then cleared. */
  private drainUserInput(): string | undefined {
    if (this.pendingUserInput.length === 0) return undefined;
    const joined = this.pendingUserInput.join(' ');
    this.pendingUserInput = [];
    return joined;
  }

  callMeeting(symbol: string): void {
    if (this.meetingRunning) {
      this.emit('system', 'A discussion is already in session.');
      return;
    }
    const team = this.teams.find((t) => t.symbol === symbol);
    if (!team) return;
    void this.runMeeting(team.id, 'called by the firm owner');
  }

  closePosition(id: string): void {
    const f = this.book.closeById(id, this.market.all());
    if (f) {
      this.emit('trade', `Owner closed ${f.side.toUpperCase()} ${displaySymbol(f.symbol)} at $${f.price.toFixed(2)} — ${f.pnl_inr >= 0 ? '+' : ''}${fmtInr(f.pnl_inr)}`);
      this.creditBackers(f.meeting_id, f.pnl_inr);
      this.push();
    }
  }

  /**
   * A trade the owner places directly. Sized by margin and leverage rather
   * than by conviction, and tagged 'owner' so it never flatters Jev's record.
   */
  ownerTrade(symbol: string, side: Side, marginInr: number, leverage: number): void {
    const snapshot = this.market.get(symbol);
    if (!snapshot) {
      this.emit('risk', `Cannot trade ${symbol} — no live price.`);
      return;
    }
    const lev = Math.max(1, Math.min(25, Math.round(leverage)));
    const margin = Math.max(0, marginInr);
    const res = this.book.open({
      symbol,
      side,
      size_pct: 0,
      snapshot,
      backers: [],
      meeting_id: `owner_${Date.now()}`,
      manual: { margin_inr: margin, leverage: lev },
      meta: {
        team: 'owner',
        decided_by: 'owner',
        desk_mode: this.deskMode,
        confidence: 1,
        size_pct: margin / Math.max(1, this.book.snapshot().equity_inr),
      },
    });
    if (res.rejected) {
      this.emit('risk', `Your order was rejected: ${res.rejected}.`);
      this.push();
      return;
    }
    const p = res.position;
    if (p) {
      this.emit(
        'user',
        `YOUR TRADE — ${side.toUpperCase()} ${displaySymbol(symbol)} · ${fmtInr(margin)} margin at ${lev}x = ${fmtInr(p.notional_usd * this.fx.value)} exposure @ $${p.entry.toFixed(2)} · stop ${p.stop.toFixed(2)} · target ${p.take_profit.toFixed(2)}`,
      );
    }
    this.push();
  }

  hire(role: Role): void {
    this.addHire(role, 1);
    this.push();
  }

  setRunning(v: boolean): void {
    this.running = v;
    this.emit('system', v ? 'Trading resumed.' : 'Floor paused.');
    this.push();
  }

  setDeskMode(m: DeskMode): void {
    if (!['conservative', 'normal', 'aggressive'].includes(m) || m === this.deskMode) return;
    this.deskMode = m;
    setDeskMode(m);
    const blurb: Record<DeskMode, string> = {
      conservative: 'only clear, agreeing signals get traded',
      normal: 'a reasonable lean is enough to trade',
      aggressive: 'any lean gets a small, stop-protected position',
    };
    this.emit('system', `Desk mode set to ${m.toUpperCase()} — ${blurb[m]}.`);
    this.push();
  }

  setSpeed(v: number): void {
    this.speed = Math.min(5, Math.max(0.5, v));
    this.push();
  }

  // ── Emission ─────────────────────────────────────────────────────────────

  private addUtterance(u: Utterance, local: Utterance[]): void {
    local.push(u);
    this.transcript.push(u);
    if (this.transcript.length > 400) this.transcript.shift();
    this.broadcast({ type: 'utterance', utterance: u });
    this.push();
  }

  private emit(kind: FloorEvent['kind'], text: string, confidence?: number): void {
    const e: FloorEvent = {
      id: `ev_${randomUUID().slice(0, 8)}`,
      kind,
      text,
      at: Date.now(),
      confidence,
    };
    this.events.push(e);
    if (this.events.length > 200) this.events.shift();
    this.broadcast({ type: 'event', event: e });
  }

  state(): FloorState {
    return {
      day: this.day,
      clock: Date.now() - this.started,
      running: this.running,
      speed: this.speed,
      agents: this.agents.map((a) => ({ ...a })),
      market: this.market.all(),
      portfolio: this.book.snapshot(),
      meeting: this.meeting,
      transcript: this.transcript.slice(-120),
      events: this.events.slice(-60),
      office: OFFICE,
      usdinr: this.fx.value,
      jev_live: jevIsLive(),
      voice_live: voiceIsLive(),
      headcount_target: this.agents.length,
      desk_mode: this.deskMode,
      history: this.history.slice(-100).reverse(),
      history_stats: historyStats(this.history),
      teams: this.teams.map((t) => ({
        ...t,
        members: this.agents.filter((a) => a.team === t.id).map((a) => a.id),
      })),
      next_meeting_in: Object.fromEntries(
        this.teams.map((t) => [
          t.id,
          Math.max(0, t.last_meeting + TEAM_COOLDOWN_MS / this.speed - Date.now()),
        ]),
      ),
    };
  }

  private push(): void {
    this.broadcast({ type: 'state', state: this.state() });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const WORK_ACTIVITIES = [
  'Refreshing the signal models',
  'Watching order-book depth',
  'Re-running the backtest',
  'Reading the funding curve',
  'Marking the book',
  'Scanning correlated pairs',
  'Updating the risk sheet',
];

const IDLE_ACTIVITIES = [
  'Waiting on the next print',
  'Half-watching the tape',
  'Reading research',
  'Nothing pressing right now',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function fmtInr(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  return `${sign}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}
