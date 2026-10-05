import 'dotenv/config';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, Role } from '../../shared/types.js';
import { Floor } from './floor.js';

// Deliberately not `PORT`: dev harnesses and hosting platforms inject that for
// the web port, and dotenv will not override an already-set variable — which
// silently puts the API on top of Vite.
const PORT = Number(process.env.SERVER_PORT ?? 8787);
const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const CAPITAL = Number(process.env.STARTING_CAPITAL_INR ?? 2_500_000);

const app = express();
const http = createServer(app);
const wss = new WebSocketServer({ server: http, path: '/ws' });

const clients = new Set<WebSocket>();

function broadcast(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

const floor = new Floor(SYMBOLS, CAPITAL, broadcast);

wss.on('connection', (ws) => {
  clients.add(ws);
  // Hand the newcomer the full picture immediately.
  ws.send(JSON.stringify({ type: 'state', state: floor.state() }));

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'say':
        floor.say(msg.text);
        break;
      case 'pause':
        floor.setRunning(false);
        break;
      case 'resume':
        floor.setRunning(true);
        break;
      case 'speed':
        floor.setSpeed(msg.value);
        break;
      case 'call_meeting':
        floor.callMeeting(msg.symbol);
        break;
      case 'close_position':
        floor.closePosition(msg.id);
        break;
      case 'hire':
        floor.hire(msg.role as Role);
        break;
      case 'desk_mode':
        floor.setDeskMode(msg.value);
        break;
      case 'manual_trade':
        floor.ownerTrade(msg.symbol, msg.side, msg.margin_inr, msg.leverage);
        break;
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

app.get('/api/health', (_req, res) => {
  const s = floor.state();
  res.json({
    ok: true,
    jev_live: s.jev_live,
    voice_live: s.voice_live,
    symbols: SYMBOLS,
    usdinr: s.usdinr,
    agents: s.agents.length,
  });
});

// In production the built frontend is served from the same origin.
app.use(express.static('dist/web'));

http.listen(PORT, () => {
  console.log(`\n  Trading floor listening on http://localhost:${PORT}`);
  console.log(`  Covering ${SYMBOLS.join(', ')}  ·  capital ₹${CAPITAL.toLocaleString('en-IN')}\n`);
  void floor.start();
});

process.on('SIGINT', () => {
  floor.stop();
  http.close(() => process.exit(0));
});
