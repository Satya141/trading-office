import { useEffect, useMemo, useRef, useState } from 'react';
import Office, { initials, roleColor } from './Office.js';
import { useFloor } from './useFloor.js';
import { clock, inr, inrShort, pct, signed, sym, timeOf, usd } from './format.js';
import { ROLE_LABEL, STATUS_LABEL, type Agent, type FloorState, type TradeRecord, type Utterance } from '../../shared/types.js';

export default function App() {
  const { state, connected, latest, send } = useFloor();
  // Must run unconditionally — it drives the speech bubble.
  const speaker = useSpeaker(latest);

  // ?view=office — just the floor, full screen. Made for screen recordings.
  if (new URLSearchParams(location.search).get('view') === 'office') {
    return (
      <div className="stage" style={{ height: '100%' }}>
        {state && <Office state={state} speaker={speaker} />}
        {state && (
          <div className="focus-pnl">
            <span>TODAY&apos;S P&amp;L</span>
            <b className={state.portfolio.pnl_today_inr >= 0 ? 'up' : 'down'}>
              {signed(state.portfolio.pnl_today_inr)}
            </b>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar state={state} connected={connected} send={send} />
      <div className="main">
        <LeftRail state={state} send={send} />
        <div className="col">
          <div className="stage">
            {state ? (
              <Office state={state} speaker={speaker} />
            ) : (
              <div className="empty">Connecting to the floor…</div>
            )}
            {!connected && (
              <div className="offline">
                Lost the connection to the trading floor. Reconnecting…
              </div>
            )}
            <Legend mode={state?.desk_mode} />
          </div>
          <FloorBar state={state} />
        </div>
        <RightRail state={state} send={send} />
      </div>
    </div>
  );
}

/** Show a speech bubble for a few seconds after each new line. */
function useSpeaker(latest: Utterance | null) {
  const [show, setShow] = useState<{ agentId: string; text: string } | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!latest || latest.role === 'user') return;
    setShow({ agentId: latest.agent_id, text: latest.text });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(undefined), 6500);
    return () => clearTimeout(timer.current);
  }, [latest]);

  return show;
}

// ── Top bar ────────────────────────────────────────────────────────────────

function TopBar({
  state,
  connected,
  send,
}: {
  state: FloorState | null;
  connected: boolean;
  send: ReturnType<typeof useFloor>['send'];
}) {
  return (
    <div className="topbar">
      <div className="brand">
        MERIDIAN CAPITAL <span>Autonomous Crypto Desk</span>
      </div>

      <div className="chips">
        <div className={`chip jev ${state?.jev_live ? 'on' : 'off'}`}>
          <i className="dot" />
          {state?.jev_live ? 'Jev live' : 'Jev fallback'}
        </div>
        <div className={`chip ${state?.voice_live ? 'on' : 'off'}`}>
          <i className="dot" />
          {state?.voice_live ? 'Voice model' : 'Voice offline'}
        </div>
        <div className={`chip ${connected ? 'on' : 'off'}`}>
          <i className="dot" />
          {connected ? 'Feed live' : 'Reconnecting'}
        </div>
        {state && (
          <div className="chip">
            USD/INR <b style={{ color: 'var(--text)' }}>{state.usdinr.toFixed(2)}</b>
          </div>
        )}
      </div>

      <div className="spacer" />

      {state && (
        <div className="chip" style={{ fontFamily: 'var(--mono)' }}>
          {clock(state.clock)}
        </div>
      )}

      <div className="ctrl" title="How readily the desks put on risk. Changes the rules Jev decides under.">
        <span className="ctrl-label">Desk mode</span>
        {(['conservative', 'normal', 'aggressive'] as const).map((m) => (
          <button
            key={m}
            className={`btn mode-${m} ${state?.desk_mode === m ? 'active' : ''}`}
            onClick={() => send({ type: 'desk_mode', value: m })}
          >
            {m[0]!.toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Left rail: P&L + discussion ────────────────────────────────────────────

function LeftRail({
  state,
  send,
}: {
  state: FloorState | null;
  send: ReturnType<typeof useFloor>['send'];
}) {
  return (
    <div className="col left">
      <PnL state={state} />
      <Discussion state={state} send={send} />
    </div>
  );
}

function PnL({ state }: { state: FloorState | null }) {
  const p = state?.portfolio;
  const v = p?.pnl_today_inr ?? 0;
  const cls = v > 0.5 ? 'up' : v < -0.5 ? 'down' : 'zero';

  return (
    <div className="section">
      <div className="pnl">
        <div className="pnl-label">Today&apos;s P&amp;L</div>
        <div className={`pnl-value ${cls}`}>{p ? signed(v) : '₹—'}</div>
        <div className="pnl-sub">
          <span className={cls === 'zero' ? '' : cls}>
            {p ? pct(p.pnl_today_pct, 3) : '—'}
          </span>
          <span style={{ color: 'var(--text-faint)' }}>
            on {p ? inrShort(p.starting_capital_inr) : '—'} capital
          </span>
        </div>

        {p && <CapitalBar p={p} />}

        <div className="pnl-grid">
          <div className="pnl-cell">
            <div className="k" title="Closed trades, minus every fee paid so far">Realised · net</div>
            <div
              className="v"
              style={{
                color:
                  (p?.realised_today_inr ?? 0) >= 0 ? 'var(--long)' : 'var(--short)',
              }}
            >
              {p ? signed(p.realised_today_inr, inrShort) : '—'}
            </div>
          </div>
          <div className="pnl-cell">
            <div className="k">Open</div>
            <div
              className="v"
              style={{
                color: (p?.unrealised_inr ?? 0) >= 0 ? 'var(--long)' : 'var(--short)',
              }}
            >
              {p ? signed(p.unrealised_inr, inrShort) : '—'}
            </div>
          </div>
          <div className="pnl-cell">
            <div className="k">Equity</div>
            <div className="v">{p ? inrShort(p.equity_inr) : '—'}</div>
          </div>
          <div className="pnl-cell">
            <div className="k">Win / Loss</div>
            <div className="v">
              {p ? `${p.wins}–${p.losses}` : '—'}
            </div>
          </div>
          <div className="pnl-cell">
            <div className="k">Max DD</div>
            <div className="v" style={{ color: 'var(--warn)' }}>
              {p ? `${p.max_drawdown_pct.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div className="pnl-cell">
            <div className="k">Fees</div>
            <div className="v" style={{ color: 'var(--text-dim)' }}>
              {p ? inrShort(p.fees_inr) : '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Discussion({
  state,
  send,
}: {
  state: FloorState | null;
  send: ReturnType<typeof useFloor>['send'];
}) {
  const [text, setText] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const transcript = state?.transcript ?? [];
  const stuckToBottom = useRef(true);

  // Follow the conversation, but stop hijacking the scroll if the user has
  // deliberately scrolled up to read something earlier.
  useEffect(() => {
    const el = feedRef.current;
    if (el && stuckToBottom.current) el.scrollTop = el.scrollHeight;
  }, [transcript.length]);

  const onScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ type: 'say', text: t });
    setText('');
    stuckToBottom.current = true;
  };

  const meeting = state?.meeting;

  return (
    <div className="section grow">
      <div className="section-head">
        Floor Discussion
        <span className="count">{transcript.length}</span>
      </div>

      {meeting && meeting.phase !== 'done' && (
        <div className="meeting-banner">
          <i className="pulse" />
          <span>
            <b style={{ color: state?.teams.find((t) => t.id === meeting.team)?.color }}>
              {meeting.team_name}
            </b>{' '}
            · <span className="sym">{sym(meeting.symbol)}</span> — {meeting.trigger}
          </span>
          <span className="phase">{meeting.phase.replace('_', ' ')}</span>
        </div>
      )}

      <div className="feed" ref={feedRef} onScroll={onScroll}>
        {transcript.length === 0 && (
          <div className="empty">
            The desk is quiet. A discussion opens when a setup appears — or call one
            yourself from the market list.
          </div>
        )}
        {transcript.map((u) => (
          <Line key={u.id} u={u} team={state?.teams.find((t) => t.id === u.team)} />
        ))}
      </div>

      <div className="composer">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Speak to the room…"
          maxLength={400}
        />
        <button onClick={submit} disabled={!text.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

function Line({
  u,
  team,
}: {
  u: Utterance;
  team?: { name: string; color: string };
}) {
  const isUser = u.role === 'user';
  const isVerdict = u.round === 99;

  return (
    <div className={`utt ${isUser ? 'user' : ''} ${isVerdict ? 'verdict' : ''}`}>
      <div
        className="avatar"
        style={{ background: isUser ? 'var(--accent)' : roleColor(u.role) }}
      >
        {isUser ? 'YOU' : initials(u.agent_name)}
      </div>
      <div className="utt-body">
        <div className="utt-head">
          <span className="utt-name">{u.agent_name}</span>
          {u.role !== 'user' && <span className="utt-role">{ROLE_LABEL[u.role]}</span>}
          {u.stance && (
            <span className={`stance-badge ${u.stance}`}>
              {u.stance.toUpperCase()}
              {u.conviction != null && ` ${Math.round(u.conviction * 100)}%`}
            </span>
          )}
          {u.jev && <span className="jev-tag">JEV</span>}
          {team && (
            <span className="team-tag" style={{ color: team.color, borderColor: team.color }}>
              {team.name.replace(' Desk', '')}
            </span>
          )}
          {(u.dissent ?? 0) > 0.6 && <span className="dissent-mark">▲ pushback</span>}
        </div>
        <div className="utt-text">{u.text}</div>
      </div>
    </div>
  );
}

// ── Centre furniture ───────────────────────────────────────────────────────

function Legend({ mode }: { mode?: FloorState['desk_mode'] }) {
  const items: [string, string][] = [
    ['#22c98a', 'Working'],
    ['#4da3ff', 'In meeting'],
    ['#ffb443', 'Walking'],
    ['#d9a066', 'On break'],
    ['#5c6b87', 'Idle'],
    ['#a78bfa', 'Onboarding'],
  ];
  const aura = mode === 'aggressive' ? '#ff7a1a' : mode === 'conservative' ? '#22c98a' : '#4da3ff';
  return (
    <div className="legend">
      {items.map(([c, l]) => (
        <span key={l}>
          <i style={{ background: c }} />
          {l}
        </span>
      ))}
      {mode && (
        <span style={{ color: aura, fontWeight: 700 }}>
          <i style={{ background: aura, borderRadius: '50%', boxShadow: `0 0 6px ${aura}` }} />
          Aura: {mode}
        </span>
      )}
    </div>
  );
}

function FloorBar({ state }: { state: FloorState | null }) {
  if (!state) return <div className="floorbar">—</div>;
  const counts = state.agents.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div className="floorbar">
      <span>
        <b>{state.agents.length}</b> staff
      </span>
      {Object.entries(counts).map(([k, v]) => (
        <span key={k}>
          {STATUS_LABEL[k as keyof typeof STATUS_LABEL] ?? k}: <b>{v}</b>
        </span>
      ))}
      <span>
        Open positions: <b>{state.portfolio.positions.length}</b>
      </span>
      <span>
        Fills: <b>{state.portfolio.fills.length}</b>
      </span>
    </div>
  );
}

// ── Right rail ─────────────────────────────────────────────────────────────

function RightRail({
  state,
  send,
}: {
  state: FloorState | null;
  send: ReturnType<typeof useFloor>['send'];
}) {
  const markets = useMemo(
    () => Object.values(state?.market ?? {}).sort((a, b) => a.symbol.localeCompare(b.symbol)),
    [state?.market],
  );

  return (
    <div className="col right">
      <div className="section">
        <div className="section-head">Market</div>
        {markets.map((m) => (
          <div
            key={m.symbol}
            className="tick"
            title="Call a discussion on this symbol"
            onClick={() => send({ type: 'call_meeting', symbol: m.symbol })}
          >
            <div className="tick-sym">{sym(m.symbol)}</div>
            <div className="tick-px">{usd(m.price)}</div>
            <div className="tick-meta">
              RSI {m.indicators.rsi14.toFixed(0)} · ATR {m.indicators.atr_pct.toFixed(2)}%
            </div>
            <div
              className={`tick-chg ${m.indicators.change24h >= 0 ? 'up' : 'down'}`}
            >
              {pct(m.indicators.change24h)}
            </div>
          </div>
        ))}
        {markets.length === 0 && <div className="empty">Waiting for the tape…</div>}
      </div>

      <div className="section">
        <div className="section-head">
          Open Positions
          <span className="count">{state?.portfolio.positions.length ?? 0}</span>
        </div>
        {(state?.portfolio.positions ?? []).map((p) => (
          <div key={p.id} className="row pos">
            <span className={`side-tag ${p.side}`}>{p.side.toUpperCase()}</span>
            <span className="pos-sym">
              {sym(p.symbol)}
              {p.leverage > 1 && <i className="lev">{p.leverage}x</i>}
            </span>
            <span
              className="pos-pnl"
              style={{ color: p.upnl_inr >= 0 ? 'var(--long)' : 'var(--short)' }}
            >
              {signed(p.upnl_inr, inrShort)}
            </span>
            <div className="pos-meta">
              <span>in {usd(p.entry)}</span>
              <span>mark {usd(p.mark)}</span>
              <span>${p.notional_usd.toFixed(0)}</span>
              <button className="close-x" onClick={() => send({ type: 'close_position', id: p.id })}>
                CLOSE
              </button>
            </div>
            <Brackets p={p} />
          </div>
        ))}
        {(state?.portfolio.positions.length ?? 0) === 0 && (
          <div className="empty">Flat — no open risk.</div>
        )}
      </div>

      {state && <TradeHistory state={state} />}

      <div className="section">
        <div className="section-head">Activity</div>
        <div className="scroll">
          {[...(state?.events ?? [])].reverse().map((e) => (
            <div key={e.id} className="ev">
              <span className={`ev-kind ${e.kind}`}>{e.kind.toUpperCase()}</span>
              <span>
                <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>
                  {timeOf(e.at)}{' '}
                </span>
                {e.text}
                {e.confidence != null && (
                  <span style={{ color: 'var(--jev)', fontFamily: 'var(--mono)', fontSize: 9.5 }}>
                    {' '}
                    [{Math.round(e.confidence * 100)}%]
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <div className="section-head">Desks</div>
        {(state?.teams ?? []).map((t) => {
          const inSession = state?.meeting?.team === t.id && state.meeting.phase !== 'done';
          const wait = state?.next_meeting_in[t.id] ?? 0;
          return (
            <div key={t.id} className="desk-row">
              <i style={{ background: t.color }} />
              <span className="desk-name">{t.name}</span>
              <span className="desk-meta">{t.members.length} staff · {t.meetings} mtgs</span>
              <span className={`desk-when ${inSession ? 'live' : ''}`}>
                {inSession ? 'IN SESSION' : wait > 0 ? `next in ${Math.ceil(wait / 1000)}s` : 'eligible'}
              </span>
            </div>
          );
        })}
      </div>

      <div className="section">
        <div className="section-head">
          Staff
          <span className="count">{state?.agents.length ?? 0}</span>
        </div>
        <div className="scroll">
          {state &&
            [
              { id: 'leadership', name: 'Leadership', color: '#c9a45b' },
              ...state.teams.map((t) => ({ id: t.id, name: t.name, color: t.color })),
            ].map((g) => {
              const people = state.agents.filter((a) => a.team === g.id);
              if (people.length === 0) return null;
              return (
                <div key={g.id}>
                  <div className="staff-group" style={{ color: g.color }}>
                    {g.name}
                    <span>{people.length}</span>
                  </div>
                  {people.map((a) => (
                    <StaffRow key={a.id} a={a} />
                  ))}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

function StaffRow({ a }: { a: Agent }) {
  return (
    <div className="staff" title={a.activity}>
      <div className="avatar" style={{ background: roleColor(a.role) }}>
        {initials(a.name)}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="staff-name">{a.name}</div>
        <div className="staff-role">
          {ROLE_LABEL[a.role]}
          {a.calls > 0 && ` · ${a.calls_won}/${a.calls}`}
          {Math.abs(a.pnl_inr) > 1 && ` · ${signed(a.pnl_inr, inrShort)}`}
        </div>
      </div>
      <span className={`status-pill ${a.status}`}>{STATUS_LABEL[a.status]}</span>
    </div>
  );
}

/** How much of the starting capital is tied up in open trades right now. */
function CapitalBar({ p }: { p: FloorState['portfolio'] }) {
  const base = p.starting_capital_inr || 1;
  const usedPct = (p.deployed_inr / base) * 100;
  const capPct = Math.min(100, (p.deploy_cap_inr / base) * 100);
  const nearCap = p.deployed_inr >= p.deploy_cap_inr * 0.85;
  return (
    <div className="capital">
      <div className="capital-head">
        <span>Capital used</span>
        <b>
          {inr(p.deployed_inr)} <em>of {inrShort(base)}</em>
        </b>
        <span className="capital-pct">{usedPct.toFixed(1)}%</span>
      </div>
      <div className="capital-bar" title={`Risk limit: at most ${capPct.toFixed(0)}% of capital in open trades at once`}>
        <i style={{ width: `${Math.min(100, usedPct)}%`, background: nearCap ? 'var(--warn)' : 'var(--accent)' }} />
        <span className="capital-cap" style={{ left: `${capPct}%` }} />
      </div>
      <div className="capital-foot">
        {p.positions.length} open {p.positions.length === 1 ? 'trade' : 'trades'} · free {inrShort(Math.max(0, base - p.deployed_inr))} ·
        limit {capPct.toFixed(0)}%
        {p.exposure_inr > p.deployed_inr + 1 && (
          <>
            {' · '}
            <b style={{ color: 'var(--warn)' }}>{inrShort(p.exposure_inr)} exposure</b>
          </>
        )}
      </div>
    </div>
  );
}

/** Closed trades, kept across restarts, with who decided them and why they ended. */
function TradeHistory({ state }: { state: FloorState }) {
  // An older server (mid-restart) won't send history yet; render nothing
  // rather than taking the whole page down.
  if (!state.history_stats || !state.history) return null;
  const st = state.history_stats;
  const rate = (w: number, n: number) => (n ? `${Math.round((w / n) * 100)}%` : '—');
  const mins = (t: TradeRecord) => {
    const m = (t.closed_at - t.opened_at) / 60_000;
    return m < 1 ? `${Math.round(m * 60)}s` : m < 90 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`;
  };
  return (
    <div className="section">
      <div className="section-head">
        Trade History
        <span className="count">{st.trades}</span>
      </div>
      <div className="hist-sum">
        <span>
          Win <b>{rate(st.wins, st.trades)}</b>
        </span>
        <span>
          P&amp;L <b className={st.pnl_inr >= 0 ? 'up' : 'down'}>{signed(st.pnl_inr, inrShort)}</b>
        </span>
        <span>
          <i className="brain jev">JEV</i> {st.jev.trades} · {rate(st.jev.wins, st.jev.trades)}
        </span>
        <span>
          <i className="brain rules">RULES</i> {st.rules.trades} · {rate(st.rules.wins, st.rules.trades)}
        </span>
        {st.owner.trades > 0 && (
          <span>
            <i className="brain owner">YOU</i> {st.owner.trades} · {rate(st.owner.wins, st.owner.trades)}
          </span>
        )}
      </div>
      <div className="scroll">
        {state.history.length === 0 && <div className="empty">No closed trades yet this session.</div>}
        {state.history.map((t) => (
          <div key={t.id} className="hist-row" title={`${t.team.toUpperCase()} desk · ${t.desk_mode} mode · ${Math.round(t.confidence * 100)}% conf · ${(t.size_pct * 100).toFixed(1)}% size · stops ${t.stop_basis}`}>
            <span className={`side-tag ${t.side}`}>{t.side.toUpperCase()}</span>
            <span className="pos-sym">{sym(t.symbol)}</span>
            <span className={`reason ${t.reason}`}>{t.reason.toUpperCase()}</span>
            <span className="hist-dur">{mins(t)}</span>
            <i className={`brain ${t.decided_by}`}>
              {t.decided_by === 'jev' ? 'JEV' : t.decided_by === 'owner' ? 'YOU' : 'RULES'}
            </i>
            <span className="pos-pnl" style={{ color: t.pnl_inr >= 0 ? 'var(--long)' : 'var(--short)' }}>
              {signed(t.pnl_inr, inrShort)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stop-loss and take-profit for an open trade, and where price sits between them. */
function Brackets({ p }: { p: FloorState['portfolio']['positions'][number] }) {
  const away = (lvl: number) => ((Math.abs(lvl - p.mark) / p.mark) * 100).toFixed(2);
  const span = p.side === 'long' ? p.take_profit - p.stop : p.stop - p.take_profit;
  const done = span > 0 ? (p.side === 'long' ? p.mark - p.stop : p.stop - p.mark) / span : 0.5;
  const pos = Math.min(1, Math.max(0, done)) * 100;
  return (
    <div className="brackets">
      <span className="sl">SL {usd(p.stop)} · {away(p.stop)}%</span>
      <span className="tp">TP {usd(p.take_profit)} · {away(p.take_profit)}%</span>
      <div className="bracket-bar" title="Where the price sits between the stop-loss (left) and the take-profit (right)">
        <i style={{ left: `${pos}%` }} />
      </div>
    </div>
  );
}

/** Place a trade yourself, with leverage. Tagged YOU, never counted as Jev's. */
function OwnerTrade({
  state,
  send,
}: {
  state: FloorState;
  send: ReturnType<typeof useFloor>['send'];
}) {
  const symbols = Object.keys(state.market).sort();
  const [symbol, setSymbol] = useState(symbols[0] ?? 'BTCUSDT');
  const [margin, setMargin] = useState('300000');
  const [lev, setLev] = useState('10');
  const m = Number(margin) || 0;
  const l = Number(lev) || 1;
  const price = state.market[symbol]?.price ?? 0;
  const atr1h = state.market[symbol]?.indicators.atr1h_pct ?? 0;
  const risk = m * l * (atr1h * 1.2) / 100;

  const place = (side: 'long' | 'short') =>
    send({ type: 'manual_trade', symbol, side, margin_inr: m, leverage: l });

  return (
    <div className="owner-trade">
      <div className="ot-row">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {symbols.map((s) => (
            <option key={s} value={s}>
              {sym(s)}
            </option>
          ))}
        </select>
        <input value={margin} onChange={(e) => setMargin(e.target.value)} placeholder="margin ₹" inputMode="numeric" />
        <input className="lev-in" value={lev} onChange={(e) => setLev(e.target.value)} placeholder="x" inputMode="numeric" />
        <button className="buy" onClick={() => place('long')}>
          LONG
        </button>
        <button className="sell" onClick={() => place('short')}>
          SHORT
        </button>
      </div>
      <div className="ot-note">
        {inrShort(m)} × {l}x = <b>{inrShort(m * l)}</b> exposure at {usd(price)} · stop risks ≈ {inrShort(risk)}
      </div>
    </div>
  );
}
