import { create } from 'zustand';
import type { TrafficEvent } from '../../../shared/types';

const MAX_EVENTS = 2000;

interface TrafficState {
  list: TrafficEvent[];
  connected: boolean;
  paused: boolean;
  filter: string;
  setFilter: (f: string) => void;
  togglePause: () => void;
  clear: () => void;
  connect: (wsPort: number) => void;
}

let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let pending: TrafficEvent[] = [];

function upsert(list: TrafficEvent[], event: TrafficEvent): TrafficEvent[] {
  const idx = list.findIndex((e) => e.id === event.id);
  if (idx === -1) return [...list, event].slice(-MAX_EVENTS);
  const next = list.slice();
  next[idx] = event;
  return next;
}

export const useTrafficStore = create<TrafficState>((set, get) => ({
  list: [],
  connected: false,
  paused: false,
  filter: '',
  setFilter: (filter) => set({ filter }),
  togglePause: () => set({ paused: !get().paused }),
  clear: () => {
    pending = [];
    set({ list: [] });
  },
  connect: (wsPort) => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (ws) return;
    const open = () => {
      retryTimer = null;
      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      ws.onopen = () => set({ connected: true });
      ws.onclose = () => {
        ws = null;
        set({ connected: false });
        retryTimer = setTimeout(open, 2000);
      };
      ws.onmessage = (msg) => {
        let data: { type: string; events?: TrafficEvent[]; event?: TrafficEvent };
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (data.type === 'snapshot') {
          set({ list: data.events!.slice(-MAX_EVENTS) });
          pending = [];
        } else if (data.type === 'event') {
          if (get().paused) {
            pending.push(data.event!);
            if (pending.length > MAX_EVENTS) pending.shift();
            return;
          }
          let list = get().list;
          for (const p of pending) list = upsert(list, p);
          pending = [];
          set({ list: upsert(list, data.event!) });
        }
      };
    };
    open();
  },
}));
