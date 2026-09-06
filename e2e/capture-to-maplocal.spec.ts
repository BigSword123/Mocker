import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
const HOST = 'maplocal-capture.example.test';
const TARGET = `http://${HOST}/data?id=9`;
const BODY = '{"captured":"maplocal"}';

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 只清理本用例创建的条目（按 host 过滤），避免误删开发者真实规则
  await win.evaluate(async (host) => {
    for (const r of await window.api.redirectsList()) {
      if (r.match.urlPattern.includes(host)) await window.api.redirectsRemove(r.id);
    }
    for (const r of await window.api.rulesList()) {
      if (r.match.urlPattern.includes(host)) await window.api.rulesRemove(r.id);
    }
  }, HOST);
  await app.close();
});

test('converts a captured request into a mapLocal redirect and serves it from file', async () => {
  await win.waitForSelector('[data-testid="traffic-tab"]');

  const port = await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });

  // 种子规则造一次真实抓包（status 200 + json，便于断言落盘扩展名与文件内容）
  await win.evaluate(async ({ url, body }) => {
    await window.api.rulesAdd({
      name: 'maplocal-capture-seed',
      enabled: true,
      match: { urlType: 'exact', urlPattern: url, method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'application/json' }, body },
    });
  }, { url: TARGET, body: BODY });

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const res = await fetch(TARGET, { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  } finally {
    await agent.close();
  }

  // 选中抓包行
  const row = win.locator('.traffic-table .row', { hasText: HOST }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.locator('.badge')).toHaveText('MOCK');
  await row.click();

  // 点击「转为 MapLocal」打开预填弹窗
  await win.locator('[data-testid="capture-to-maplocal"]').click();
  await expect(win.locator('.modal h2')).toHaveText('新建重定向');

  // 预填断言：exact + 完整 URL、类型=mapLocal、target 为 .json 文件路径且包含 host
  await expect(win.locator('[data-testid="redirect-url-type"]')).toHaveValue('exact');
  await expect(win.locator('[data-testid="redirect-url-pattern"]')).toHaveValue(TARGET);
  await expect(win.locator('[data-testid="redirect-action-kind"]')).toHaveValue('mapLocal');
  const targetValue = await win.locator('[data-testid="redirect-target"]').inputValue();
  expect(targetValue).toContain(HOST);
  expect(targetValue).toMatch(/\.json$/);

  // 保存
  await win.locator('[data-testid="redirect-save"]').click();
  await expect(win.locator('.modal')).toHaveCount(0);

  // 重定向页：规则已持久化，类型=本地
  await win.locator('[data-testid="redirects-tab"]').click();
  const converted = win.locator('.rules-table tbody tr', { hasText: `GET ${TARGET}` });
  await expect(converted).toBeVisible();
  await expect(converted.locator('input[type="checkbox"]')).toBeChecked();
  await expect(converted).toContainText('本地');

  // 再次请求：重定向先于 Mock 规则命中，响应应来自本地文件（内容与抓包一致）
  const agent2 = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const res2 = await fetch(TARGET, { dispatcher: agent2 });
    expect(res2.status).toBe(200);
    expect(await res2.headers.get('content-type')).toContain('application/json');
    expect(await res2.text()).toBe(BODY);
  } finally {
    await agent2.close();
  }

  // 重放同样吃到重定向短路：重放产生的新条目应命中该 mapLocal 规则
  const redirectId = await win.evaluate(async (url) => {
    return (await window.api.redirectsList()).find((r) => r.match.urlPattern === url)?.id ?? null;
  }, TARGET);
  expect(redirectId).not.toBeNull();

  await win.locator('[data-testid="traffic-tab"]').click();
  await win.locator('.traffic-table .row', { hasText: HOST }).first().click();
  await win.locator('[data-testid="replay"]').click();

  const replayRow = win
    .locator('.traffic-table .row', { hasText: HOST })
    .filter({ has: win.locator('.badge-replay') });
  await expect(replayRow).toHaveCount(1, { timeout: 10_000 });
  await replayRow.click();
  await expect(win.locator('.detail')).toContainText(`由规则命中（${redirectId}）`);
});
