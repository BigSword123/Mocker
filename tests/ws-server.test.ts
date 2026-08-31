import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Bridge } from '../src/main/bridge/ws-server';
import type { TrafficEvent } from '../src/shared/types';

let bridge: Bridge;
const PORT = 18899;

const event = (id: string): TrafficEvent => ({
  id,
  startedAt: Date.now(),
  method: 'GET',
  url: 'http://x.com/',
  host: 'x.com',
  path: '/',
  requestHeaders: {},
  mocked: false,
});

function connect(): Promise<{ ws: WebSocket; messages: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const messages: unknown[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

beforeAll(async () => {
  bridge = new Bridge();
  await bridge.start(PORT);
});

afterAll(async () => {
  await bridge.stop();
});

describe('Bridge', () => {
  it('sends a snapshot on connect and broadcasts new events', async () => {
    bridge.publish(event('before-connect'));
    const { ws, messages } = await connect();
    await waitUntil(() => messages.length >= 1);
    expect(messages[0]).toMatchObject({ type: 'snapshot', events: [{ id: 'before-connect' }] });

    bridge.publish(event('after-connect'));
    await waitUntil(() => messages.length >= 2);
    expect(messages[1]).toMatchObject({ type: 'event', event: { id: 'after-connect' } });
    ws.close();
  });

  it('caps the snapshot ring buffer', async () => {
    for (let i = 0; i < 600; i++) bridge.publish(event(`bulk-${i}`));
    const { ws, messages } = await connect();
    await waitUntil(() => messages.length >= 1);
    const snapshot = messages[0] as { events: TrafficEvent[] };
    expect(snapshot.events.length).toBeLessThanOrEqual(500);
    ws.close();
  });
});

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
