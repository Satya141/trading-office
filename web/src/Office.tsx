import { useEffect, useRef } from 'react';
import type { Agent, DeskMode, FloorState, MarketSnapshot, Role, Zone } from '../../shared/types.js';
import { ROLE_LABEL, STATUS_LABEL } from '../../shared/types.js';
import {
  BOOTHS,
  CAFE_COUNTER,
  CAFE_SPOTS,
  CAFE_TABLES,
  CEO_DESK,
  CEO_GUEST_CHAIRS,
  CEO_TABLE,
  DESK_BOTTOM,
  DESK_COLS,
  DESK_ROWS,
  DESK_TOP,
  DESK_W,
  DESKS,
  DOORS,
  GLASS_WALLS,
  LOUNGE_SPOTS,
  LOUNGE_TABLE,
  MEETING_CENTER,
  MEETING_SEATS,
  MEETING_TABLE,
  MEETING_TV,
  OFFICE_H,
  OFFICE_W,
  PLANTS,
  POD_SIZE,
  RACKS,
  RECEPTION_DESK,
  VIDEO_WALL,
  ZONES,
} from '../../shared/layout.js';

/**
 * Top-down office renderer.
 *
 * Two layers: a static layer (floors, walls, furniture, lighting) painted once
 * into an offscreen canvas, and a dynamic layer painted every frame (screens,
 * people, speech). People are interpolated between the server's 4Hz position
 * updates so walking reads as continuous motion.
 */

/** Logical pixels per tile. */
const T = 30;
const W = OFFICE_W * T;
const H = OFFICE_H * T;
const X = (v: number) => v * T;
/** People are drawn in their own unit; this sets their size relative to a tile. */
const PS = 1.45;

// ── Small utilities ────────────────────────────────────────────────────────

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lighten (f > 0) or darken (f < 0) a hex colour. */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const t = f < 0 ? 0 : 255;
  const p = Math.abs(f);
  const m = (v: number) => Math.round((t - v) * p + v);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + q, y);
  c.arcTo(x + w, y, x + w, y + h, q);
  c.arcTo(x + w, y + h, x, y + h, q);
  c.arcTo(x, y + h, x, y, q);
  c.arcTo(x, y, x + w, y, q);
  c.closePath();
}

/** Fill a tile-space rounded rect with an optional soft drop shadow. */
function box(
  c: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  fill: string | CanvasGradient,
  opts: { r?: number; shadow?: number; stroke?: string; lw?: number } = {},
) {
  c.save();
  if (opts.shadow) {
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = opts.shadow;
    c.shadowOffsetY = opts.shadow * 0.4;
  }
  c.fillStyle = fill;
  rr(c, X(x), X(y), X(w), X(h), opts.r ?? 3);
  c.fill();
  c.restore();
  if (opts.stroke) {
    c.strokeStyle = opts.stroke;
    c.lineWidth = opts.lw ?? 1;
    rr(c, X(x), X(y), X(w), X(h), opts.r ?? 3);
    c.stroke();
  }
}

function circle(c: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  c.fillStyle = fill;
  c.beginPath();
  c.arc(X(x), X(y), X(r), 0, Math.PI * 2);
  c.fill();
}

// ── Role presentation ──────────────────────────────────────────────────────

/** Accent colour per role, matching the discussion feed avatars. */
export function roleColor(role: string): string {
  switch (role) {
    case 'ceo': return '#c4a6ff';
    case 'manager': return '#ffb443';
    case 'team_lead': return '#4da3ff';
    case 'quant_analyst': return '#22c98a';
    case 'research_analyst': return '#5fd3d3';
    case 'trader': return '#ff9f6d';
    case 'risk_manager': return '#ff5f6d';
    case 'compliance': return '#d98cc4';
    default: return '#8b9ab5';
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

const STATUS_COLOR: Record<string, string> = {
  working: '#22c98a',
  idle: '#8b9ab5',
  in_meeting: '#4da3ff',
  walking: '#ffb443',
  break: '#e0a86a',
  onboarding: '#a78bfa',
};

type Outfit = 'suit' | 'blazer' | 'shirt' | 'hoodie' | 'sweater';
type HairStyle = 'short' | 'long' | 'bun' | 'buzz' | 'curly' | 'side';

interface Look {
  skin: string;
  hair: string;
  style: HairStyle;
  top: string;
  outfit: Outfit;
  pants: string;
  headset: boolean;
}

const SKINS = ['#7a4a2a', '#8d5524', '#a0643b', '#b07a4f', '#c68e63', '#d6a27a', '#e3b892'];
const HAIRS = ['#120e0e', '#1b1411', '#241913', '#2f2118', '#3b2a1e', '#4a3526'];
const STYLES: HairStyle[] = ['short', 'long', 'bun', 'buzz', 'curly', 'side'];

/** Dress code by seat — what that person would plausibly wear to a prop desk. */
const ROLE_WARDROBE: Record<Role, { outfit: Outfit; tops: string[]; headset?: boolean }> = {
  ceo: { outfit: 'suit', tops: ['#353b45', '#2e3a4d'] },
  manager: { outfit: 'blazer', tops: ['#2f4570', '#4a3d6b'] },
  team_lead: { outfit: 'shirt', tops: ['#4f7fb3', '#5b86a8'] },
  quant_analyst: { outfit: 'hoodie', tops: ['#4f6b58', '#6a7280', '#4a5f82'] },
  research_analyst: { outfit: 'sweater', tops: ['#d9d3c7', '#8a6e5a', '#6d7b8c'] },
  trader: { outfit: 'shirt', tops: ['#7b9cc4', '#a9c1dc'], headset: true },
  risk_manager: { outfit: 'blazer', tops: ['#7a3340', '#5a5e6a'] },
  compliance: { outfit: 'blazer', tops: ['#8a7a62', '#6b6f78'] },
};

const lookCache = new Map<string, Look>();
function lookFor(a: Agent): Look {
  const cached = lookCache.get(a.id);
  if (cached) return cached;
  const r = rng(hash(a.name));
  const pick = <V,>(xs: V[]) => xs[Math.floor(r() * xs.length)]!;
  const wr = ROLE_WARDROBE[a.role];
  const look: Look = {
    skin: pick(SKINS),
    hair: a.role === 'ceo' && r() < 0.5 ? '#5d5a57' : pick(HAIRS),
    style: pick(STYLES),
    top: pick(wr.tops),
    outfit: wr.outfit,
    pants: pick(['#1c2029', '#2a2f3a', '#3a3530', '#20252f']),
    headset: !!wr.headset || (a.role === 'quant_analyst' && r() < 0.35),
  };
  lookCache.set(a.id, look);
  return look;
}

// ── Floors ─────────────────────────────────────────────────────────────────

function clipRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  c.beginPath();
  c.rect(X(x), X(y), X(w), X(h));
  c.clip();
}

function planks(
  c: CanvasRenderingContext2D, z: { x: number; y: number; w: number; h: number },
  base: string, seed: number, rowH = 0.32,
) {
  const r = rng(seed);
  c.save();
  clipRect(c, z.x, z.y, z.w, z.h);
  for (let y = z.y; y < z.y + z.h; y += rowH) {
    let x = z.x - r() * 2.5;
    while (x < z.x + z.w) {
      const len = 1.6 + r() * 2.4;
      c.fillStyle = shade(base, (r() - 0.5) * 0.16);
      c.fillRect(X(x), X(y), X(len), X(rowH));
      // Grain.
      c.strokeStyle = 'rgba(0,0,0,0.06)';
      c.lineWidth = 0.6;
      c.beginPath();
      for (let g = 0; g < 2; g++) {
        const gy = y + rowH * (0.3 + g * 0.35 + (r() - 0.5) * 0.1);
        c.moveTo(X(x + 0.1), X(gy));
        c.bezierCurveTo(X(x + len * 0.3), X(gy + 0.02), X(x + len * 0.6), X(gy - 0.02), X(x + len - 0.1), X(gy));
      }
      c.stroke();
      c.fillStyle = 'rgba(0,0,0,0.28)';
      c.fillRect(X(x + len) - 0.6, X(y), 1.2, X(rowH));
      x += len;
    }
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(X(z.x), X(y + rowH) - 0.5, X(z.w), 1);
  }
  c.restore();
}

function carpetTiles(
  c: CanvasRenderingContext2D, z: { x: number; y: number; w: number; h: number },
  base: string, seed: number,
) {
  const r = rng(seed);
  c.save();
  clipRect(c, z.x, z.y, z.w, z.h);
  for (let ty = Math.floor(z.y); ty < z.y + z.h; ty++) {
    for (let tx = Math.floor(z.x); tx < z.x + z.w; tx++) {
      c.fillStyle = shade(base, ((tx + ty) % 2 ? 0.035 : -0.02) + (r() - 0.5) * 0.03);
      c.fillRect(X(tx), X(ty), T, T);
      // Carpet tiles are laid quarter-turned: alternate the pile direction.
      c.strokeStyle = 'rgba(255,255,255,0.028)';
      c.lineWidth = 1;
      c.beginPath();
      for (let k = 1; k < 6; k++) {
        if ((tx + ty) % 2) {
          c.moveTo(X(tx) + (k * T) / 6, X(ty) + 2);
          c.lineTo(X(tx) + (k * T) / 6, X(ty) + T - 2);
        } else {
          c.moveTo(X(tx) + 2, X(ty) + (k * T) / 6);
          c.lineTo(X(tx) + T - 2, X(ty) + (k * T) / 6);
        }
      }
      c.stroke();
    }
  }
  c.restore();
}

function speckled(
  c: CanvasRenderingContext2D, z: { x: number; y: number; w: number; h: number },
  base: string, seed: number, colors: string[], density: number, tile = 0,
) {
  const r = rng(seed);
  c.save();
  clipRect(c, z.x, z.y, z.w, z.h);
  c.fillStyle = base;
  c.fillRect(X(z.x), X(z.y), X(z.w), X(z.h));
  const n = Math.floor(z.w * z.h * density);
  for (let i = 0; i < n; i++) {
    c.fillStyle = colors[Math.floor(r() * colors.length)]!;
    const s = 0.6 + r() * 1.8;
    c.fillRect(X(z.x + r() * z.w), X(z.y + r() * z.h), s, s);
  }
  if (tile > 0) {
    c.strokeStyle = 'rgba(0,0,0,0.12)';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = z.x; x <= z.x + z.w; x += tile) {
      c.moveTo(X(x), X(z.y));
      c.lineTo(X(x), X(z.y + z.h));
    }
    for (let y = z.y; y <= z.y + z.h; y += tile) {
      c.moveTo(X(z.x), X(y));
      c.lineTo(X(z.x + z.w), X(y));
    }
    c.stroke();
  }
  c.restore();
}

function marble(c: CanvasRenderingContext2D, z: Zone, seed: number) {
  const r = rng(seed);
  speckled(c, z, '#c3c7cd', seed, ['#b3b8bf', '#d2d5da'], 30, 2);
  c.save();
  clipRect(c, z.x, z.y, z.w, z.h);
  c.strokeStyle = 'rgba(120,128,140,0.22)';
  c.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    const sx = z.x + r() * z.w;
    const sy = z.y + r() * z.h;
    c.beginPath();
    c.moveTo(X(sx), X(sy));
    c.bezierCurveTo(
      X(sx + 1 + r() * 2), X(sy + (r() - 0.5) * 2),
      X(sx + 2 + r() * 2), X(sy + (r() - 0.5) * 2),
      X(sx + 3 + r() * 3), X(sy + (r() - 0.5) * 3),
    );
    c.stroke();
  }
  c.restore();
}

function raisedFloor(c: CanvasRenderingContext2D, z: Zone) {
  c.save();
  clipRect(c, z.x, z.y, z.w, z.h);
  for (let ty = z.y; ty < z.y + z.h; ty++) {
    for (let tx = z.x; tx < z.x + z.w; tx++) {
      box(c, tx + 0.03, ty + 0.03, 0.94, 0.94, '#555c66', { r: 1 });
      if ((tx * 7 + ty * 3) % 5 === 0) {
        c.fillStyle = 'rgba(0,0,0,0.35)';
        for (let a = 0; a < 5; a++)
          for (let b = 0; b < 5; b++) c.fillRect(X(tx + 0.15 + a * 0.17), X(ty + 0.15 + b * 0.17), 1.6, 1.6);
      }
    }
  }
  c.restore();
}

function rug(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  base: string, border: string,
) {
  box(c, x, y, w, h, base, { r: 2, shadow: 3 });
  c.strokeStyle = border;
  c.lineWidth = 3;
  rr(c, X(x + 0.18), X(y + 0.18), X(w - 0.36), X(h - 0.36), 2);
  c.stroke();
  c.strokeStyle = shade(border, -0.2);
  c.lineWidth = 1;
  rr(c, X(x + 0.32), X(y + 0.32), X(w - 0.64), X(h - 0.64), 2);
  c.stroke();
}

function drawFloors(c: CanvasRenderingContext2D) {
  // Corridor: polished concrete across the whole building.
  const bld = { x: 1, y: 1, w: OFFICE_W - 2, h: OFFICE_H - 2 };
  speckled(c, bld, '#3d4047', 11, ['#44474f', '#373a41', '#4a4d55'], 55, 3);

  for (const z of ZONES) {
    switch (z.kind) {
      case 'desk':
        carpetTiles(c, z, '#2c3444', 21);
        break;
      case 'meeting_room':
        planks(c, z, '#6e5238', 31);
        break;
      case 'ceo_cabin':
        planks(c, z, '#553a28', 41, 0.28);
        break;
      case 'lounge':
        planks(c, z, '#86664a', 51);
        break;
      case 'reception':
        marble(c, z, 61);
        break;
      case 'cafeteria':
        speckled(c, z, '#c2b9aa', 71, ['#8a7f70', '#e2dbcf', '#9aa39b', '#b0795a'], 260, 0);
        break;
      case 'booths':
        carpetTiles(c, z, '#2e3a36', 81);
        break;
      case 'server_room':
        raisedFloor(c, z);
        break;
    }
  }
}

// ── Walls, windows, doors ──────────────────────────────────────────────────

interface Seg { x1: number; y1: number; x2: number; y2: number; glass: boolean }

const WT = 0.24;

function onBoundary(z: Zone, side: string): boolean {
  if (side === 'top') return z.y <= 1;
  if (side === 'left') return z.x <= 1;
  if (side === 'right') return z.x + z.w >= OFFICE_W - 1;
  return z.y + z.h >= OFFICE_H - 1;
}

function interiorWalls(): Seg[] {
  const out: Seg[] = [];
  for (const z of ZONES) {
    const sides = {
      top: [z.x, z.y, z.x + z.w, z.y],
      bottom: [z.x, z.y + z.h, z.x + z.w, z.y + z.h],
      left: [z.x, z.y, z.x, z.y + z.h],
      right: [z.x + z.w, z.y, z.x + z.w, z.y + z.h],
    } as const;
    for (const [side, [x1, y1, x2, y2]] of Object.entries(sides)) {
      if (onBoundary(z, side)) continue;
      const glass = GLASS_WALLS.some((g) => g.zone === z.kind && g.side === side);
      const horiz = y1 === y2;
      const gaps = DOORS.filter((d) => d.zone === z.kind && d.side === side)
        .map((d) => [d.at - d.width / 2, d.at + d.width / 2] as const)
        .sort((a, b) => a[0] - b[0]);
      let start = horiz ? x1 : y1;
      const end = horiz ? x2 : y2;
      for (const [g0, g1] of gaps) {
        if (g0 > start) out.push(horiz ? { x1: start, y1, x2: g0, y2, glass } : { x1, y1: start, x2, y2: g0, glass });
        start = g1;
      }
      if (end > start) out.push(horiz ? { x1: start, y1, x2: end, y2, glass } : { x1, y1: start, x2, y2: end, glass });
    }
  }
  return out;
}

function segRect(s: Seg, t: number) {
  const horiz = s.y1 === s.y2;
  return horiz
    ? { x: s.x1 - t / 2, y: s.y1 - t / 2, w: s.x2 - s.x1 + t, h: t }
    : { x: s.x1 - t / 2, y: s.y1 - t / 2, w: t, h: s.y2 - s.y1 + t };
}

/** Window spans along the outer walls: [side, from, to]. */
const WINDOWS: ['top' | 'bottom' | 'left' | 'right', number, number][] = [
  ['top', 1.6, 10.4], ['top', 13.6, 25.4], ['top', 30.6, 46.4],
  ['left', 9.6, 21.4], ['left', 24.6, 28.4],
  ['right', 1.6, 7.4], ['right', 10.6, 20.4],
  ['bottom', 1.6, 16.4], ['bottom', 19.6, 25.4],
];

function drawWalls(c: CanvasRenderingContext2D) {
  const segs = interiorWalls();
  const OT = 0.42;
  const L = 1;
  const R = OFFICE_W - 1;
  const Tp = 1;
  const B = OFFICE_H - 1;

  // Soft shadow the walls cast onto the floor.
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.55)';
  c.shadowBlur = 10;
  c.shadowOffsetX = 2;
  c.shadowOffsetY = 4;
  c.fillStyle = '#23262c';
  for (const s of segs) {
    if (s.glass) continue;
    const r = segRect(s, WT);
    c.fillRect(X(r.x), X(r.y), X(r.w), X(r.h));
  }
  c.lineWidth = X(OT);
  c.strokeStyle = '#23262c';
  c.strokeRect(X(L), X(Tp), X(R - L), X(B - Tp));
  c.restore();

  // Outer shell: dark concrete band with a light cap.
  c.lineWidth = X(OT);
  c.strokeStyle = '#2b2e35';
  c.strokeRect(X(L), X(Tp), X(R - L), X(B - Tp));
  c.lineWidth = 1.5;
  c.strokeStyle = '#6a707b';
  c.strokeRect(X(L - OT / 2), X(Tp - OT / 2), X(R - L + OT), X(B - Tp + OT));
  c.strokeStyle = '#4b5059';
  c.strokeRect(X(L + OT / 2), X(Tp + OT / 2), X(R - L - OT), X(B - Tp - OT));

  // Windows inset into the shell.
  for (const [side, a, b] of WINDOWS) {
    const horiz = side === 'top' || side === 'bottom';
    const fixed = side === 'top' ? Tp : side === 'bottom' ? B : side === 'left' ? L : R;
    const rx = horiz ? a : fixed - OT / 2 + 0.07;
    const ry = horiz ? fixed - OT / 2 + 0.07 : a;
    const rw = horiz ? b - a : OT - 0.14;
    const rh = horiz ? OT - 0.14 : b - a;
    const g = horiz
      ? c.createLinearGradient(0, X(ry), 0, X(ry + rh))
      : c.createLinearGradient(X(rx), 0, X(rx + rw), 0);
    g.addColorStop(0, '#9cc9e6');
    g.addColorStop(0.5, '#6fa6cc');
    g.addColorStop(1, '#4d7ea3');
    c.fillStyle = g;
    c.fillRect(X(rx), X(ry), X(rw), X(rh));
    c.fillStyle = '#2b2e35';
    for (let m = a; m <= b + 0.01; m += (b - a) / Math.max(1, Math.round((b - a) / 1.6))) {
      if (horiz) c.fillRect(X(m) - 1.5, X(ry), 3, X(rh));
      else c.fillRect(X(rx), X(m) - 1.5, X(rw), 3);
    }
    // Daylight spilling onto the floor inside.
    const inward = side === 'top' ? [0, 1] : side === 'bottom' ? [0, -1] : side === 'left' ? [1, 0] : [-1, 0];
    const depth = 1.6;
    const lx = horiz ? a : side === 'left' ? fixed + OT / 2 : fixed - OT / 2 - depth;
    const ly = horiz ? (side === 'top' ? fixed + OT / 2 : fixed - OT / 2 - depth) : a;
    const lg = c.createLinearGradient(
      X(horiz ? 0 : side === 'left' ? lx : lx + depth), X(horiz ? (side === 'top' ? ly : ly + depth) : 0),
      X(horiz ? 0 : side === 'left' ? lx + depth : lx), X(horiz ? (side === 'top' ? ly + depth : ly) : 0),
    );
    lg.addColorStop(0, 'rgba(190,220,255,0.10)');
    lg.addColorStop(1, 'rgba(190,220,255,0)');
    c.fillStyle = lg;
    c.fillRect(X(lx), X(ly), X(horiz ? b - a : depth), X(horiz ? depth : b - a));
    void inward;
  }

  // Main entrance: glass double doors on the reception's outer wall.
  c.fillStyle = '#3d4047';
  c.fillRect(X(L - OT / 2), X(3.3), X(OT), X(2));
  c.fillStyle = 'rgba(150,200,230,0.55)';
  c.fillRect(X(L - 0.08), X(3.35), 3, X(0.9));
  c.fillRect(X(L - 0.08), X(4.35), 3, X(0.9));
  box(c, 1.25, 3.35, 0.9, 1.9, '#2c2f36', { r: 2 });
  c.fillStyle = '#9aa0aa';
  c.font = `600 ${T * 0.2}px Inter, sans-serif`;
  c.save();
  c.translate(X(0.62), X(4.3));
  c.rotate(-Math.PI / 2);
  c.textAlign = 'center';
  c.fillText('ENTRANCE', 0, 0);
  c.restore();

  // Interior walls.
  for (const s of segs) {
    const r = segRect(s, s.glass ? 0.12 : WT);
    if (s.glass) {
      c.fillStyle = 'rgba(160,210,240,0.30)';
      c.fillRect(X(r.x), X(r.y), X(r.w), X(r.h));
      c.strokeStyle = 'rgba(200,235,255,0.65)';
      c.lineWidth = 1;
      c.strokeRect(X(r.x), X(r.y), X(r.w), X(r.h));
      // Mullions.
      c.fillStyle = '#6f7885';
      const horiz = s.y1 === s.y2;
      const len = horiz ? s.x2 - s.x1 : s.y2 - s.y1;
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i <= n; i++) {
        const t = (horiz ? s.x1 : s.y1) + (len * i) / n;
        if (horiz) c.fillRect(X(t) - 2, X(r.y) - 1, 4, X(r.h) + 2);
        else c.fillRect(X(r.x) - 1, X(t) - 2, X(r.w) + 2, 4);
      }
    } else {
      c.fillStyle = '#d9dce1';
      c.fillRect(X(r.x), X(r.y), X(r.w), X(r.h));
      c.strokeStyle = '#8c929c';
      c.lineWidth = 1;
      c.strokeRect(X(r.x) + 0.5, X(r.y) + 0.5, X(r.w) - 1, X(r.h) - 1);
    }
  }

  // Door leaves with a swing arc.
  for (const d of DOORS) {
    const z = ZONES.find((q) => q.kind === d.zone)!;
    const horiz = d.side === 'top' || d.side === 'bottom';
    const wallPos =
      d.side === 'top' ? z.y : d.side === 'bottom' ? z.y + z.h : d.side === 'left' ? z.x : z.x + z.w;
    const into = d.side === 'top' || d.side === 'left' ? 1 : -1;
    const hx = horiz ? d.at - d.width / 2 : wallPos;
    const hy = horiz ? wallPos : d.at - d.width / 2;
    if (d.glass) {
      c.fillStyle = 'rgba(160,210,240,0.45)';
      if (horiz) {
        c.fillRect(X(hx - 0.35), X(wallPos) - 2, X(0.5), 4);
        c.fillRect(X(hx + d.width - 0.15), X(wallPos) - 2, X(0.5), 4);
      } else {
        c.fillRect(X(wallPos) - 2, X(hy - 0.35), 4, X(0.5));
        c.fillRect(X(wallPos) - 2, X(hy + d.width - 0.15), 4, X(0.5));
      }
      continue;
    }
    c.strokeStyle = 'rgba(210,215,222,0.35)';
    c.setLineDash([3, 3]);
    c.lineWidth = 1;
    c.beginPath();
    if (horiz) c.arc(X(hx), X(hy), X(d.width), into > 0 ? 0 : -Math.PI / 2, into > 0 ? Math.PI / 2 : 0);
    else c.arc(X(hx), X(hy), X(d.width), into > 0 ? 0 : Math.PI / 2, into > 0 ? Math.PI / 2 : Math.PI);
    c.stroke();
    c.setLineDash([]);
    c.strokeStyle = '#b9a07a';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(X(hx), X(hy));
    if (horiz) c.lineTo(X(hx), X(hy + into * d.width));
    else c.lineTo(X(hx + into * d.width), X(hy));
    c.stroke();
  }
}

// ── Furniture ──────────────────────────────────────────────────────────────

/** Top-down office chair. `ang` is the direction the sitter faces. */
function chair(
  c: CanvasRenderingContext2D, x: number, y: number, ang: number,
  color = '#2c3038', big = false,
) {
  const s = big ? 1.18 : 1;
  c.save();
  c.translate(X(x), X(y));
  c.rotate(ang + Math.PI / 2);
  c.scale(s, s);
  // Five-star base with casters.
  c.strokeStyle = '#1a1c21';
  c.lineWidth = 2.2;
  c.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    c.moveTo(0, 0);
    c.lineTo(Math.cos(a) * T * 0.3, Math.sin(a) * T * 0.3);
  }
  c.stroke();
  c.fillStyle = '#101115';
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    c.beginPath();
    c.arc(Math.cos(a) * T * 0.3, Math.sin(a) * T * 0.3, 1.8, 0, Math.PI * 2);
    c.fill();
  }
  // Seat.
  c.shadowColor = 'rgba(0,0,0,0.5)';
  c.shadowBlur = 4;
  c.shadowOffsetY = 2;
  c.fillStyle = color;
  rr(c, -T * 0.25, -T * 0.22, T * 0.5, T * 0.46, T * 0.12);
  c.fill();
  c.shadowColor = 'transparent';
  c.fillStyle = shade(color.startsWith('#') ? color : '#2c3038', 0.1);
  rr(c, -T * 0.2, -T * 0.17, T * 0.4, T * 0.3, T * 0.1);
  c.fill();
  // Backrest behind the sitter, armrests at the sides.
  c.fillStyle = shade(color.startsWith('#') ? color : '#2c3038', -0.25);
  rr(c, -T * 0.29, T * 0.2, T * 0.58, T * 0.15, T * 0.07);
  c.fill();
  c.fillStyle = '#1d2026';
  rr(c, -T * 0.31, -T * 0.12, T * 0.07, T * 0.28, 2);
  c.fill();
  rr(c, T * 0.24, -T * 0.12, T * 0.07, T * 0.28, 2);
  c.fill();
  c.restore();
}

function plant(c: CanvasRenderingContext2D, x: number, y: number, big = false, seed = 1) {
  const r = rng(seed);
  const s = big ? 1.35 : 1;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.5)';
  c.shadowBlur = 6;
  c.shadowOffsetY = 3;
  circle(c, x, y, 0.26 * s, '#e4e1da');
  c.restore();
  circle(c, x, y, 0.2 * s, '#3b2a1e');
  const n = big ? 11 : 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.5;
    const len = (0.3 + r() * 0.2) * s;
    c.save();
    c.translate(X(x), X(y));
    c.rotate(a);
    c.fillStyle = i % 3 === 0 ? '#3f8a55' : i % 3 === 1 ? '#2f6f45' : '#4f9d62';
    c.beginPath();
    c.ellipse(X(len * 0.55), 0, X(len * 0.55), X(0.1 * s), 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.25)';
    c.lineWidth = 0.7;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(X(len), 0);
    c.stroke();
    c.restore();
  }
  circle(c, x, y, 0.1 * s, '#5aad6c');
}

function mug(c: CanvasRenderingContext2D, x: number, y: number, col: string) {
  circle(c, x, y, 0.1, col);
  circle(c, x, y, 0.07, '#3b2417');
  c.strokeStyle = col;
  c.lineWidth = 2;
  c.beginPath();
  c.arc(X(x + 0.11), X(y), 2.5, -1.2, 1.2);
  c.stroke();
}

function keyboard(c: CanvasRenderingContext2D, x: number, y: number, w = 0.9) {
  box(c, x - w / 2, y - 0.13, w, 0.26, '#2a2d33', { r: 2, shadow: 2 });
  c.fillStyle = '#4a4f58';
  for (let row = 0; row < 3; row++)
    for (let k = 0; k < 12; k++)
      c.fillRect(X(x - w / 2 + 0.05 + k * ((w - 0.1) / 12)), X(y - 0.09 + row * 0.07), X((w - 0.1) / 12) - 1, 1.6);
}

function tradingDesks(c: CanvasRenderingContext2D) {
  for (const y of DESK_ROWS) {
    for (const pod of [DESK_COLS.slice(0, POD_SIZE), DESK_COLS.slice(POD_SIZE)]) {
      const x0 = pod[0]! - DESK_W / 2;
      const x1 = pod[pod.length - 1]! + DESK_W / 2;
      const top = y - DESK_TOP;
      const h = DESK_TOP - DESK_BOTTOM;
      // Desk thickness, then surface.
      box(c, x0, top + 0.06, x1 - x0, h, '#9ea4ad', { r: 3, shadow: 8 });
      const g = c.createLinearGradient(0, X(top), 0, X(top + h));
      g.addColorStop(0, '#eceef1');
      g.addColorStop(1, '#d9dce1');
      box(c, x0, top, x1 - x0, h, g, { r: 3 });
      // Fabric privacy screen along the back edge.
      box(c, x0, top - 0.08, x1 - x0, 0.2, '#4b5566', { r: 2 });
      c.fillStyle = '#6b7689';
      c.fillRect(X(x0), X(top - 0.08), X(x1 - x0), 1.5);
      // Seams between desk positions.
      c.strokeStyle = 'rgba(0,0,0,0.1)';
      c.lineWidth = 1;
      for (let i = 1; i < pod.length; i++) {
        const sx = pod[i]! - DESK_W / 2;
        c.beginPath();
        c.moveTo(X(sx), X(top + 0.12));
        c.lineTo(X(sx), X(top + h));
        c.stroke();
      }
    }
  }

  DESKS.forEach((d, i) => {
    const r = rng(i * 97 + 13);
    keyboard(c, d.x - 0.1, d.y - DESK_BOTTOM - 0.3, 0.82);
    // Mouse and pad.
    box(c, d.x + 0.4, d.y - DESK_BOTTOM - 0.5, 0.38, 0.34, '#3a3f48', { r: 2 });
    c.fillStyle = '#c9ccd2';
    c.beginPath();
    c.ellipse(X(d.x + 0.59), X(d.y - DESK_BOTTOM - 0.33), 3, 4.5, 0, 0, Math.PI * 2);
    c.fill();
    if (r() < 0.55) mug(c, d.x - 0.9, d.y - DESK_BOTTOM - 0.33, ['#e8e4dc', '#c0392b', '#2d5d8a', '#2c2c2c'][Math.floor(r() * 4)]!);
    if (r() < 0.35) {
      box(c, d.x + 0.84, d.y - DESK_BOTTOM - 0.55, 0.3, 0.42, '#f4f1e8', { r: 1 });
      c.strokeStyle = 'rgba(60,80,120,0.35)';
      c.beginPath();
      for (let l = 0; l < 3; l++) {
        c.moveTo(X(d.x + 0.87), X(d.y - DESK_BOTTOM - 0.47 + l * 0.09));
        c.lineTo(X(d.x + 1.1), X(d.y - DESK_BOTTOM - 0.47 + l * 0.09));
      }
      c.stroke();
    }
    chair(c, d.x, d.y + 0.08, -Math.PI / 2);
  });

  // Video wall frame; content is drawn live.
  const v = VIDEO_WALL;
  box(c, v.x - 0.1, v.y - 0.08, v.w + 0.2, v.h + 0.16, '#16181d', { r: 2, shadow: 6 });
}

function boardroom(c: CanvasRenderingContext2D) {
  const t = MEETING_TABLE;
  rug(c, t.x - 1.6, t.y - 1.9, t.w + 3.2, t.h + 3.8, '#2f3746', '#48536a');

  // Walnut table with a glass top.
  box(c, t.x, t.y + 0.08, t.w, t.h, '#2a1c13', { r: 14, shadow: 14 });
  const g = c.createLinearGradient(X(t.x), X(t.y), X(t.x), X(t.y + t.h));
  g.addColorStop(0, '#6b4a31');
  g.addColorStop(1, '#4e3423');
  box(c, t.x, t.y, t.w, t.h, g, { r: 14 });
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.lineWidth = 1;
  rr(c, X(t.x) + 3, X(t.y) + 3, X(t.w) - 6, X(t.h) - 6, 12);
  c.stroke();
  c.fillStyle = 'rgba(255,255,255,0.06)';
  c.beginPath();
  c.moveTo(X(t.x + 1), X(t.y) + 3);
  c.lineTo(X(t.x + 4), X(t.y) + 3);
  c.lineTo(X(t.x + 2.5), X(t.y + t.h) - 3);
  c.lineTo(X(t.x - 0.5), X(t.y + t.h) - 3);
  c.closePath();
  c.fill();
  // Cable spine and conference speaker.
  box(c, t.x + 2, t.y + t.h / 2 - 0.06, t.w - 4, 0.12, 'rgba(0,0,0,0.3)', { r: 2 });
  c.fillStyle = '#1c1e22';
  c.beginPath();
  const cx = X(MEETING_CENTER.x);
  const cy = X(MEETING_CENTER.y);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * X(0.32);
    const py = cy + Math.sin(a) * X(0.32);
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fill();
  circle(c, MEETING_CENTER.x, MEETING_CENTER.y, 0.08, '#3ddc84');

  for (const s of MEETING_SEATS) {
    if (s.standing) continue;
    chair(c, s.x, s.y, Math.atan2(MEETING_CENTER.y - s.y, MEETING_CENTER.x - s.x), '#3a3f4a');
    // A glass of water in front of every seat.
    const a = Math.atan2(MEETING_CENTER.y - s.y, MEETING_CENTER.x - s.x);
    const gx = s.x + Math.cos(a) * 1.25 + Math.cos(a + Math.PI / 2) * 0.45;
    const gy = s.y + Math.sin(a) * 1.25 + Math.sin(a + Math.PI / 2) * 0.45;
    circle(c, gx, gy, 0.08, 'rgba(200,230,255,0.55)');
  }
  chair(c, 44.6, 15.5, Math.PI, '#2b1f19', true);

  // Credenza along the right wall.
  box(c, 45.9, 13, 0.75, 5, '#3d2a1d', { r: 2, shadow: 5 });
  for (let i = 0; i < 4; i++) circle(c, 46.27, 13.6 + i * 0.35, 0.07, 'rgba(160,210,240,0.7)');
  plant(c, 46.1, 17.6, false, 7);

  const tv = MEETING_TV;
  box(c, tv.x - 0.08, tv.y - 0.05, tv.w + 0.16, tv.h + 0.1, '#0d0f12', { r: 2, shadow: 6 });
}

function ceoOffice(c: CanvasRenderingContext2D) {
  rug(c, 31.7, 2.6, 4.2, 3.2, '#5a2a2e', '#b08a5a');
  // L-shaped sofa and coffee table.
  box(c, 31.3, 1.45, 4.3, 0.95, '#6b5646', { r: 5, shadow: 6 });
  box(c, 31.3, 1.45, 0.95, 4.2, '#6b5646', { r: 5, shadow: 6 });
  box(c, 31.45, 1.6, 4.0, 0.35, '#57463a', { r: 4 });
  box(c, 31.45, 1.6, 0.35, 3.9, '#57463a', { r: 4 });
  for (let i = 0; i < 3; i++) box(c, 32.4 + i * 1.05, 1.95, 0.95, 0.4, '#7c6553', { r: 3 });
  box(c, 32.9, 3.1, 1.6, 1.1, '#2a1c14', { r: 4, shadow: 5 });
  box(c, 32.95, 3.15, 1.5, 1.0, 'rgba(200,230,255,0.12)', { r: 4 });
  box(c, 33.4, 3.45, 0.5, 0.35, '#b33a3a', { r: 1 });

  // Executive desk.
  const d = CEO_TABLE;
  box(c, d.x, d.y + 0.07, d.w, d.h, '#24170f', { r: 4, shadow: 12 });
  const g = c.createLinearGradient(X(d.x), 0, X(d.x + d.w), 0);
  g.addColorStop(0, '#5e3f2a');
  g.addColorStop(1, '#4a3120');
  box(c, d.x, d.y, d.w, d.h, g, { r: 4 });
  box(c, d.x + 1.0, d.y + 0.2, 2.2, 0.8, '#1f1a17', { r: 3 });
  keyboard(c, CEO_DESK.x, d.y + 0.35, 0.8);
  // Brass lamp and nameplate.
  circle(c, d.x + 0.45, d.y + 0.4, 0.2, '#b8913f');
  circle(c, d.x + 0.45, d.y + 0.4, 0.1, '#f2d98c');
  box(c, d.x + 3.2, d.y + 0.95, 0.8, 0.2, '#c9a45b', { r: 1 });
  mug(c, d.x + 3.6, d.y + 0.45, '#f1efe9');
  chair(c, CEO_DESK.x, CEO_DESK.y, Math.PI / 2, '#3b2a22', true);
  for (const gc of CEO_GUEST_CHAIRS) chair(c, gc.x, gc.y, -Math.PI / 2, '#4a3a30');

  // Bookshelf on the right wall.
  box(c, 45.95, 1.6, 0.75, 4.8, '#3a281b', { r: 2, shadow: 5 });
  const r = rng(99);
  for (let y = 1.7; y < 6.3; y += 0.14) {
    c.fillStyle = ['#8a2f2f', '#2f4f7a', '#c9a45b', '#3f6b4a', '#6b4f8a', '#d9d3c7'][Math.floor(r() * 6)]!;
    c.fillRect(X(46.05), X(y), X(0.35 + r() * 0.2), X(0.11));
  }
}

function lounge(c: CanvasRenderingContext2D) {
  rug(c, 14.5, 1.9, 6.4, 4.2, '#2e5a5a', '#e0c9a0');
  // Sofas: left and top, with seat cushions.
  box(c, 14.95, 2.55, 1.15, 3.1, '#4a5568', { r: 5, shadow: 6 });
  box(c, 14.95, 2.55, 0.35, 3.1, '#3a4455', { r: 4 });
  box(c, 16.6, 1.6, 3.2, 1.15, '#4a5568', { r: 5, shadow: 6 });
  box(c, 16.6, 1.6, 3.2, 0.35, '#3a4455', { r: 4 });
  for (const s of LOUNGE_SPOTS) circle(c, s.x, s.y, 0.28, '#56627a');
  // Coffee table.
  box(c, LOUNGE_TABLE.x - 0.75, LOUNGE_TABLE.y - 0.45, 1.5, 0.9, '#6a4a30', { r: 4, shadow: 5 });
  box(c, LOUNGE_TABLE.x - 0.4, LOUNGE_TABLE.y - 0.2, 0.55, 0.4, '#e8e3d8', { r: 1 });
  // Armchair, bookshelf, foosball.
  box(c, 20.9, 3.8, 1.1, 1.1, '#8a5a3a', { r: 6, shadow: 6 });
  box(c, 21.05, 3.9, 0.8, 0.3, '#6e4830', { r: 4 });
  box(c, 21.4, 1.2, 4.1, 0.6, '#3a281b', { r: 2, shadow: 5 });
  const r = rng(71);
  for (let x = 21.5; x < 25.4; x += 0.13) {
    c.fillStyle = ['#8a2f2f', '#2f4f7a', '#c9a45b', '#3f6b4a', '#d9d3c7'][Math.floor(r() * 5)]!;
    c.fillRect(X(x), X(1.28), X(0.1), X(0.3 + r() * 0.15));
  }
  box(c, 22.6, 3.5, 2.4, 1.3, '#1e3b24', { r: 3, shadow: 7, stroke: '#5a3a24', lw: 4 });
  c.strokeStyle = 'rgba(255,255,255,0.4)';
  c.lineWidth = 1;
  c.strokeRect(X(22.75), X(3.65), X(2.1), X(1.0));
  c.strokeStyle = '#b5b9c0';
  c.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    c.beginPath();
    c.moveTo(X(22.9 + i * 0.36), X(3.3));
    c.lineTo(X(22.9 + i * 0.36), X(5.0));
    c.stroke();
  }
  box(c, 24.1, 5.4, 0.85, 0.85, '#c0392b', { r: 12, shadow: 4 });
}

function reception(c: CanvasRenderingContext2D) {
  // Brand wall.
  c.fillStyle = '#c9a45b';
  c.font = `700 ${T * 0.38}px Inter, sans-serif`;
  c.textAlign = 'center';
  c.fillText('MERIDIAN CAPITAL', X(5.9), X(2.05));
  c.fillStyle = 'rgba(80,70,50,0.55)';
  c.font = `500 ${T * 0.2}px Inter, sans-serif`;
  c.fillText('PROPRIETARY DIGITAL ASSETS', X(5.9), X(2.4));

  const d = RECEPTION_DESK;
  box(c, d.x, d.y + 0.08, d.w, d.h, '#8e959f', { r: 10, shadow: 10 });
  box(c, d.x, d.y, d.w, d.h, '#f0f1f3', { r: 10 });
  box(c, d.x + 0.2, d.y + 0.1, d.w - 0.4, 0.35, '#8a6a48', { r: 5 });
  box(c, d.x + 1.8, d.y + 0.14, 0.9, 0.25, '#1b1d22', { r: 2 });
  chair(c, d.x + 2.3, d.y - 0.55, Math.PI / 2, '#30343c');
  // Waiting area.
  box(c, 8.3, 4.9, 2.3, 0.85, '#4b5566', { r: 5, shadow: 6 });
  box(c, 8.3, 5.4, 2.3, 0.35, '#3c4452', { r: 4 });
  box(c, 8.8, 3.5, 1.2, 0.8, '#d9dce1', { r: 10, shadow: 4 });
  box(c, 1.4, 3.45, 0.7, 1.8, '#5a4a3a', { r: 2 });
}

function cafeteria(c: CanvasRenderingContext2D) {
  for (const t of CAFE_TABLES) {
    for (const s of CAFE_SPOTS.filter((q) => Math.hypot(q.x - t.x, q.y - t.y) < 1.2)) {
      chair(c, s.x, s.y, Math.atan2(t.y - s.y, t.x - s.x), '#7a5a3a');
    }
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 10;
    c.shadowOffsetY = 4;
    circle(c, t.x, t.y, t.r, '#5c4128');
    c.restore();
    const g = c.createRadialGradient(X(t.x - 0.2), X(t.y - 0.2), 2, X(t.x), X(t.y), X(t.r));
    g.addColorStop(0, '#9a7650');
    g.addColorStop(1, '#7a5a3a');
    c.fillStyle = g;
    c.beginPath();
    c.arc(X(t.x), X(t.y), X(t.r - 0.05), 0, Math.PI * 2);
    c.fill();
    circle(c, t.x + 0.25, t.y - 0.15, 0.1, 'rgba(255,255,255,0.8)');
  }

  // Counter with coffee station, fruit and sink.
  const k = CAFE_COUNTER;
  box(c, k.x, k.y, k.w, k.h - 1.2, '#3a3531', { r: 3, shadow: 8 });
  box(c, k.x + 0.08, k.y + 0.08, k.w - 0.16, k.h - 1.36, '#d5d0c6', { r: 2 });
  box(c, k.x + 0.25, k.y + 0.2, 1.0, 0.8, '#26272b', { r: 3 });
  box(c, k.x + 0.35, k.y + 0.3, 0.8, 0.25, '#b0b5bd', { r: 2 });
  circle(c, k.x + 0.5, k.y + 0.8, 0.07, '#ff6b3d');
  circle(c, k.x + 0.75, k.y + 1.55, 0.3, '#d9a66b');
  ['#e74c3c', '#f1c40f', '#27ae60', '#e67e22'].forEach((f, i) =>
    circle(c, k.x + 0.65 + (i % 2) * 0.18, k.y + 1.45 + Math.floor(i / 2) * 0.18, 0.08, f),
  );
  box(c, k.x + 0.3, k.y + 2.0, 0.9, 0.6, '#9aa1ab', { r: 3 });
  box(c, k.x + 0.4, k.y + 2.1, 0.7, 0.4, '#6f7680', { r: 3 });
  // Fridge.
  const fg = c.createLinearGradient(X(k.x), 0, X(k.x + k.w), 0);
  fg.addColorStop(0, '#9aa0a8');
  fg.addColorStop(0.5, '#d4d8dd');
  fg.addColorStop(1, '#9aa0a8');
  box(c, k.x, k.y + k.h - 1.1, k.w, 1.1, fg, { r: 3, shadow: 8 });
  c.fillStyle = '#6f7680';
  c.fillRect(X(k.x + 0.2), X(k.y + k.h - 0.55), X(k.w - 0.4), 1.5);
  plant(c, 1.8, 28.3, true, 3);
}

function booths(c: CanvasRenderingContext2D) {
  BOOTHS.forEach((b, i) => {
    if (i > 0) {
      c.fillStyle = '#c9ccd2';
      c.fillRect(X(b.x - 0.1), X(26), X(0.14), X(3));
    }
    box(c, b.x + 0.2, 27.9, b.w - 0.4, 0.7, '#e3e5e8', { r: 2, shadow: 5 });
    box(c, b.x + b.w / 2 - 0.3, 28.0, 0.6, 0.36, '#1b1d22', { r: 1 });
    chair(c, b.x + b.w / 2, 27.3, Math.PI / 2);
    box(c, b.x + 0.2, 28.75, b.w - 0.4, 0.12, '#3b6a5a', { r: 1 });
  });
}

function serverRoom(c: CanvasRenderingContext2D) {
  // Overhead cable tray.
  box(c, 37, 24.05, 8.4, 0.2, 'rgba(210,160,60,0.55)', { r: 1 });
  for (const rk of RACKS) {
    box(c, rk.x - 0.6, rk.y, 1.2, 2.3, '#15191e', { r: 2, shadow: 10 });
    c.strokeStyle = '#2f3740';
    c.lineWidth = 1;
    rr(c, X(rk.x - 0.6), X(rk.y), X(1.2), X(2.3), 2);
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.05)';
    for (let v = 0; v < 8; v++) c.fillRect(X(rk.x - 0.5), X(rk.y + 0.15 + v * 0.22), X(1.0), 2);
  }
  // Precision cooling unit.
  box(c, 45.6, 24.2, 1.1, 4.2, '#c7ccd2', { r: 3, shadow: 8 });
  for (let i = 0; i < 3; i++) {
    circle(c, 46.15, 24.9 + i * 1.3, 0.4, '#5d6570');
    circle(c, 46.15, 24.9 + i * 1.3, 0.3, '#3a4048');
  }
  box(c, 36.3, 28.1, 0.3, 0.55, '#c0392b', { r: 3 });
}

function nook(c: CanvasRenderingContext2D) {
  // Copier.
  box(c, 30.3, 24.1, 1.5, 1.0, '#d9dce1', { r: 3, shadow: 8 });
  box(c, 30.45, 24.2, 1.2, 0.45, '#9ea4ad', { r: 2 });
  box(c, 30.6, 24.75, 0.6, 0.25, '#f5f5f0', { r: 1 });
  // Water cooler.
  box(c, 33.2, 23.9, 0.6, 0.6, '#e6e8eb', { r: 3, shadow: 5 });
  circle(c, 33.5, 24.2, 0.22, 'rgba(120,190,240,0.85)');
  // Vending machine.
  box(c, 30.2, 26.4, 1.1, 1.6, '#23262c', { r: 3, shadow: 8 });
  const cols = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#e67e22', '#9b59b6'];
  for (let i = 0; i < 12; i++)
    circle(c, 30.42 + (i % 3) * 0.33, 26.65 + Math.floor(i / 3) * 0.3, 0.08, cols[i % cols.length]!);
  // Bins.
  circle(c, 32.6, 28.3, 0.22, '#2e7d4f');
  circle(c, 33.15, 28.3, 0.22, '#2f5d8a');
}

function zoneLabels(c: CanvasRenderingContext2D) {
  c.textAlign = 'left';
  for (const z of ZONES) {
    if (!z.label || z.kind === 'reception') continue;
    c.font = `700 ${T * 0.3}px Inter, sans-serif`;
    const dark = z.kind === 'cafeteria' || z.kind === 'server_room';
    c.fillStyle = dark ? 'rgba(40,35,30,0.45)' : 'rgba(255,255,255,0.22)';
    const lx = z.kind === 'desk' ? z.x + 0.5 : z.x + 0.45;
    const ly = z.kind === 'desk' ? z.y + z.h - 0.3 : z.kind === 'meeting_room' ? z.y + z.h - 0.35 : z.y + z.h - 0.3;
    c.fillText(z.label.toUpperCase().split('').join(String.fromCharCode(8202)), X(lx), X(ly));
  }
}

/** Warm pools under the ceiling fixtures, then a gentle vignette. */
function lighting(c: CanvasRenderingContext2D) {
  const pools: [number, number, number][] = [];
  for (const y of DESK_ROWS) for (const x of [6.8, 17.4]) pools.push([x, y - 1, 4]);
  pools.push([38, 15.5, 6], [37, 4, 5], [19, 4, 5], [6, 4, 4.5], [7.4, 26.5, 5], [41, 26, 4], [22.5, 26.5, 3]);
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (const [x, y, r] of pools) {
    const g = c.createRadialGradient(X(x), X(y), 0, X(x), X(y), X(r));
    g.addColorStop(0, 'rgba(255,236,200,0.07)');
    g.addColorStop(1, 'rgba(255,236,200,0)');
    c.fillStyle = g;
    c.fillRect(X(x - r), X(y - r), X(r * 2), X(r * 2));
  }
  c.restore();
  const v = c.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.28)');
  c.fillStyle = v;
  c.fillRect(0, 0, W, H);
}

function paintStatic(c: CanvasRenderingContext2D) {
  // Night-time ground outside the building.
  c.fillStyle = '#080b12';
  c.fillRect(0, 0, W, H);
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.8)';
  c.shadowBlur = 30;
  c.fillStyle = '#3d4047';
  c.fillRect(X(1), X(1), X(OFFICE_W - 2), X(OFFICE_H - 2));
  c.restore();

  drawFloors(c);
  tradingDesks(c);
  boardroom(c);
  ceoOffice(c);
  lounge(c);
  reception(c);
  cafeteria(c);
  booths(c);
  serverRoom(c);
  nook(c);
  PLANTS.forEach((p, i) => plant(c, p.x, p.y, p.big, i + 40));
  drawWalls(c);
  zoneLabels(c);
  lighting(c);
}

// ── Live screens ───────────────────────────────────────────────────────────

type ScreenMode = 'off' | 'active' | 'idle' | 'setup';

function screenContent(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  mode: ScreenMode, kind: number, t: number, seed: number,
) {
  c.fillStyle = mode === 'off' ? '#0c0e12' : '#07131f';
  c.fillRect(x, y, w, h);
  if (mode === 'off') {
    const g = c.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, 'rgba(255,255,255,0.07)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, w, h);
    return;
  }
  if (mode === 'idle') {
    c.fillStyle = 'rgba(77,163,255,0.35)';
    const bx = x + w * (0.3 + 0.2 * Math.sin(t / 2000 + seed));
    c.fillRect(bx, y + h * 0.4, w * 0.2, h * 0.2);
    return;
  }
  if (mode === 'setup') {
    c.fillStyle = 'rgba(167,139,250,0.8)';
    c.fillRect(x + w * 0.15, y + h * 0.55, w * 0.7 * ((t / 6000 + seed) % 1), h * 0.12);
    c.fillStyle = 'rgba(255,255,255,0.3)';
    c.fillRect(x + w * 0.15, y + h * 0.3, w * 0.5, h * 0.1);
    return;
  }
  const r = rng(seed + Math.floor(t / 1500));
  const n = 9;
  if (kind === 0) {
    // Candlesticks.
    let p = 0.5;
    for (let i = 0; i < n; i++) {
      const o = p;
      p = Math.min(0.9, Math.max(0.1, p + (r() - 0.48) * 0.25));
      const up = p >= o;
      c.fillStyle = up ? '#22c98a' : '#ff5f6d';
      const cx = x + 2 + (i * (w - 4)) / n;
      const top = y + h - Math.max(o, p) * h;
      c.fillRect(cx, top, Math.max(1.5, (w - 4) / n - 1), Math.max(1, Math.abs(p - o) * h));
    }
  } else if (kind === 1) {
    c.strokeStyle = '#4da3ff';
    c.lineWidth = 1;
    c.beginPath();
    let p = 0.5;
    for (let i = 0; i <= 14; i++) {
      p = Math.min(0.9, Math.max(0.1, p + (r() - 0.5) * 0.2));
      const px = x + (i * w) / 14;
      const py = y + h - p * h;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
  } else if (kind === 2) {
    // Order book ladder.
    for (let i = 0; i < 5; i++) {
      c.fillStyle = i < 2 ? 'rgba(255,95,109,0.7)' : 'rgba(34,201,138,0.7)';
      c.fillRect(x + 1, y + 1 + i * (h / 5), (w - 2) * (0.2 + r() * 0.75), h / 5 - 1);
    }
  } else {
    // Blotter rows.
    for (let i = 0; i < 4; i++) {
      c.fillStyle = i === 0 ? 'rgba(255,255,255,0.45)' : 'rgba(160,190,220,0.4)';
      c.fillRect(x + 2, y + 2 + i * (h / 4), (w - 4) * (0.5 + r() * 0.45), 1.5);
    }
  }
}

/** Monitors on one trading desk, facing the person who sits there. */
function deskMonitors(c: CanvasRenderingContext2D, dx: number, dy: number, mode: ScreenMode, t: number, idx: number) {
  const baseY = dy - DESK_TOP + 0.15;
  const specs = [
    { ox: -0.74, w: 0.62, h: 0.42, dy: 0.06 },
    { ox: 0, w: 0.76, h: 0.46, dy: 0 },
    { ox: 0.74, w: 0.62, h: 0.42, dy: 0.06 },
  ];
  if (mode !== 'off') {
    const g = c.createRadialGradient(X(dx), X(baseY + 0.4), 2, X(dx), X(baseY + 0.4), X(1.4));
    g.addColorStop(0, mode === 'active' ? 'rgba(90,170,255,0.2)' : 'rgba(90,170,255,0.08)');
    g.addColorStop(1, 'rgba(90,170,255,0)');
    c.fillStyle = g;
    c.fillRect(X(dx - 1.4), X(baseY - 0.2), X(2.8), X(1.8));
  }
  specs.forEach((s, k) => {
    const x = X(dx + s.ox - s.w / 2);
    const y = X(baseY + s.dy);
    c.fillStyle = '#0d0f13';
    rr(c, x - 1.5, y - 1.5, X(s.w) + 3, X(s.h) + 3, 2);
    c.fill();
    screenContent(c, x, y, X(s.w), X(s.h), mode, (idx + k) % 4, t, idx * 10 + k);
    c.fillStyle = '#2a2d33';
    c.fillRect(x + X(s.w) / 2 - 2, y + X(s.h) + 1.5, 4, 2);
  });
}

function spark(c: CanvasRenderingContext2D, pts: number[], x: number, y: number, w: number, h: number, col: string) {
  if (pts.length < 3) return;
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  c.strokeStyle = col;
  c.lineWidth = 1.3;
  c.beginPath();
  pts.forEach((v, i) => {
    const px = x + (i / (pts.length - 1)) * w;
    const py = y + h - ((v - lo) / span) * h;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  });
  c.stroke();
  c.lineTo(x + w, y + h);
  c.lineTo(x, y + h);
  c.closePath();
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, col.replace(')', ',0.25)').replace('rgb', 'rgba'));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fill();
}

function fmtInr(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : v > 0 ? '+' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)}L`;
  return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
}

function videoWall(c: CanvasRenderingContext2D, s: FloorState) {
  const v = VIDEO_WALL;
  const syms = Object.keys(s.market).sort();
  const panels = 4;
  const pw = v.w / panels;
  for (let i = 0; i < panels; i++) {
    const x = X(v.x + i * pw) + 1.5;
    const y = X(v.y);
    const w = X(pw) - 3;
    const h = X(v.h);
    c.fillStyle = '#06101b';
    c.fillRect(x, y, w, h);
    c.font = `700 ${T * 0.24}px 'JetBrains Mono', monospace`;
    c.textBaseline = 'top';
    if (i < 3) {
      const sym = syms[i];
      const m = sym ? s.market[sym] : undefined;
      if (!m) continue;
      const up = m.indicators.change24h >= 0;
      const col = up ? 'rgb(34,201,138)' : 'rgb(255,95,109)';
      c.fillStyle = '#9fb3cf';
      c.textAlign = 'left';
      c.fillText(sym!.replace('USDT', ''), x + 5, y + 3);
      c.fillStyle = '#e6ecf7';
      c.fillText(`$${m.price.toLocaleString('en-US', { maximumFractionDigits: m.price < 10 ? 3 : 1 })}`, x + 5 + X(0.8), y + 3);
      c.fillStyle = col;
      c.textAlign = 'right';
      c.fillText(`${up ? '+' : ''}${m.indicators.change24h.toFixed(2)}%`, x + w - 5, y + 3);
      spark(c, m.spark, x + 5, y + X(0.36), w - 10, h - X(0.42), col);
    } else {
      const p = s.portfolio.pnl_today_inr;
      c.fillStyle = '#9fb3cf';
      c.textAlign = 'left';
      c.fillText('DESK P&L', x + 5, y + 3);
      c.textAlign = 'right';
      c.fillStyle = '#9fb3cf';
      c.fillText(`${s.portfolio.positions.length} OPEN`, x + w - 5, y + 3);
      c.font = `700 ${T * 0.36}px 'JetBrains Mono', monospace`;
      c.fillStyle = p > 0.5 ? '#22c98a' : p < -0.5 ? '#ff5f6d' : '#e6ecf7';
      c.textAlign = 'left';
      c.fillText(fmtInr(p), x + 5, y + X(0.38));
    }
    c.textBaseline = 'alphabetic';
  }
}

function boardroomScreen(c: CanvasRenderingContext2D, s: FloorState) {
  const tv = MEETING_TV;
  const x = X(tv.x);
  const y = X(tv.y);
  const w = X(tv.w);
  const h = X(tv.h);
  const m = s.meeting;
  c.fillStyle = m ? '#071624' : '#0a0d12';
  c.fillRect(x, y, w, h);
  c.textBaseline = 'top';
  if (!m) {
    c.fillStyle = 'rgba(201,164,91,0.55)';
    c.font = `700 ${T * 0.26}px Inter, sans-serif`;
    c.textAlign = 'center';
    c.fillText('MERIDIAN CAPITAL', x + w / 2, y + h / 2 - T * 0.13);
    c.textBaseline = 'alphabetic';
    return;
  }
  const snap = s.market[m.symbol] ?? m.snapshot;
  const up = snap.indicators.change24h >= 0;
  c.font = `700 ${T * 0.25}px 'JetBrains Mono', monospace`;
  c.fillStyle = '#e6ecf7';
  c.textAlign = 'left';
  c.fillText(`${m.symbol.replace('USDT', '/USDT')}  $${snap.price.toFixed(2)}`, x + 6, y + 4);
  c.fillStyle = '#4da3ff';
  c.textAlign = 'right';
  const tag = m.decision
    ? m.decision.action === 'stand_down' ? 'NO TRADE' : m.decision.action.replace('execute_', '').toUpperCase()
    : m.phase.toUpperCase();
  c.fillText(tag, x + w - 6, y + 4);
  spark(c, snap.spark, x + 6, y + X(0.36), w * 0.62, h - X(0.42), up ? 'rgb(34,201,138)' : 'rgb(255,95,109)');
  if (m.decision) {
    const t = m.decision.tally;
    c.font = `600 ${T * 0.21}px 'JetBrains Mono', monospace`;
    c.fillStyle = '#9fb3cf';
    c.fillText(`L${t.long} S${t.short} F${t.flat}`, x + w - 6, y + X(0.42));
  }
  c.textBaseline = 'alphabetic';
}

function laptop(c: CanvasRenderingContext2D, x: number, y: number, ang: number, t: number, seed: number) {
  c.save();
  c.translate(X(x), X(y));
  c.rotate(ang + Math.PI / 2);
  c.fillStyle = '#b9bec6';
  rr(c, -T * 0.3, -T * 0.05, T * 0.6, T * 0.3, 2);
  c.fill();
  c.fillStyle = '#2a2d33';
  c.fillRect(-T * 0.26, T * 0.0, T * 0.52, T * 0.16);
  c.fillStyle = '#1c1f24';
  rr(c, -T * 0.3, -T * 0.32, T * 0.6, T * 0.26, 2);
  c.fill();
  screenContent(c, -T * 0.27, -T * 0.3, T * 0.54, T * 0.21, 'active', seed % 4, t, seed);
  c.restore();
}

// ── Desk-mode fire ─────────────────────────────────────────────────────────

/**
 * Particle fire. Each person has an emitter at their feet; particles rise on
 * buoyancy, drift on a turbulence field, shrink as they climb (so the flame
 * tapers to tongues) and walk a colour ramp from a white-hot core out to the
 * mode colour. Rendering uses pre-baked glow sprites with additive blending, so
 * a thousand particles cost a thousand cheap drawImage calls, not gradients.
 */

interface FireSpec {
  /** Colour ramp from the hottest (birth) to the coolest (death). */
  ramp: [number, number, number][];
  rate: number;
  life: [number, number];
  size: [number, number];
  rise: [number, number];
  buoyancy: number;
  turbulence: number;
  alpha: number;
  embers: number;
  glow: string;
}

const FIRE: Record<DeskMode, FireSpec> = {
  // Copper-salt flame: small, gentle, green.
  conservative: {
    ramp: [[235, 255, 240], [150, 255, 190], [40, 220, 120], [10, 150, 90], [5, 80, 60]],
    rate: 24, life: [0.32, 0.6], size: [5, 9], rise: [18, 34], buoyancy: 30, turbulence: 14,
    alpha: 0.55, embers: 0, glow: '40,220,120',
  },
  // Gas burner: steady, blue, white-cyan at the base.
  normal: {
    ramp: [[235, 250, 255], [150, 210, 255], [60, 140, 255], [40, 70, 220], [30, 30, 140]],
    rate: 36, life: [0.35, 0.68], size: [6, 11], rise: [28, 52], buoyancy: 48, turbulence: 20,
    alpha: 0.6, embers: 0, glow: '70,150,255',
  },
  // Open wood fire: tall, fast, white-yellow core into orange and deep red.
  aggressive: {
    ramp: [[255, 250, 220], [255, 214, 110], [255, 150, 40], [235, 80, 15], [150, 30, 10]],
    rate: 58, life: [0.4, 0.78], size: [8, 14], rise: [42, 78], buoyancy: 82, turbulence: 30,
    alpha: 0.62, embers: 7, glow: '255,130,40',
  },
};

const SPRITE_STEPS = 12;
const spriteCache = new Map<DeskMode, HTMLCanvasElement[]>();

/** Soft round glow sprites along the mode's colour ramp. */
function sprites(mode: DeskMode): HTMLCanvasElement[] {
  const hit = spriteCache.get(mode);
  if (hit) return hit;
  const ramp = FIRE[mode].ramp;
  const out: HTMLCanvasElement[] = [];
  for (let i = 0; i < SPRITE_STEPS; i++) {
    const k = i / (SPRITE_STEPS - 1);
    const pos = k * (ramp.length - 1);
    const a = ramp[Math.floor(pos)]!;
    const b = ramp[Math.min(ramp.length - 1, Math.floor(pos) + 1)]!;
    const f = pos - Math.floor(pos);
    const col = a.map((v, j) => Math.round(v + (b[j]! - v) * f)).join(',');
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${col},1)`);
    grad.addColorStop(0.3, `rgba(${col},0.75)`);
    grad.addColorStop(0.65, `rgba(${col},0.22)`);
    grad.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    out.push(cv);
  }
  spriteCache.set(mode, out);
  return out;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  seed: number;
  ember: boolean;
}

interface Emitter {
  parts: Particle[];
  carry: number;
  emberCarry: number;
  lastSeen: number;
}

const emitters = new Map<string, Emitter>();
let fireClock = 0;
let fireDt = 0;

/**
 * Fire is drawn into a half-resolution layer and stretched over the office.
 * It is soft by nature, so it looks the same, but fill cost drops by roughly
 * the square of the scale — the difference between 45ms and a few ms a frame.
 */
const FIRE_SCALE = 0.5;
let fireLayer: HTMLCanvasElement | null = null;
let fctx: CanvasRenderingContext2D | null = null;

function fireLayerCtx(): CanvasRenderingContext2D {
  if (!fctx) {
    fireLayer = document.createElement('canvas');
    fireLayer.width = Math.round(W * FIRE_SCALE);
    fireLayer.height = Math.round(H * FIRE_SCALE);
    fctx = fireLayer.getContext('2d')!;
  }
  return fctx;
}

const glowCache = new Map<DeskMode, HTMLCanvasElement>();
function glowSprite(mode: DeskMode): HTMLCanvasElement {
  const hit = glowCache.get(mode);
  if (hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 32);
  grad.addColorStop(0, `rgba(${FIRE[mode].glow},0.9)`);
  grad.addColorStop(1, `rgba(${FIRE[mode].glow},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(mode, cv);
  return cv;
}

/** Stretch the finished fire layer onto the office, additively. */
function compositeFire(c: CanvasRenderingContext2D) {
  if (!fireLayer) return;
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.drawImage(fireLayer, 0, 0, W, H);
  c.restore();
}

/** Advance the fire clock once per frame; returns seconds since last frame. */
function fireFrame(t: number): number {
  fireDt = fireClock === 0 ? 0.016 : Math.min(0.05, (t - fireClock) / 1000);
  fireClock = t;
  const f = fireLayerCtx();
  f.setTransform(1, 0, 0, 1, 0, 0);
  f.clearRect(0, 0, f.canvas.width, f.canvas.height);
  f.setTransform(FIRE_SCALE, 0, 0, FIRE_SCALE, 0, 0);
  // Drop emitters for people no longer on the floor.
  for (const [id, e] of emitters) if (t - e.lastSeen > 2000) emitters.delete(id);
  return fireDt;
}

function drawFire(id: string, v: { x: number; y: number }, mode: DeskMode, t: number) {
  const c = fireLayerCtx();
  const spec = FIRE[mode];
  const dt = fireDt;
  let em = emitters.get(id);
  if (!em) {
    em = { parts: [], carry: 0, emberCarry: 0, lastSeen: t };
    emitters.set(id, em);
  }
  em.lastSeen = t;

  const cx = X(v.x);
  const cy = X(v.y) + T * 0.18;
  const rx = T * 0.36 * PS;
  const ry = T * 0.24 * PS;
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  // Spawn: flames lick up from a ring around the feet, denser at the edge.
  em.carry += spec.rate * dt;
  while (em.carry >= 1 && em.parts.length < 70) {
    em.carry -= 1;
    const ang = Math.random() * Math.PI * 2;
    const rad = 0.55 + 0.45 * Math.sqrt(Math.random());
    em.parts.push({
      x: cx + Math.cos(ang) * rx * rad,
      y: cy + Math.sin(ang) * ry * rad,
      vx: Math.cos(ang) * rnd(4, 12),
      vy: -rnd(spec.rise[0], spec.rise[1]),
      age: 0,
      life: rnd(spec.life[0], spec.life[1]),
      size: rnd(spec.size[0], spec.size[1]),
      seed: Math.random() * 100,
      ember: false,
    });
  }
  em.emberCarry += spec.embers * dt;
  while (em.emberCarry >= 1) {
    em.emberCarry -= 1;
    em.parts.push({
      x: cx + rnd(-rx, rx) * 0.6,
      y: cy - rnd(0, ry),
      vx: rnd(-10, 10),
      vy: -rnd(45, 80),
      age: 0,
      life: rnd(1.0, 1.8),
      size: rnd(1, 1.8),
      seed: Math.random() * 100,
      ember: true,
    });
  }

  // Flickering light the fire casts on the floor around them.
  const flick = 0.75 + 0.15 * Math.sin(t * 0.017 + cx) + 0.1 * Math.sin(t * 0.041 + cy);
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.25 * flick;
  c.drawImage(glowSprite(mode), cx - rx * 2.4, cy - ry * 2.6, rx * 4.8, ry * 5.2);

  const sp = sprites(mode);
  const alive: Particle[] = [];
  for (const p of em.parts) {
    p.age += dt;
    if (p.age >= p.life) continue;
    const k = p.age / p.life;

    // Turbulence: a cheap curl-ish field that makes tongues wander and split.
    const turb = Math.sin(p.y * 0.09 + t * 0.006 + p.seed) + 0.5 * Math.sin(p.y * 0.21 - t * 0.011 + p.seed * 2);
    p.vx += (turb * spec.turbulence - p.vx) * Math.min(1, dt * (p.ember ? 2 : 4));
    // Pull slightly toward the centre line so the flame gathers into a crown.
    if (!p.ember) p.vx += (cx - p.x) * 0.9 * dt;
    p.vy -= (p.ember ? spec.buoyancy * 0.3 : spec.buoyancy) * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    alive.push(p);

    if (p.ember) {
      const a = (1 - k) * 0.9 * (0.6 + 0.4 * Math.sin(t * 0.03 + p.seed));
      c.globalAlpha = a;
      c.drawImage(sp[0]!, p.x - 3, p.y - 3, 6, 6);
      continue;
    }

    // Hot and bright at birth, cooling and thinning as it climbs.
    const fadeIn = k < 0.12 ? k / 0.12 : 1;
    const a = spec.alpha * fadeIn * Math.pow(1 - k, 1.35);
    const r = p.size * (1.15 - k * 0.8);
    const idx = Math.min(SPRITE_STEPS - 1, Math.floor(k * SPRITE_STEPS));
    c.globalAlpha = a;
    // Stretched vertically: flames are taller than they are wide.
    c.drawImage(sp[idx]!, p.x - r, p.y - r * 1.5, r * 2, r * 3);
  }
  em.parts = alive;
  c.globalAlpha = 1;
  c.restore();
}

// ── People ─────────────────────────────────────────────────────────────────

interface Vis {
  x: number;
  y: number;
  angle: number;
  phase: number;
  moving: boolean;
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function hairPath(c: CanvasRenderingContext2D, hy: number, r: number) {
  const a0 = -Math.PI / 2 + 0.95;
  const a1 = -Math.PI / 2 - 0.95 + Math.PI * 2;
  c.beginPath();
  c.arc(0, hy, r, a0, a1);
  c.quadraticCurveTo(0, hy - r * 0.62, Math.cos(a0) * r, hy + Math.sin(a0) * r);
  c.closePath();
}

function person(
  c: CanvasRenderingContext2D, a: Agent, v: Vis, look: Look,
  pose: { seated: boolean; typing: boolean; coffee: boolean; carrying: boolean },
  t: number,
) {
  const x = X(v.x);
  const y = X(v.y);

  // Contact shadow.
  c.fillStyle = 'rgba(0,0,0,0.34)';
  c.beginPath();
  c.ellipse(x + 3, y + 5, T * 0.34 * PS, T * 0.26 * PS, 0, 0, Math.PI * 2);
  c.fill();

  c.save();
  c.translate(x, y);
  c.rotate(v.angle + Math.PI / 2);
  const bob = v.moving ? 1 + Math.sin(v.phase * 2) * 0.025 : 1;
  c.scale(T * PS * bob, T * PS * bob);

  const stride = v.moving ? Math.sin(v.phase) * 0.17 : 0;
  const skin = look.skin;
  const topDark = shade(look.top, -0.22);

  // Legs: striding when walking, tucked under the desk when seated.
  c.fillStyle = look.pants;
  if (pose.seated) {
    c.beginPath();
    c.ellipse(-0.1, -0.24, 0.085, 0.15, 0, 0, Math.PI * 2);
    c.ellipse(0.1, -0.24, 0.085, 0.15, 0, 0, Math.PI * 2);
    c.fill();
  } else {
    for (const [lx, off] of [[-0.11, stride], [0.11, -stride]] as const) {
      c.fillStyle = look.pants;
      c.beginPath();
      c.ellipse(lx, off * 0.9, 0.085, 0.15, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#15171b';
      c.beginPath();
      c.ellipse(lx, off * 0.9 - 0.12, 0.07, 0.065, 0, 0, Math.PI * 2);
      c.fill();
    }
  }

  // Arms.
  const arm = (sx: number, hx: number, hy: number) => {
    c.strokeStyle = topDark;
    c.lineWidth = 0.13;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(sx, 0);
    c.lineTo(hx, hy);
    c.stroke();
    c.fillStyle = skin;
    c.beginPath();
    c.arc(hx, hy, 0.055, 0, Math.PI * 2);
    c.fill();
  };
  if (pose.typing) {
    const j = Math.sin(t / 90 + a.hue) * 0.02;
    arm(-0.25, -0.13, -0.38 + j);
    arm(0.25, 0.14, -0.38 - j);
  } else if (pose.seated) {
    arm(-0.26, -0.2, -0.26);
    arm(0.26, pose.coffee ? 0.16 : 0.2, pose.coffee ? -0.34 : -0.26);
  } else {
    arm(-0.29, -0.31, -stride * 0.9);
    arm(0.29, pose.coffee ? 0.18 : 0.31, pose.coffee ? -0.3 : stride * 0.9);
  }
  if (pose.coffee) {
    c.fillStyle = '#f2efe8';
    c.beginPath();
    c.arc(pose.seated ? 0.16 : 0.18, pose.seated ? -0.44 : -0.4, 0.07, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#5a3a24';
    c.beginPath();
    c.arc(pose.seated ? 0.16 : 0.18, pose.seated ? -0.44 : -0.4, 0.045, 0, Math.PI * 2);
    c.fill();
  }
  if (pose.carrying) {
    c.fillStyle = '#2a2d33';
    c.fillRect(-0.36, -0.12, 0.1, 0.3);
  }

  // Torso with shading.
  const g = c.createLinearGradient(-0.3, -0.2, 0.3, 0.2);
  g.addColorStop(0, shade(look.top, 0.12));
  g.addColorStop(1, topDark);
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(0, 0.02, 0.31, 0.17, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.45)';
  c.lineWidth = 0.022;
  c.stroke();
  if (look.outfit === 'suit' || look.outfit === 'blazer') {
    // Shirt collar showing at the front of the jacket.
    c.fillStyle = look.outfit === 'suit' ? '#f1f2f4' : '#dfe3ea';
    c.beginPath();
    c.moveTo(-0.08, -0.14);
    c.lineTo(0.08, -0.14);
    c.lineTo(0, -0.02);
    c.closePath();
    c.fill();
    if (look.outfit === 'suit') {
      c.fillStyle = '#7a1f2b';
      c.fillRect(-0.015, -0.12, 0.03, 0.09);
    }
    c.strokeStyle = 'rgba(0,0,0,0.3)';
    c.lineWidth = 0.015;
    c.beginPath();
    c.moveTo(0, -0.02);
    c.lineTo(0, 0.18);
    c.stroke();
  } else if (look.outfit === 'hoodie') {
    c.fillStyle = topDark;
    c.beginPath();
    c.ellipse(0, 0.14, 0.15, 0.07, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#d9dce1';
    c.lineWidth = 0.015;
    c.beginPath();
    c.moveTo(-0.05, -0.14);
    c.lineTo(-0.05, -0.06);
    c.moveTo(0.05, -0.14);
    c.lineTo(0.05, -0.06);
    c.stroke();
  } else if (look.outfit === 'shirt') {
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 0.012;
    c.beginPath();
    c.moveTo(0, -0.15);
    c.lineTo(0, 0.18);
    c.stroke();
  }

  // Head.
  const hy = -0.02;
  const hr = 0.165;
  c.fillStyle = shade(skin, -0.12);
  c.beginPath();
  c.arc(-hr, hy + 0.01, 0.045, 0, Math.PI * 2);
  c.arc(hr, hy + 0.01, 0.045, 0, Math.PI * 2);
  c.fill();
  const hg = c.createRadialGradient(-0.05, hy - 0.06, 0.02, 0, hy, hr);
  hg.addColorStop(0, shade(skin, 0.14));
  hg.addColorStop(1, skin);
  c.fillStyle = hg;
  c.beginPath();
  c.arc(0, hy, hr, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.4)';
  c.lineWidth = 0.02;
  c.stroke();

  // Hair.
  const hair = look.hair;
  if (look.style === 'long') {
    c.fillStyle = hair;
    c.beginPath();
    c.ellipse(0, hy + 0.17, 0.15, 0.13, 0, 0, Math.PI * 2);
    c.fill();
  }
  if (look.style === 'bun') {
    c.fillStyle = shade(hair, -0.2);
    c.beginPath();
    c.arc(0, hy + 0.19, 0.075, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = look.style === 'buzz' ? 0.55 : 1;
  c.fillStyle = hair;
  hairPath(c, hy, hr + 0.012);
  c.fill();
  c.globalAlpha = 1;
  if (look.style === 'curly') {
    c.fillStyle = hair;
    for (let i = 0; i < 9; i++) {
      const ang = -Math.PI / 2 + 1.0 + (i / 8) * (Math.PI * 2 - 2.0);
      c.beginPath();
      c.arc(Math.cos(ang) * hr, hy + Math.sin(ang) * hr, 0.05, 0, Math.PI * 2);
      c.fill();
    }
  }
  if (look.style === 'side') {
    c.strokeStyle = shade(hair, 0.25);
    c.lineWidth = 0.012;
    c.beginPath();
    c.moveTo(-0.06, hy - 0.1);
    c.lineTo(-0.03, hy + 0.12);
    c.stroke();
  }
  // Specular highlight on the hair.
  c.fillStyle = 'rgba(255,255,255,0.08)';
  c.beginPath();
  c.ellipse(-0.05, hy + 0.03, 0.06, 0.035, -0.5, 0, Math.PI * 2);
  c.fill();

  if (look.headset) {
    c.strokeStyle = '#1b1d21';
    c.lineWidth = 0.035;
    c.beginPath();
    c.moveTo(-hr - 0.02, hy + 0.01);
    c.quadraticCurveTo(0, hy + 0.05, hr + 0.02, hy + 0.01);
    c.stroke();
    c.fillStyle = '#2a2d33';
    rr(c, -hr - 0.06, hy - 0.05, 0.07, 0.11, 0.02);
    c.fill();
    rr(c, hr - 0.01, hy - 0.05, 0.07, 0.11, 0.02);
    c.fill();
    c.strokeStyle = '#2a2d33';
    c.lineWidth = 0.018;
    c.beginPath();
    c.moveTo(-hr - 0.03, hy - 0.03);
    c.quadraticCurveTo(-0.14, hy - 0.16, -0.05, hy - 0.19);
    c.stroke();
  }
  c.restore();
}

function nameTag(
  c: CanvasRenderingContext2D, a: Agent, v: Vis, speaking: boolean, hovered: boolean,
  below = false, accent = roleColor(a.role),
) {
  const label = a.name.split(' ')[0]!;
  c.font = `600 ${T * 0.3}px Inter, sans-serif`;
  const tw = c.measureText(label).width;
  const w = tw + 20;
  const h = T * 0.46;
  const x = X(v.x) - w / 2;
  // Seated at a trading desk, the tag hangs below the chair so it never covers the screens.
  const y = below ? X(v.y) + T * 0.72 : X(v.y) - T * 1.25;
  c.fillStyle = speaking ? 'rgba(20,50,90,0.92)' : 'rgba(10,14,22,0.78)';
  rr(c, x, y, w, h, h / 2);
  c.fill();
  if (speaking || hovered) {
    c.strokeStyle = speaking ? '#4da3ff' : 'rgba(255,255,255,0.5)';
    c.lineWidth = 1.2;
    rr(c, x, y, w, h, h / 2);
    c.stroke();
  }
  c.fillStyle = STATUS_COLOR[a.status] ?? '#8b9ab5';
  c.beginPath();
  c.arc(x + 8, y + h / 2, 3.2, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#e3e9f3';
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(label, x + 14, y + h / 2 + 0.5);
  c.fillStyle = accent;
  c.fillRect(x + 6, y + h - 2, w - 12, 2);
  c.textBaseline = 'alphabetic';
  if (a.status === 'onboarding') {
    c.font = `700 ${T * 0.22}px Inter, sans-serif`;
    c.fillStyle = '#a78bfa';
    c.textAlign = 'center';
    c.fillText('NEW HIRE', X(v.x), y - 3);
  }
}

function bubble(c: CanvasRenderingContext2D, v: Vis, text: string) {
  const maxW = T * 9.5;
  c.font = `500 ${T * 0.34}px Inter, sans-serif`;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  let used = 0;
  for (const w of words) {
    const probe = cur ? `${cur} ${w}` : w;
    if (c.measureText(probe).width > maxW - 20 && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === 3) break;
    } else {
      cur = probe;
    }
    used++;
  }
  if (lines.length < 3 && cur) lines.push(cur);
  if (used < words.length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1]!.replace(/\s+\S*$/, '')}…`;

  const lh = T * 0.46;
  const bw = Math.min(maxW, Math.max(...lines.map((l) => c.measureText(l).width)) + 20);
  const bh = lines.length * lh + 12;
  let bx = X(v.x) - bw / 2;
  let by = X(v.y) - T * 1.45 - bh - 10;
  bx = Math.max(6, Math.min(W - bw - 6, bx));
  by = Math.max(6, by);

  c.save();
  c.shadowColor = 'rgba(0,0,0,0.55)';
  c.shadowBlur = 14;
  c.shadowOffsetY = 5;
  c.fillStyle = '#f7f8fa';
  rr(c, bx, by, bw, bh, 9);
  c.fill();
  c.restore();
  const tail = Math.max(bx + 12, Math.min(bx + bw - 12, X(v.x)));
  c.fillStyle = '#f7f8fa';
  c.beginPath();
  c.moveTo(tail - 6, by + bh - 1);
  c.lineTo(tail + 6, by + bh - 1);
  c.lineTo(tail, by + bh + 8);
  c.closePath();
  c.fill();
  c.fillStyle = '#1b2230';
  c.textAlign = 'left';
  c.textBaseline = 'top';
  lines.forEach((l, i) => c.fillText(l, bx + 10, by + 7 + i * lh));
  c.textBaseline = 'alphabetic';
}

function tooltip(c: CanvasRenderingContext2D, a: Agent, v: Vis, teamName: string, teamColor: string) {
  const lines = [
    { t: a.name, f: `700 ${T * 0.36}px Inter, sans-serif`, col: '#e6ecf7' },
    { t: `${ROLE_LABEL[a.role]} · ${teamName}`, f: `600 ${T * 0.28}px Inter, sans-serif`, col: teamColor },
    { t: `● ${STATUS_LABEL[a.status]}`, f: `600 ${T * 0.28}px Inter, sans-serif`, col: STATUS_COLOR[a.status] ?? '#8b9ab5' },
    { t: a.activity, f: `400 ${T * 0.28}px Inter, sans-serif`, col: '#a9b6cc' },
    {
      t: `${a.calls_won}/${a.calls} calls won · ${fmtInr(a.pnl_inr)}`,
      f: `500 ${T * 0.26}px 'JetBrains Mono', monospace`,
      col: a.pnl_inr >= 0 ? '#22c98a' : '#ff5f6d',
    },
  ];
  let w = 0;
  for (const l of lines) {
    c.font = l.f;
    w = Math.max(w, c.measureText(l.t).width);
  }
  w += 24;
  const lh = T * 0.46;
  const h = lines.length * lh + 14;
  let x = X(v.x) + T * 0.6;
  let y = X(v.y) - h / 2;
  if (x + w > W - 6) x = X(v.x) - T * 0.6 - w;
  y = Math.max(6, Math.min(H - h - 6, y));
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.6)';
  c.shadowBlur = 16;
  c.fillStyle = 'rgba(15,20,32,0.96)';
  rr(c, x, y, w, h, 8);
  c.fill();
  c.restore();
  c.strokeStyle = roleColor(a.role);
  c.lineWidth = 1;
  rr(c, x, y, w, h, 8);
  c.stroke();
  c.textAlign = 'left';
  c.textBaseline = 'top';
  lines.forEach((l, i) => {
    c.font = l.f;
    c.fillStyle = l.col;
    c.fillText(l.t, x + 12, y + 8 + i * lh);
  });
  c.textBaseline = 'alphabetic';
}

// ── Frame ──────────────────────────────────────────────────────────────────

function restingAngle(a: Agent, v: Vis): number | null {
  const atDesk = Math.hypot(v.x - a.desk.x, v.y - a.desk.y) < 0.35;
  if (atDesk) return a.role === 'ceo' ? Math.PI / 2 : -Math.PI / 2;
  if (a.status === 'in_meeting') return Math.atan2(MEETING_CENTER.y - v.y, MEETING_CENTER.x - v.x);
  if (a.status === 'break') {
    const tables = [...CAFE_TABLES, { ...LOUNGE_TABLE, r: 0 }];
    let best = tables[0]!;
    for (const tb of tables) if (Math.hypot(tb.x - v.x, tb.y - v.y) < Math.hypot(best.x - v.x, best.y - v.y)) best = tb;
    return Math.atan2(best.y - v.y, best.x - v.x);
  }
  return null;
}

function drawFrame(
  c: CanvasRenderingContext2D,
  s: FloorState,
  vis: Map<string, Vis>,
  speaker: { agentId: string; text: string } | undefined,
  hover: string | null,
  t: number,
) {
  fireFrame(t);

  // Desk screens reflect whoever is actually sitting there.
  DESKS.forEach((d, i) => {
    const who = s.agents.find((a) => a.desk.x === d.x && a.desk.y === d.y);
    const v = who ? vis.get(who.id) : undefined;
    const seated = who && v && Math.hypot(v.x - d.x, v.y - d.y) < 0.4;
    const mode: ScreenMode = !seated
      ? 'off'
      : who!.status === 'onboarding' ? 'setup' : who!.status === 'working' ? 'active' : 'idle';
    deskMonitors(c, d.x, d.y, mode, t, i);
  });

  // CEO's monitors face the CEO — we see their backs and the glow.
  const ceo = s.agents.find((a) => a.role === 'ceo');
  const ceoIn = ceo && vis.get(ceo.id) && Math.hypot(vis.get(ceo.id)!.x - CEO_DESK.x, vis.get(ceo.id)!.y - CEO_DESK.y) < 0.4;
  for (const ox of [-0.55, 0.55]) {
    if (ceoIn) {
      const g = c.createRadialGradient(X(CEO_DESK.x + ox), X(3.3), 1, X(CEO_DESK.x + ox), X(3.3), X(0.9));
      g.addColorStop(0, 'rgba(90,170,255,0.22)');
      g.addColorStop(1, 'rgba(90,170,255,0)');
      c.fillStyle = g;
      c.fillRect(X(CEO_DESK.x + ox - 0.9), X(2.4), X(1.8), X(1.8));
    }
    box(c, CEO_DESK.x + ox - 0.45, 3.45, 0.9, 0.16, '#16181d', { r: 2 });
    c.fillStyle = '#3a3f48';
    c.fillRect(X(CEO_DESK.x + ox) - 2, X(3.6), 4, X(0.18));
  }

  // Desk team signage at the left end of each row.
  for (const team of s.teams) {
    const y = DESK_ROWS[team.row];
    if (y === undefined) continue;
    const cy = X(y - 0.6);
    c.save();
    c.translate(X(1.62), cy);
    c.rotate(-Math.PI / 2);
    c.font = `800 ${T * 0.3}px Inter, sans-serif`;
    const label = team.name.toUpperCase();
    const tw = c.measureText(label).width;
    c.fillStyle = 'rgba(8,12,20,0.7)';
    rr(c, -tw / 2 - 8, -T * 0.26, tw + 16, T * 0.5, 4);
    c.fill();
    c.fillStyle = team.color;
    c.fillRect(-tw / 2 - 8, T * 0.2, tw + 16, 2);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, 0, 0);
    c.restore();
  }
  c.textBaseline = 'alphabetic';

  videoWall(c, s);
  boardroomScreen(c, s);

  // Laptops open in front of whoever is seated at the boardroom table.
  if (s.meeting && s.meeting.phase !== 'done') {
    s.agents.forEach((a, i) => {
      const v = vis.get(a.id);
      if (!v || a.status !== 'in_meeting' || v.moving) return;
      const seat = MEETING_SEATS.find((q) => !q.standing && Math.hypot(q.x - v.x, q.y - v.y) < 0.3);
      const head = Math.hypot(v.x - 44.6, v.y - 15.5) < 0.3;
      if (!seat && !head) return;
      const ang = Math.atan2(MEETING_CENTER.y - v.y, MEETING_CENTER.x - v.x);
      laptop(c, v.x + Math.cos(ang) * 0.95, v.y + Math.sin(ang) * 0.95, ang, t, i * 7);
    });
  }

  // Server LEDs.
  for (const [ri, rk] of RACKS.entries()) {
    for (let k = 0; k < 10; k++) {
      const on = Math.sin(t / 170 + ri * 2.1 + k * 1.3) > 0.1;
      c.fillStyle = on ? (k % 4 === 0 ? '#ffb443' : '#3ddc84') : '#12301f';
      c.fillRect(X(rk.x - 0.5 + k * 0.1), X(rk.y + 2.18), 2, 2);
    }
  }

  // Steam off the coffee machine.
  c.strokeStyle = 'rgba(255,255,255,0.18)';
  c.lineWidth = 1.2;
  for (let i = 0; i < 2; i++) {
    const ph = t / 700 + i * 2;
    c.beginPath();
    c.moveTo(X(CAFE_COUNTER.x + 0.6 + i * 0.2), X(CAFE_COUNTER.y + 0.45));
    c.bezierCurveTo(
      X(CAFE_COUNTER.x + 0.5 + Math.sin(ph) * 0.15 + i * 0.2), X(CAFE_COUNTER.y + 0.25),
      X(CAFE_COUNTER.x + 0.7 + Math.cos(ph) * 0.15 + i * 0.2), X(CAFE_COUNTER.y + 0.1),
      X(CAFE_COUNTER.x + 0.6 + i * 0.2), X(CAFE_COUNTER.y - 0.1),
    );
    c.stroke();
  }

  // Fire for everyone goes into its own layer, composited once, behind people.
  for (const a of s.agents) {
    const v = vis.get(a.id);
    if (v) drawFire(a.id, v, s.desk_mode ?? 'normal', t);
  }
  compositeFire(c);

  // People, painted back-to-front.
  const order = [...s.agents].sort((a, b) => (vis.get(a.id)?.y ?? a.y) - (vis.get(b.id)?.y ?? b.y));
  for (const a of order) {
    const v = vis.get(a.id);
    if (!v) continue;
    const atDesk = Math.hypot(v.x - a.desk.x, v.y - a.desk.y) < 0.35;
    const standingSpot = MEETING_SEATS.some((q) => q.standing && Math.hypot(q.x - v.x, q.y - v.y) < 0.3);
    const seated = !v.moving && !standingSpot && (atDesk || a.status === 'in_meeting' || a.status === 'break');
    const speaking = speaker?.agentId === a.id;
    if (speaking) {
      const pulse = 1 + Math.sin(t / 200) * 0.12;
      c.strokeStyle = 'rgba(77,163,255,0.7)';
      c.lineWidth = 2;
      c.beginPath();
      c.ellipse(X(v.x), X(v.y) + 3, T * 0.62 * PS * pulse, T * 0.48 * PS * pulse, 0, 0, Math.PI * 2);
      c.stroke();
    }
    person(c, a, v, lookFor(a), {
      seated,
      typing: seated && atDesk && a.status === 'working',
      coffee: a.status === 'break',
      carrying: v.moving && a.status === 'walking' && a.role !== 'ceo' && (a.hue % 3 === 0),
    }, t);
  }

  for (const a of order) {
    const v = vis.get(a.id);
    if (!v) continue;
    const atFloorDesk = a.role !== 'ceo' && !v.moving && Math.hypot(v.x - a.desk.x, v.y - a.desk.y) < 0.35;
    const accent = s.teams.find((t) => t.id === a.team)?.color ?? '#c9a45b';
    nameTag(c, a, v, speaker?.agentId === a.id, hover === a.id, atFloorDesk, accent);
  }

  if (speaker) {
    const v = vis.get(speaker.agentId);
    if (v) bubble(c, v, speaker.text);
  }

  if (hover) {
    const a = s.agents.find((q) => q.id === hover);
    const v = a ? vis.get(a.id) : undefined;
    const team = a ? s.teams.find((t) => t.id === a.team) : undefined;
    if (a && v) tooltip(c, a, v, team?.name ?? 'Leadership', team?.color ?? roleColor(a.role));
  }
}

// ── Component ──────────────────────────────────────────────────────────────

interface Props {
  state: FloorState;
  /** The most recent thing said, for the speech bubble. */
  speaker?: { agentId: string; text: string };
}

export default function Office({ state, speaker }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ state, speaker });
  latest.current = { state, speaker };
  const hover = useRef<string | null>(null);
  const vis = useRef(new Map<string, Vis>());

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const c = canvas.getContext('2d');
    if (!c) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    // The static layer is expensive; paint it once.
    const bg = document.createElement('canvas');
    bg.width = W * dpr;
    bg.height = H * dpr;
    const bc = bg.getContext('2d')!;
    bc.scale(dpr, dpr);
    paintStatic(bc);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { state: s, speaker: sp } = latest.current;

      // Ease each person toward their latest server position.
      const seen = new Set<string>();
      for (const a of s.agents) {
        seen.add(a.id);
        let v = vis.current.get(a.id);
        if (!v) {
          v = { x: a.x, y: a.y, angle: -Math.PI / 2, phase: 0, moving: false };
          vis.current.set(a.id, v);
        }
        const dx = a.x - v.x;
        const dy = a.y - v.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 6) {
          v.x = a.x;
          v.y = a.y;
        } else {
          const k = 1 - Math.exp(-dt * 9);
          v.x += dx * k;
          v.y += dy * k;
        }
        v.moving = dist > 0.04 || a.status === 'walking';
        if (dist > 0.04) {
          v.angle = lerpAngle(v.angle, Math.atan2(dy, dx), 1 - Math.exp(-dt * 12));
          v.phase += dt * 11;
        } else {
          const rest = restingAngle(a, v);
          if (rest !== null) v.angle = lerpAngle(v.angle, rest, 1 - Math.exp(-dt * 6));
        }
      }
      for (const id of vis.current.keys()) if (!seen.has(id)) vis.current.delete(id);

      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.drawImage(bg, 0, 0, W, H);
      drawFrame(c, s, vis.current, sp, hover.current, now);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const lx = ((e.clientX - r.left) / r.width) * OFFICE_W;
    const ly = ((e.clientY - r.top) / r.height) * OFFICE_H;
    let best: string | null = null;
    let bd = 0.6;
    for (const [id, v] of vis.current) {
      const d = Math.hypot(v.x - lx, v.y - ly);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    hover.current = best;
    e.currentTarget.style.cursor = best ? 'pointer' : 'default';
  };

  return (
    <canvas
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={() => (hover.current = null)}
    />
  );
}
