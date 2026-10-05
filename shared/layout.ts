import type { Zone, ZoneKind } from './types.js';

/**
 * The floor plan, shared by the simulation and the renderer so furniture and
 * people can never drift out of alignment. Units are tiles; the renderer
 * scales them to pixels.
 *
 * 48×30 tiles. Rooms are walled, with doors onto a corridor network — agents
 * walk door → corridor → door rather than through walls.
 */

export const OFFICE_W = 48;
export const OFFICE_H = 30;

export const ZONES: Zone[] = [
  { kind: 'reception', label: 'Reception', x: 1, y: 1, w: 10, h: 6 },
  { kind: 'lounge', label: 'Lounge', x: 13, y: 1, w: 13, h: 6 },
  { kind: 'ceo_cabin', label: "CEO's Office", x: 30, y: 1, w: 17, h: 7 },
  { kind: 'desk', label: 'Trading Floor', x: 1, y: 9, w: 25, h: 13 },
  { kind: 'meeting_room', label: 'Boardroom', x: 29, y: 10, w: 18, h: 11 },
  { kind: 'cafeteria', label: 'Cafeteria', x: 1, y: 24, w: 16, h: 5 },
  { kind: 'booths', label: 'Focus Booths', x: 19, y: 24, w: 7, h: 5 },
  { kind: 'server_room', label: 'Server Room', x: 36, y: 23, w: 11, h: 6 },
];

// ── Doors & corridors ──────────────────────────────────────────────────────

export interface Door {
  zone: ZoneKind;
  side: 'top' | 'bottom' | 'left' | 'right';
  /** Centre of the opening along the wall (x for top/bottom, y for left/right). */
  at: number;
  width: number;
  /** Just inside the room. */
  inside: { x: number; y: number };
  /** Name of the corridor node just outside. */
  node: string;
  glass?: boolean;
}

export const DOORS: Door[] = [
  { zone: 'reception', side: 'bottom', at: 6, width: 1.6, inside: { x: 6, y: 6.2 }, node: 'rec' },
  { zone: 'lounge', side: 'bottom', at: 19.5, width: 1.6, inside: { x: 19.5, y: 6.2 }, node: 'lng' },
  { zone: 'ceo_cabin', side: 'bottom', at: 33, width: 1.6, inside: { x: 33, y: 7.2 }, node: 'ceo', glass: true },
  { zone: 'desk', side: 'right', at: 17.25, width: 1.8, inside: { x: 25.2, y: 17.25 }, node: 'trade' },
  { zone: 'meeting_room', side: 'left', at: 15.5, width: 1.8, inside: { x: 30, y: 15.5 }, node: 'meet', glass: true },
  { zone: 'cafeteria', side: 'top', at: 13, width: 1.8, inside: { x: 13, y: 24.9 }, node: 'cafe' },
  { zone: 'booths', side: 'top', at: 22.5, width: 1.6, inside: { x: 22.5, y: 24.9 }, node: 'booth' },
  { zone: 'server_room', side: 'top', at: 38.5, width: 1.6, inside: { x: 38.5, y: 23.9 }, node: 'srv' },
];

/** Corridor waypoints. Every straight edge between them is clear of walls. */
export const CORRIDOR_NODES: Record<string, { x: number; y: number }> = {
  rec: { x: 6, y: 8 },
  lng: { x: 19.5, y: 8 },
  top: { x: 27.5, y: 8.5 },
  ceo: { x: 33, y: 9 },
  meet: { x: 27.5, y: 15.5 },
  trade: { x: 27.5, y: 17.25 },
  bot: { x: 27.5, y: 22.6 },
  booth: { x: 22.5, y: 23 },
  cafe: { x: 13, y: 23 },
  srv: { x: 38.5, y: 22 },
};

export const CORRIDOR_EDGES: [string, string][] = [
  ['rec', 'lng'],
  ['lng', 'top'],
  ['top', 'ceo'],
  ['top', 'meet'],
  ['meet', 'trade'],
  ['trade', 'bot'],
  ['bot', 'booth'],
  ['booth', 'cafe'],
  ['bot', 'srv'],
];

/** Glass walls, by zone and side — the rest are solid. */
export const GLASS_WALLS: { zone: ZoneKind; side: Door['side'] }[] = [
  { zone: 'meeting_room', side: 'left' },
  { zone: 'meeting_room', side: 'bottom' },
  { zone: 'ceo_cabin', side: 'bottom' },
  { zone: 'booths', side: 'top' },
];

// ── Trading floor ──────────────────────────────────────────────────────────

/** Two pods of four per row; each row is one desk team. */
export const DESK_COLS = [3.6, 6.0, 8.4, 10.8, 14.2, 16.6, 19.0, 21.4];
export const DESK_ROWS = [12, 16, 20];
export const POD_SIZE = 4;
/** Width of one desk position; four abut to form a pod. */
export const DESK_W = 2.4;
/** Desk surface sits this far above the seat (top edge, bottom edge). */
export const DESK_TOP = 1.75;
export const DESK_BOTTOM = 0.5;
/** Walkway below each desk row, and the vertical aisle joining them. */
export const AISLE_OFFSET = 1.25;
export const AISLE_X = 24.2;

/** Desk seats, in the order they get handed out. */
export const DESKS: { x: number; y: number }[] = DESK_ROWS.flatMap((y) =>
  DESK_COLS.map((x) => ({ x, y })),
);

/** Video wall mounted on the trading floor's top wall. */
export const VIDEO_WALL = { x: 3.2, y: 9.2, w: 18.4, h: 0.85 };

// ── CEO's office ───────────────────────────────────────────────────────────

/** The CEO sits behind the desk with the window at their back, facing the door. */
export const CEO_DESK = { x: 40.5, y: 2.3 };
export const CEO_TABLE = { x: 38.4, y: 3.0, w: 4.2, h: 1.4 };
export const CEO_GUEST_CHAIRS = [
  { x: 39.4, y: 5.3 },
  { x: 41.6, y: 5.3 },
];

// ── Boardroom ──────────────────────────────────────────────────────────────

export const MEETING_TABLE = { x: 32.5, y: 14, w: 11, h: 3 };
export const MEETING_CENTER = { x: 38, y: 15.5 };
/** The CEO always takes the head of the table. */
export const MEETING_HEAD = { x: 44.6, y: 15.5 };

const SIDE_XS = [33.6, 35.8, 38, 40.2, 42.4];
/** Seated positions, then standing room along the walls for big sessions. */
export const MEETING_SEATS: { x: number; y: number; standing?: boolean }[] = [
  ...SIDE_XS.map((x) => ({ x, y: 12.95 })),
  ...SIDE_XS.map((x) => ({ x, y: 18.05 })),
  { x: 31.4, y: 15.5 },
  { x: 34, y: 19.9, standing: true },
  { x: 36.5, y: 19.9, standing: true },
  { x: 39, y: 19.9, standing: true },
  { x: 41.5, y: 19.9, standing: true },
  { x: 46, y: 12.2, standing: true },
  { x: 46, y: 18.8, standing: true },
];

/** TV on the boardroom's top wall. */
export const MEETING_TV = { x: 34.5, y: 10.15, w: 7, h: 0.75 };

// ── Cafeteria & lounge ─────────────────────────────────────────────────────

export const CAFE_TABLES = [
  { x: 3.6, y: 26.6, r: 0.72 },
  { x: 7.4, y: 26.6, r: 0.72 },
  { x: 11.2, y: 26.6, r: 0.72 },
];

/** Chairs around each cafeteria table; people on break sit in them. */
export const CAFE_SPOTS: { x: number; y: number }[] = CAFE_TABLES.flatMap((t) => [
  { x: t.x - 1.05, y: t.y },
  { x: t.x + 1.05, y: t.y },
  { x: t.x, y: t.y - 1.05 },
  { x: t.x, y: t.y + 1.05 },
]);

export const CAFE_COUNTER = { x: 15.1, y: 24.5, w: 1.5, h: 4.1 };

/** Lounge sofa seats — overflow break spots. */
export const LOUNGE_SPOTS: { x: number; y: number }[] = [
  { x: 15.6, y: 3.4 },
  { x: 15.6, y: 4.8 },
  { x: 17.5, y: 2.3 },
  { x: 19.1, y: 2.3 },
];
export const LOUNGE_TABLE = { x: 17.4, y: 4.1 };

/** All break spots, cafeteria first. */
export const BREAK_SPOTS = [...CAFE_SPOTS, ...LOUNGE_SPOTS];

// ── Everything else ────────────────────────────────────────────────────────

export const RECEPTION_DESK = { x: 3.2, y: 3.4, w: 4.6, h: 1.1 };

export const BOOTHS = [
  { x: 19.3, w: 2.1 },
  { x: 21.6, w: 2.1 },
  { x: 23.9, w: 2.0 },
];

export const RACKS = [37.6, 39.2, 40.8, 42.4, 44.0].map((x) => ({ x, y: 24.6 }));

export const PLANTS: { x: number; y: number; big?: boolean }[] = [
  { x: 27, y: 1.8, big: true },
  { x: 29, y: 1.8 },
  { x: 1.8, y: 1.8 },
  { x: 10.2, y: 6.2 },
  { x: 25.2, y: 1.9 },
  { x: 25.3, y: 9.9 },
  { x: 1.8, y: 21.2 },
  { x: 45.9, y: 7.2, big: true },
  { x: 30.8, y: 7.2 },
  { x: 46.1, y: 10.9 },
  { x: 29.8, y: 21.8 },
  { x: 35.2, y: 28.3, big: true },
  { x: 1.8, y: 28.3 },
  { x: 16.2, y: 23.3 },
];

/** Tile-space rectangle containment. */
export function zoneAt(p: { x: number; y: number }): Zone | undefined {
  return ZONES.find(
    (z) => p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h,
  );
}
