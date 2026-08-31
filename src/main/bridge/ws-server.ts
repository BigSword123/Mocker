import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { TrafficEvent } from '../../shared/types';

const SNAPSHOT_LIMIT = 500;

export class Bridge {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private recent: TrafficEvent[] = [];
  private boundPort?: number;

  get port(): number | undefined {
    return this.boundPort;
  }

  async start(port: number): Promise<number> {
    if (this.wss) throw new Error('Bridge already started');
    const wss = new WebSocketServer({ port, host: '127.0.0.1' });
    this.wss = wss;
    // The http server forwards errors (e.g. EADDRINUSE) onto the WSS; an unhandled
    // 'error' on an EventEmitter throws and crashes the Electron main process.
    wss.on('error', () => {});
    wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'snapshot', events: this.recent }));
      ws.on('close', () => this.clients.delete(ws));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        wss.once('listening', () => {
          wss.removeListener('error', reject);
          resolve();
        });
        wss.once('error', reject);
      });
    } catch (err) {
      this.wss = undefined;
      throw err;
    }
    this.boundPort = (wss.address() as AddressInfo).port;
    return this.boundPort;
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
    this.boundPort = undefined;
  }
}
