import type { OfficeMap, ZoneKind } from '../../shared/types.js';
import {
  AISLE_OFFSET,
  AISLE_X,
  BREAK_SPOTS,
  CORRIDOR_EDGES,
  CORRIDOR_NODES,
  DESK_ROWS,
  DESKS,
  DOORS,
  MEETING_HEAD,
  MEETING_SEATS,
  MEETING_TABLE,
  OFFICE_H,
  OFFICE_W,
  ZONES,
  zoneAt,
} from '../../shared/layout.js';

/**
 * Server-side view of the floor plan: seat allocation and routing. Geometry
 * lives in shared/layout.ts so the renderer draws furniture exactly where the
 * simulation seats people.
 */

export { CEO_DESK, DESKS, MEETING_HEAD, MEETING_SEATS } from '../../shared/layout.js';

export const OFFICE: OfficeMap = { width: OFFICE_W, height: OFFICE_H, zones: ZONES };

type P = { x: number; y: number };

/**
 * Next free desk, preferring the given team row. Falls back to any free desk on
 * the floor, then to hot-desking in the focus booths.
 */
export function allocateDesk(used: Set<string>, row?: number): P {
  const key = (d: P) => `${d.x},${d.y}`;
  const inRow = row === undefined ? [] : DESKS.filter((d) => d.y === DESK_ROWS[row]);
  for (const d of [...inRow, ...DESKS]) {
    if (!used.has(key(d))) {
      used.add(key(d));
      return d;
    }
  }
  const n = used.size;
  return { x: 20.3 + (n % 3) * 2.3, y: 26.8 };
}

export function meetingSeat(index: number): P {
  const s = MEETING_SEATS[index % MEETING_SEATS.length]!;
  return { x: s.x, y: s.y };
}

export function headSeat(): P {
  return { ...MEETING_HEAD };
}

export function cafeSpot(index: number): P {
  return BREAK_SPOTS[index % BREAK_SPOTS.length]!;
}

// ── Routing ────────────────────────────────────────────────────────────────

const doorOf = (k: ZoneKind) => DOORS.find((d) => d.zone === k);

const near = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y) < 0.05;

/** Trading-floor walkway a point belongs to: seats use the aisle below them. */
function aisleY(p: P): number {
  const row = DESK_ROWS.find((r) => Math.abs(p.y - r) < 0.4);
  if (row !== undefined) return row + AISLE_OFFSET;
  const aisles = DESK_ROWS.map((r) => r + AISLE_OFFSET);
  return aisles.reduce((best, a) => (Math.abs(a - p.y) < Math.abs(best - p.y) ? a : best));
}

/**
 * Waypoints from just inside a room's door to point `p`, ending at `p`.
 * Each room knows how to get around its own furniture.
 */
function entryPath(kind: ZoneKind, p: P): P[] {
  const door = doorOf(kind);
  if (!door) return [p];

  switch (kind) {
    case 'desk': {
      const y = aisleY(p);
      return [
        { x: AISLE_X, y: door.inside.y },
        { x: AISLE_X, y },
        { x: p.x, y },
        p,
      ];
    }
    case 'meeting_room': {
      const t = MEETING_TABLE;
      const topLane = t.y - 2.3;
      const botLane = t.y + t.h + 2.2;
      if (p.y < t.y) return [{ x: 30.8, y: topLane }, { x: p.x, y: topLane }, p];
      if (p.y > t.y + t.h) return [{ x: 30.8, y: botLane }, { x: p.x, y: botLane }, p];
      // Head seats: the far one is reached around the top of the table.
      if (p.x > t.x + t.w / 2) {
        return [{ x: 30.8, y: topLane }, { x: 45.8, y: topLane }, { x: 45.8, y: p.y }, p];
      }
      return [p];
    }
    case 'cafeteria':
      return [{ x: p.x, y: 25.05 }, p];
    case 'ceo_cabin':
      return [{ x: 37.6, y: 5.9 }, { x: 37.6, y: 2.3 }, p];
    default:
      return [p];
  }
}

function dedupe(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) if (!out.length || !near(out[out.length - 1]!, p)) out.push(p);
  return out;
}

function corridorPath(from: string, to: string): P[] {
  if (from === to) return [CORRIDOR_NODES[from]!];
  const adj = new Map<string, string[]>();
  for (const [a, b] of CORRIDOR_EDGES) {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  }
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const n = queue.shift()!;
    if (n === to) break;
    for (const m of adj.get(n) ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        prev.set(m, n);
        queue.push(m);
      }
    }
  }
  const names = [to];
  while (names[0] !== from) {
    const p = prev.get(names[0]!);
    if (!p) break;
    names.unshift(p);
  }
  return names.map((n) => CORRIDOR_NODES[n]!);
}

function nearestNode(p: P): string {
  let best = 'top';
  let bd = Infinity;
  for (const [k, n] of Object.entries(CORRIDOR_NODES)) {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/** Full walking route from `from` to `to`, through doors and corridors. */
export function route(from: P, to: P): P[] {
  const zf = zoneAt(from)?.kind;
  const zt = zoneAt(to)?.kind;
  const df = zf ? doorOf(zf) : undefined;
  const dt = zt ? doorOf(zt) : undefined;
  const pts: P[] = [];

  // Leave the current room: retrace its entry path back to the door.
  if (df) {
    if (zf === zt) {
      if (zf === 'desk') {
        // Same floor: walk the aisles rather than going out and back in.
        const ya = aisleY(from);
        const yb = aisleY(to);
        pts.push({ x: from.x, y: ya });
        if (Math.abs(ya - yb) > 0.01) pts.push({ x: AISLE_X, y: ya }, { x: AISLE_X, y: yb });
        pts.push({ x: to.x, y: yb }, to);
        return dedupe(pts);
      }
      pts.push(...entryPath(zf!, from).slice(0, -1).reverse(), df.inside, ...entryPath(zt!, to));
      return dedupe(pts);
    }
    pts.push(...entryPath(zf!, from).slice(0, -1).reverse(), df.inside);
  }

  const startNode = df ? df.node : nearestNode(from);
  const endNode = dt ? dt.node : nearestNode(to);
  pts.push(...corridorPath(startNode, endNode));

  if (dt) pts.push(dt.inside, ...entryPath(zt!, to));
  else pts.push(to);

  return dedupe(pts).filter((p, i) => i > 0 || !near(p, from));
}

export function stepToward(pos: P, target: P, speed: number): P & { arrived: boolean } {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= speed || dist < 0.05) return { x: target.x, y: target.y, arrived: true };
  return { x: pos.x + (dx / dist) * speed, y: pos.y + (dy / dist) * speed, arrived: false };
}
