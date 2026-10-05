import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { HistoryStats, TradeRecord } from '../../shared/types.js';

/**
 * Closed-trade history, one JSON object per line in data/trades.jsonl. Append
 * only, so a crash can at worst lose the line being written, and the file is
 * readable with any text editor or spreadsheet import.
 */

const FILE = resolve(process.cwd(), 'data', 'trades.jsonl');

/**
 * Each run starts with an empty history. The previous run's trades are moved
 * to data/archive/ rather than deleted, so the record is never lost — it just
 * stops showing in the app.
 */
export function startFreshHistory(): void {
  if (!existsSync(FILE)) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = resolve(dirname(FILE), 'archive');
    mkdirSync(dir, { recursive: true });
    renameSync(FILE, resolve(dir, `trades-${stamp}.jsonl`));
  } catch {
    // If the archive move fails, the run still starts; old trades just remain.
  }
}

export function loadHistory(): TradeRecord[] {
  if (!existsSync(FILE)) return [];
  const out: TradeRecord[] = [];
  for (const line of readFileSync(FILE, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TradeRecord);
    } catch {
      // Skip a torn line rather than refuse to start.
    }
  }
  return out;
}

export function appendHistory(rec: TradeRecord): void {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, `${JSON.stringify(rec)}\n`, 'utf-8');
  } catch {
    // History is a record, not a dependency — never take the floor down for it.
  }
}

export function historyStats(all: TradeRecord[]): HistoryStats {
  const side = (xs: TradeRecord[]) => ({
    trades: xs.length,
    wins: xs.filter((t) => t.pnl_inr > 0).length,
    pnl_inr: xs.reduce((a, t) => a + t.pnl_inr, 0),
  });
  const by_reason: Record<string, number> = {};
  for (const t of all) by_reason[t.reason] = (by_reason[t.reason] ?? 0) + 1;
  const mins = all.map((t) => (t.closed_at - t.opened_at) / 60_000);
  return {
    trades: all.length,
    wins: all.filter((t) => t.pnl_inr > 0).length,
    pnl_inr: all.reduce((a, t) => a + t.pnl_inr, 0),
    avg_minutes: mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : 0,
    by_reason,
    jev: side(all.filter((t) => t.decided_by === 'jev')),
    rules: side(all.filter((t) => t.decided_by === 'rules')),
    owner: side(all.filter((t) => t.decided_by === 'owner')),
  };
}
