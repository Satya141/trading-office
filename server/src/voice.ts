import type { Agent, MarketSnapshot, Stance, Utterance } from '../../shared/types.js';
import { ROLE_LABEL } from '../../shared/types.js';
import { displaySymbol } from './market.js';

/**
 * The voice layer. Jev decides *what* an agent thinks; this turns that typed
 * decision into a line of speech. Runs on local Ollama, so it costs nothing and
 * never rate-limits. If Ollama is down we fall back to composed phrasing built
 * from the same numbers — the floor never goes silent.
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';

export interface VoiceRequest {
  agent: Agent;
  snapshot: MarketSnapshot;
  stance: Stance;
  conviction: number;
  dissent: number;
  /** What was said before, most recent last. Keeps the argument coherent. */
  priors: Utterance[];
  /** Anything the human owner typed into the room. */
  userInput?: string;
  /** 'opening' | 'debate' | 'rebuttal' — changes the rhetorical job. */
  mode: 'opening' | 'debate' | 'rebuttal' | 'verdict';
  /** For the CEO's verdict line. */
  verdict?: { action: string; size_pct: number; tally: Record<string, number> };
  /** The desk's open position on this coin, if any, as one plain line. */
  position?: string;
}

let lastOk = false;
export function voiceIsLive(): boolean {
  return lastOk;
}

/**
 * Each reading is paired with its interpretation. An 8B model left alone with
 * a bare "RSI 47.8" will confidently call it oversold; told it is neutral, it
 * argues about what neutral means instead, which is what a real desk does.
 */
function numbersBlock(s: MarketSnapshot): string {
  const i = s.indicators;
  const rsiRead =
    i.rsi14 < 30 ? 'oversold'
      : i.rsi14 < 45 ? 'soft but not oversold'
        : i.rsi14 <= 55 ? 'neutral'
          : i.rsi14 <= 70 ? 'firm but not overbought'
            : 'overbought';
  const macdRead =
    i.macd_hist > 0 ? 'positive, momentum building' : 'negative, momentum fading';
  const volRead =
    i.atr_pct < 0.5 ? 'very quiet' : i.atr_pct < 1.2 ? 'normal' : i.atr_pct < 2.5 ? 'elevated' : 'wild';
  const rangeRead =
    i.range_pos > 0.8 ? 'near the top of the range'
      : i.range_pos < 0.2 ? 'near the bottom of the range'
        : 'mid-range';

  return [
    `${displaySymbol(s.symbol)} trading $${s.price.toFixed(2)}`,
    `24h change ${i.change24h >= 0 ? '+' : ''}${i.change24h.toFixed(2)}%`,
    `RSI(14) ${i.rsi14.toFixed(1)} — ${rsiRead}`,
    `EMA20 ${i.ema20.toFixed(2)} is ${i.ema20 > i.ema50 ? 'above' : 'below'} EMA50 ${i.ema50.toFixed(2)}`,
    `MACD histogram ${i.macd_hist.toFixed(2)} — ${macdRead}`,
    `ATR ${i.atr_pct.toFixed(2)}% of price — volatility ${volRead}`,
    `price sits ${(i.range_pos * 100).toFixed(0)}% up the 20-bar range — ${rangeRead}`,
    `annualised realised vol ${i.vol20.toFixed(0)}%`,
    `24h quote volume $${(s.volume24h / 1e6).toFixed(1)}m`,
    `spread ${s.spread_bps.toFixed(1)}bps`,
  ].join('; ');
}

function buildPrompt(req: VoiceRequest): string {
  const { agent, snapshot, stance, conviction, dissent, priors, mode } = req;
  const p = agent.personality;

  const traits: string[] = [];
  if (p.risk_appetite > 0.65) traits.push('aggressive with size');
  if (p.risk_appetite < 0.35) traits.push('protective of capital');
  if (p.contrarianism > 0.6) traits.push('happy to take the other side of the room');
  if (p.analytical > 0.65) traits.push('leads with numbers');
  if (p.analytical < 0.35) traits.push('trusts read and tape over indicators');
  if (p.talkativeness > 0.7) traits.push('blunt and quick to interrupt');

  const history = priors
    .slice(-6)
    .map((u) => `${u.agent_name} (${u.role === 'user' ? 'the owner' : ROLE_LABEL[u.role]}): ${u.text}`)
    .join('\n');

  const job =
    mode === 'opening'
      ? 'Open the discussion with your read. State your position and the single number that drives it.'
      : mode === 'rebuttal'
        ? 'This is the rebuttal round. Respond directly to what someone else just said — name them.'
        : mode === 'verdict'
          ? 'You are making the final call for the firm. Be decisive and brief.'
          : 'Add your view. If you disagree with the last speaker, say so directly and say why.';

  const dissentNote =
    dissent > 0.6
      ? 'You DISAGREE with the previous speaker. Push back, by name.'
      : dissent < 0.3 && priors.length > 0
        ? 'You broadly agree with the previous speaker, but add something new — do not just echo them.'
        : '';

  const t = req.verdict?.tally ?? {};
  const votes = `Room voted long ${t.long ?? 0}, short ${t.short ?? 0}, flat ${t.flat ?? 0}.`;
  const act = req.verdict?.action ?? '';
  const verdictNote = !req.verdict
    ? ''
    : act === 'hold'
      ? `Your decision: KEEP the existing position as it is. ${votes}`
      : act === 'close'
        ? `Your decision: CLOSE the existing position now. ${votes}`
        : act === 'flip'
          ? `Your decision: FLIP — close the existing position and reverse into the other side. ${votes}`
          : act === 'stand_down'
            ? `Your decision: NO TRADE. ${votes}`
            : `Your decision: ${act.replace('execute_', '').toUpperCase()} at ${(req.verdict.size_pct * 100).toFixed(1)}% of equity. ${votes}`;

  const positionNote = req.position
    ? `The desk ALREADY HOLDS a position on this coin: ${req.position}. Talk about that trade — whether to keep it, cut it, or reverse it — not just the chart.`
    : '';

  const userNote = req.userInput
    ? `The firm's owner just said in the room: "${req.userInput}". Acknowledge or challenge it — they are the boss but you are paid for your judgement.`
    : '';

  return [
    `You are ${agent.name}, ${ROLE_LABEL[agent.role]} at a crypto proprietary trading firm in Mumbai.`,
    `Your style: ${p.blurb}${traits.length ? ` You are ${traits.join(', ')}.` : ''}`,
    ``,
    `Live tape: ${numbersBlock(snapshot)}`,
    ``,
    history ? `What has been said so far:\n${history}\n` : '',
    `Your position has already been decided: ${stance.toUpperCase()} with ${(conviction * 100).toFixed(0)}% conviction. Do not contradict it.`,
    dissentNote,
    positionNote,
    verdictNote,
    userNote,
    ``,
    job,
    ``,
    `Rules:`,
    `- ONE or TWO sentences, 32 words maximum. Finish your sentence.`,
    `- Speak like a trader on a desk: clipped, specific, no pleasantries, no emoji, no markdown.`,
    `- Cite at most ONE number, copied exactly from the tape above. Never invent a figure that is not listed.`,
    `- Use the interpretation given for each reading. Do not call a neutral RSI oversold.`,
    `- Do not say your conviction percentage.`,
    `Output only the spoken line.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Strip the things small models add no matter how firmly you ask them not to. */
function clean(text: string, agentName: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*|\s*```$/g, '');
  t = t.replace(/^["'“”']+|["'“”']+$/g, '');
  // "Rhea: blah" → "blah". Any speaker label, not just this agent's own name —
  // 8B models happily prefix someone else's name and parrot their line.
  t = t.replace(new RegExp(`^${agentName}\\s*[:\\-–]\\s*`, 'i'), '');
  t = t.replace(/^[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s*(\([^)]*\))?\s*:\s*/, '');
  t = t.replace(/\*\*/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  // Keep it to two sentences even if the model rambled. Split only on
  // punctuation followed by whitespace and a capital — otherwise "-0.06" and
  // "RSI(14) 47.8" get sliced at the decimal point and rejoined as "47. 8".
  const parts = t.split(/(?<=[.!?])\s+(?=["'“]?[A-Z])/);
  if (parts.length > 2) t = parts.slice(0, 2).join(' ').trim();
  if (t.length > 240) {
    // Trim back to the last sentence end that fits, rather than mid-number.
    const cut = t.slice(0, 240);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = lastStop > 80 ? cut.slice(0, lastStop + 1) : `${cut.slice(0, 237).trimEnd()}…`;
  }
  // The generation budget can run out mid-clause. Rather than leave "…near the
  // bottom of" on screen, fall back to the last complete sentence.
  if (!/[.!?…]$/.test(t)) {
    const lastStop = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '));
    if (lastStop > 40) t = t.slice(0, lastStop + 1).trim();
    else t = `${t.replace(/[,;:\s]+$/, '')}…`;
  }
  return t;
}

/**
 * Deterministic phrasing from the same typed decision, used when Ollama is
 * unreachable. Deliberately varied so a demo without the local model still
 * reads like a conversation rather than a stuck record.
 */
function composed(req: VoiceRequest): string {
  const { agent, snapshot: s, stance, dissent, priors } = req;
  const i = s.indicators;
  const sym = displaySymbol(s.symbol);
  const prev = priors[priors.length - 1];
  const disagreeing = dissent > 0.6 && prev && prev.agent_id !== agent.id;

  const evidence = [
    `RSI is ${i.rsi14.toFixed(1)}`,
    `MACD histogram at ${i.macd_hist.toFixed(2)}`,
    `ATR running ${i.atr_pct.toFixed(2)}% of price`,
    `we're ${(i.range_pos * 100).toFixed(0)}% up the 20-bar range`,
    `EMA20 is ${i.ema20 > i.ema50 ? 'above' : 'below'} EMA50`,
    `24h change is ${i.change24h >= 0 ? '+' : ''}${i.change24h.toFixed(2)}%`,
  ];
  const ev = evidence[Math.floor(Math.random() * evidence.length)]!;

  if (req.mode === 'verdict' && req.verdict) {
    const a = req.verdict.action;
    if (a === 'hold') return `We keep the ${sym} position as it is — ${ev}, the stop and target stay.`;
    if (a === 'close') return `We close the ${sym} position now. ${ev.charAt(0).toUpperCase()}${ev.slice(1)} — the case has gone.`;
    if (a === 'flip') return `We flip ${sym}: close it and go the other way. ${ev.charAt(0).toUpperCase()}${ev.slice(1)}.`;
    if (a === 'stand_down') {
      return `Room's too split and ${ev}. We stand down on ${sym} — no trade.`;
    }
    return `Call is ${a === 'execute_long' ? 'LONG' : 'SHORT'} ${sym} at ${(req.verdict.size_pct * 100).toFixed(1)}% of book. ${ev.charAt(0).toUpperCase()}${ev.slice(1)} — we're taking it.`;
  }

  if (disagreeing) {
    const openers = [
      `I'd push back on ${prev.agent_name} there.`,
      `Not how I read it, ${prev.agent_name}.`,
      `${prev.agent_name}, that's the wrong side of this.`,
    ];
    const o = openers[Math.floor(Math.random() * openers.length)]!;
    return stance === 'flat'
      ? `${o} ${ev.charAt(0).toUpperCase()}${ev.slice(1)} — I want no position here.`
      : `${o} ${ev.charAt(0).toUpperCase()}${ev.slice(1)}, that's ${stance} to me on ${sym}.`;
  }

  if (stance === 'flat') {
    return `${ev.charAt(0).toUpperCase()}${ev.slice(1)} — nothing clean on ${sym}. I'm flat.`;
  }
  return `${ev.charAt(0).toUpperCase()}${ev.slice(1)}. I'm ${stance} ${sym} here.`;
}

/** Rough token-overlap similarity, 0..1. Cheap and good enough to spot parroting. */
function similarity(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9.\s-]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const x = norm(a);
  const y = norm(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

export async function speak(req: VoiceRequest): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: buildPrompt(req),
        stream: false,
        options: {
          // Warm enough to sound human, cool enough to stay on-topic.
          temperature: 0.85,
          top_p: 0.9,
          // Enough headroom to finish two sentences; clean() enforces the cap.
          num_predict: 110,
          repeat_penalty: 1.15,
          stop: ['\n\n'],
        },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = (await res.json()) as { response?: string };
    const out = clean(data.response ?? '', req.agent.name);
    if (!out || out.length < 8) throw new Error('empty generation');
    lastOk = true;
    // Small models sometimes echo the previous speaker almost word for word.
    // A repeated line destroys the illusion faster than a plainer one, so fall
    // back to composed phrasing rather than let the parrot through.
    const echoed = req.priors
      .slice(-3)
      .some((p) => similarity(out, p.text) > 0.7);
    if (echoed) return composed(req);
    return out;
  } catch {
    lastOk = false;
    return composed(req);
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget warmup so the first meeting isn't slowed by model load. */
export async function warmVoice(): Promise<void> {
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: 'Say "ready".',
        stream: false,
        options: { num_predict: 5 },
      }),
    });
    lastOk = true;
  } catch {
    lastOk = false;
  }
}
