import { WebSocket, WebSocketServer } from 'ws';
import type { TrafficEvent } from '../../shared/types';

const SNAPSHOT_LIMIT = 500;

export class Bridge {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private recent: TrafficEvent[] = [];

  async start(port: number): Promise<void> {
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'snapshot', events: this.recent }));
      ws.on('close', () => this.clients.delete(ws));
    });
    await new Promise<void>((resolve) => this.wss!.once('listening', resolve));
  }

  publish(event: TrafficEvent): void {
    const idx = this.recent.findIndex((e) => e.id === event.id);
    if (idx === -1) {
      this.recent.push(event);
      if (this.recent.length > SNAPSHOT_LIMIT) this.recent.shift();
    } else {
      this.recent[idx] = event;
    }
    const msg = JSON.stringify({ type: 'event', event });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = undefined;
  }
}
