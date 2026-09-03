import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
const TARGET = 'http://capture.example.test/api?x=1';
const BODY = '{"hello":"capture"}';

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 只清理本用例创建的规则（种子规则 + 转换出的规则），避免误删开发者真实规则
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) {
      if (r.match.urlPattern.includes('capture.example.test')) await window.api.rulesRemove(r.id);
    }
  });
  await app.close();
});

test('converts a captured request into a prefilled rule', async () => {
  await win.waitForSelector('[data-testid="traffic-tab"]');

  // 确保代理在运行
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  const status = await win.evaluate(() => window.api.proxyStatus());
  expect(status.running).toBe(true);

  // 建一条种子规则，让目标请求被 mock，从而产生一条带响应体的流量
  await win.evaluate(
    async ({ url, body }) => {
      await window.api.rulesAdd({
        name: 'capture-seed',
        enabled: true,
        match: { urlType: 'exact', urlPattern: url, method: 'ANY' },
        action: { status: 200, headers: { 'content-type': 'application/json' }, body },
      });
    },
    { url: TARGET, body: BODY },
  );

  // 经代理发请求，命中种子规则
  const agent = new ProxyAgent(`http://127.0.0.1:${status.port}`);
  const res = await fetch(TARGET, { dispatcher: agent });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(BODY);
  await agent.close();

  // 流量表出现该请求并选中
  const row = win.locator('.traffic-table .row', { hasText: 'capture.example.test' }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();

  // 详情区出现「转为规则」按钮，点击打开预填弹窗
  await win.locator('[data-testid="capture-to-rule"]').click();
  await expect(win.locator('.modal h2')).toHaveText('新建规则');

  // URL 模式 = 完整 URL（含 query）
  await expect(win.getByPlaceholder('http://api.example.com/*')).toHaveValue(TARGET);
  // 响应体原样预填
  await expect(win.locator('textarea[placeholder=\'{"code":0}\']')).toHaveValue(BODY);
  // content-type 预填一行
  await expect(win.locator('.form-grid label:has-text("响应头") + textarea')).toHaveValue(/content-type/);

  // 保存
  await win.getByRole('button', { name: '保存', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);

  // 规则页出现新规则，且为启用状态（验证走 ADD 分支、enabled=true）
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await expect(win.locator('.rules-table')).toContainText('capture.example.test');
  const convertedRow = win.locator('.rules-table tbody tr', { hasText: 'GET /api' });
  await expect(convertedRow).toBeVisible();
  await expect(convertedRow.locator('input[type="checkbox"]')).toBeChecked();
});
