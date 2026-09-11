import { describe, expect, test } from 'vitest';
import { BODY_WINDOW_TTL_MS, BodyWindowStore, type BodyWindowPayload } from '../src/main/body-window';

const PAYLOAD: BodyWindowPayload = {
  eventId: 'ev-1',
  method: 'GET',
  url: 'https://example.com/a',
  status: 200,
  body: '{"a":1}',
};

function makeStore() {
  let now = 1_000;
  let seq = 0;
  const store = new BodyWindowStore({
    now: () => now,
    newToken: () => `tok-${(seq += 1)}`,
  });
  return { store, advance: (ms: number) => { now += ms; } };
}

describe('BodyWindowStore', () => {
  test('take returns the payload put under that token', () => {
    const { store } = makeStore();
    const token = store.put(PAYLOAD);
    expect(store.take(token)).toEqual(PAYLOAD);
  });

  test('take is one-shot: the payload is gone afterwards', () => {
    const { store } = makeStore();
    const token = store.put(PAYLOAD);
    store.take(token);
    expect(store.take(token)).toBeNull();
    expect(store.size).toBe(0);
  });

  test('unknown token returns null and does not throw', () => {
    const { store } = makeStore();
    expect(store.take('nope')).toBeNull();
  });

  test('each put gets its own token and payload', () => {
    const { store } = makeStore();
    const t1 = store.put(PAYLOAD);
    const t2 = store.put({ ...PAYLOAD, eventId: 'ev-2' });
    expect(t1).not.toBe(t2);
    expect(store.take(t2)?.eventId).toBe('ev-2');
    expect(store.take(t1)?.eventId).toBe('ev-1');
    expect(store.size).toBe(0);
  });

  test('expired payload is refused even before any sweep runs', () => {
    const { store, advance } = makeStore();
    const token = store.put(PAYLOAD);
    advance(BODY_WINDOW_TTL_MS + 1);
    expect(store.take(token)).toBeNull();
  });

  test('payload inside the TTL still resolves', () => {
    const { store, advance } = makeStore();
    const token = store.put(PAYLOAD);
    advance(BODY_WINDOW_TTL_MS - 1);
    expect(store.take(token)).toEqual(PAYLOAD);
  });

  test('put sweeps expired entries so a never-opened window cannot leak its body', () => {
    const { store, advance } = makeStore();
    store.put(PAYLOAD);
    expect(store.size).toBe(1);
    advance(BODY_WINDOW_TTL_MS + 1);
    store.put({ ...PAYLOAD, eventId: 'ev-2' });
    expect(store.size).toBe(1);
  });

  test('sweep keeps entries that are still within the TTL', () => {
    const { store, advance } = makeStore();
    const live = store.put(PAYLOAD);
    advance(10);
    store.put({ ...PAYLOAD, eventId: 'ev-2' });
    expect(store.size).toBe(2);
    expect(store.take(live)).toEqual(PAYLOAD);
  });

  test('real token generator produces unique non-empty tokens', () => {
    const store = new BodyWindowStore();
    const tokens = new Set(Array.from({ length: 50 }, () => store.put(PAYLOAD)));
    expect(tokens.size).toBe(50);
    for (const t of tokens) expect(t.length).toBeGreaterThan(0);
  });
});
