import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
const HOST = 'capture.example.test';
const TARGET = `http://${HOST}/api?x=1`;
const BODY = '{"hello":"capture"}';
const CONTENT_TYPE = 'text/x-capture';
const STATUS = 201;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 只清理本用例创建的规则（种子规则 + 转换出的规则），避免误删开发者真实规则
  await win.evaluate(async (host) => {
    for (const r of await window.api.rulesList()) {
      if (r.match.urlPattern.includes(host)) await window.api.rulesRemove(r.id);
    }
  }, HOST);
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

  // 种子规则用独特的 status 与 content-type，便于断言预填值确实来自抓包而非弹窗默认
  await win.evaluate(
    async ({ url, body, contentType, statusCode }) => {
      await window.api.rulesAdd({
        name: 'capture-seed',
        enabled: true,
        match: { urlType: 'exact', urlPattern: url, method: 'ANY' },
        action: { status: statusCode, headers: { 'content-type': contentType }, body },
      });
    },
    { url: TARGET, body: BODY, contentType: CONTENT_TYPE, statusCode: STATUS },
  );

  // 经代理发请求，命中种子规则
  const agent = new ProxyAgent(`http://127.0.0.1:${status.port}`);
  const res = await fetch(TARGET, { dispatcher: agent });
  expect(res.status).toBe(STATUS);
  expect(await res.text()).toBe(BODY);
  await agent.close();

  // 流量表出现该请求；等它成为已完成的 MOCK 事件（带状态码/响应体）后再选中
  const row = win.locator('.traffic-table .row', { hasText: HOST }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await expect(row.locator('.badge')).toHaveText('MOCK');
  await row.click();

  // 详情区出现「转为规则」按钮，点击打开预填弹窗
  await win.locator('[data-testid="capture-to-rule"]').click();
  await expect(win.locator('.modal h2')).toHaveText('新建规则');

  // 预填断言（逐项区分于弹窗默认值）：URL 类型=精确、URL 模式=完整 URL（含 query）、状态码=201、响应体原样、content-type 来自抓包
  await expect(win.locator('.form-grid label:has-text("URL 类型") + select')).toHaveValue('exact');
  await expect(win.getByPlaceholder('http://api.example.com/*')).toHaveValue(TARGET);
  await expect(win.locator('.form-grid label:has-text("响应状态码") + input')).toHaveValue(String(STATUS));
  await expect(win.locator('textarea[placeholder=\'{"code":0}\']')).toHaveValue(BODY);
  // The response headers are now in a table; check that the content-type row exists
  const respHeaderTable = win.locator('table[aria-label="响应头"]');
  await expect(respHeaderTable).toBeVisible();
  await expect(respHeaderTable.locator('input[value="content-type"]')).toBeVisible();
  await expect(respHeaderTable.locator('input[value="' + CONTENT_TYPE + '"]')).toBeVisible();

  // 保存
  await win.getByRole('button', { name: '保存', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);

  // 规则页：匹配单元格 "GET <完整URL>" 证明 method 与 exact 全 URL 已持久化；勾选框证明 enabled（走 ADD 分支）
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  const convertedRow = win.locator('.rules-table tbody tr', { hasText: `GET ${TARGET}` });
  await expect(convertedRow).toBeVisible();
  await expect(convertedRow.locator('input[type="checkbox"]')).toBeChecked();
});
