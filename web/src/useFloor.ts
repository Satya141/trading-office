import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, FloorState, ServerMessage, Utterance } from '../../shared/types.js';

/**
 * Socket client. The server pushes the whole FloorState frequently enough that
 * the UI can stay a pure projection of it — no client-side merging of deltas,
 * so there is exactly one source of truth for what the floor looks like.
 */
export function useFloor() {
  const [state, setState] = useState<FloorState | null>(null);
  const [connected, setConnected] = useState(false);
  /** The newest utterance, used to drive the speech bubble. */
  const [latest, setLatest] = useState<Utterance | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current = sock;

      sock.onopen = () => setConnected(true);
      sock.onclose = () => {
        setConnected(false);
        if (!closed) retry.current = setTimeout(connect, 1500);
      };
      sock.onerror = () => sock.close();
      sock.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        if (msg.type === 'state') setState(msg.state);
        else if (msg.type === 'utterance') setLatest(msg.utterance);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry.current) clearTimeout(retry.current);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
  }, []);

  return { state, connected, latest, send };
}
