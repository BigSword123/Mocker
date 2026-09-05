import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;

const RULE_NAMES = ['e2e-filter-get', 'e2e-filter-post', 'e2e-filter-404', 'e2e-replay'];

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await win.evaluate(async (names: string[]) => {
    for (const r of await window.api.rulesList()) {
      if (names.includes(r.name)) await window.api.rulesRemove(r.id);
    }
  }, RULE_NAMES);
  await app.close();
});

async function ensureProxy(): Promise<number> {
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  return (await win.evaluate(() => window.api.proxyStatus())).port;
}

async function fetchViaProxy(port: number, method: string, url: string): Promise<void> {
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    await fetch(url, { method, dispatcher: agent });
  } finally {
    await agent.close();
  }
}

test('faceted filter narrows the traffic list', async () => {
  const port = await ensureProxy();

  await win.evaluate(async (names: string[]) => {
    await window.api.rulesAdd({
      name: names[0]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/filter-get', method: 'GET' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'get-ok' },
    });
    await window.api.rulesAdd({
      name: names[1]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/filter-post', method: 'POST' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'post-ok' },
    });
    await window.api.rulesAdd({
      name: names[2]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/filter-404', method: 'GET' },
      action: { status: 404, headers: {}, body: 'missing' },
    });
  }, RULE_NAMES);

  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/filter-get');
  await fetchViaProxy(port, 'POST', 'http://e2e.example.test/filter-post');
  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/filter-404');

  const table = win.locator('.traffic-table');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-get');
    expect(text).toContain('filter-post');
    expect(text).toContain('filter-404');
  }).toPass({ timeout: 10_000 });

  await win.locator('[data-testid="filter-method"]').selectOption('GET');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-get');
    expect(text).not.toContain('filter-post');
  }).toPass({ timeout: 5_000 });
  await win.locator('[data-testid="filter-method"]').selectOption('');

  await win.locator('[data-testid="filter-status"]').selectOption('4');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-404');
    expect(text).not.toContain('filter-get');
  }).toPass({ timeout: 5_000 });
  await win.locator('[data-testid="filter-status"]').selectOption('');

  await win.locator('[data-testid="filter-text"]').fill('filter-post');
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-post');
    expect(text).not.toContain('filter-get');
  }).toPass({ timeout: 5_000 });

  await win.locator('[data-testid="filter-clear"]').click();
  await expect(async () => {
    const text = await table.innerText();
    expect(text).toContain('filter-get');
    expect(text).toContain('filter-post');
  }).toPass({ timeout: 5_000 });
});

test('replay produces a new entry that honors mock rules', async () => {
  const port = await ensureProxy();
  await win.evaluate(async (names: string[]) => {
    await window.api.rulesAdd({
      name: names[3]!,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/replay-me', method: 'ANY' },
      action: { status: 201, headers: { 'content-type': 'text/plain' }, body: 'replayed' },
    });
  }, RULE_NAMES);

  await fetchViaProxy(port, 'POST', 'http://e2e.example.test/replay-me');
  const firstRow = win.locator('.traffic-table .row', { hasText: 'replay-me' }).first();
  await firstRow.waitFor({ state: 'visible', timeout: 10_000 });

  const rowsBefore = await win.locator('.traffic-table .row', { hasText: 'replay-me' }).count();
  await firstRow.click();
  await win.locator('[data-testid="replay"]').click();

  await expect(async () => {
    const rows = await win.locator('.traffic-table .row', { hasText: 'replay-me' }).count();
    expect(rows).toBe(rowsBefore + 1);
  }).toPass({ timeout: 10_000 });

  await expect(win.locator('.badge-replay')).toHaveCount(1, { timeout: 10_000 });
});

test('copy as cURL copies to clipboard and shows feedback', async () => {
  const row = win.locator('.traffic-table .row', { hasText: 'replay-me' }).first();
  await row.click();
  await win.locator('[data-testid="copy-curl"]').click();
  await expect(win.locator('[data-testid="copy-curl"]')).toHaveText('已复制', { timeout: 5_000 });
});
