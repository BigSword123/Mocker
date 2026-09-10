import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';
import { gzipSync } from 'node:zlib';

let app: ElectronApplication;
let win: Page;

const RULE_NAMES = ['e2e-body-gzip-b64', 'e2e-body-plain'];
const PLAIN = '{"msg":"gzip 世界"}';
const B64_BODY = Buffer.from(gzipSync(new TextEncoder().encode(PLAIN), { level: 9 })).toString('base64');

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

async function selectRow(keyword: string): Promise<void> {
  const row = win.locator('.traffic-table .row', { hasText: keyword }).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
}

test('base64 gzip 响应体可解压查看，且原始视图不被改写', async () => {
  const port = await ensureProxy();
  await win.evaluate(
    async ([name, body]: [string, string]) => {
      await window.api.rulesAdd({
        name,
        enabled: true,
        match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/body-gzip', method: 'GET' },
        action: { status: 200, headers: { 'content-type': 'text/plain' }, body },
      });
    },
    [RULE_NAMES[0]!, B64_BODY] as [string, string],
  );

  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/body-gzip');
  await selectRow('body-gzip');

  const content = win.locator('[data-testid="body-view-content"]');

  await expect(content).toContainText(B64_BODY.slice(0, 24), { timeout: 5_000 });

  const gunzipTab = win.locator('[data-testid="body-view-gunzip"]');
  await expect(gunzipTab).toBeEnabled();
  await gunzipTab.click();
  await expect(content).toContainText('gzip 世界', { timeout: 5_000 });

  const copyGunzip = win.locator('[data-testid="copy-body-gunzip"]');
  await expect(copyGunzip).toBeVisible();
  await copyGunzip.click();
  await expect(copyGunzip).toHaveText('已复制', { timeout: 5_000 });

  await win.locator('[data-testid="body-view-gzip"]').click();
  await expect(win.locator('[data-testid="body-gzip-stats"]')).toContainText('原始', { timeout: 5_000 });
  await expect(content).toContainText(/1f 8b/);
  await expect(content).toContainText(/00000000/);

  const copyBase64 = win.locator('[data-testid="copy-body-base64"]');
  await expect(copyBase64).toBeVisible();
  await expect(win.locator('[data-testid="copy-body-hex"]')).toBeVisible();
  await copyBase64.click();
  await expect(copyBase64).toHaveText('已复制', { timeout: 5_000 });

  await win.locator('[data-testid="body-view-raw"]').click();
  await expect(content).toContainText(B64_BODY.slice(0, 24), { timeout: 5_000 });
});

test('普通明文响应体的解压 tab 置灰，压缩视图仍可用', async () => {
  const port = await ensureProxy();
  await win.evaluate(async (name: string) => {
    await window.api.rulesAdd({
      name,
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/body-plain', method: 'GET' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'just plain text' },
    });
  }, RULE_NAMES[1]!);

  await fetchViaProxy(port, 'GET', 'http://e2e.example.test/body-plain');
  await selectRow('body-plain');

  const content = win.locator('[data-testid="body-view-content"]');
  await expect(content).toContainText('just plain text', { timeout: 5_000 });
  await expect(win.locator('[data-testid="body-view-gunzip"]')).toBeDisabled();

  const copyRaw = win.locator('[data-testid="copy-body-raw"]');
  await expect(copyRaw).toBeVisible();
  await copyRaw.click();
  await expect(copyRaw).toHaveText('已复制', { timeout: 5_000 });

  await win.locator('[data-testid="body-view-gzip"]').click();
  await expect(win.locator('[data-testid="body-gzip-stats"]')).toContainText('gzip', { timeout: 5_000 });
  await expect(content).toContainText(/1f 8b/);
});
