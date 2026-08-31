import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test('app boots and mocks a request end-to-end', async () => {
  await win.waitForSelector('[data-testid="traffic-tab"]');

  // 确保代理在运行
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  const status = await win.evaluate(() => window.api.proxyStatus());
  expect(status.running).toBe(true);

  // 通过 IPC 建一条规则（与 UI 走同一存储路径）
  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-rule',
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/ping', method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'e2e-mocked' },
    });
  });

  // 经代理发请求，断言 mock 生效
  const agent = new ProxyAgent(`http://127.0.0.1:${status.port}`);
  const res = await fetch('http://e2e.example.test/ping', { dispatcher: agent });
  expect(await res.text()).toBe('e2e-mocked');

  // 流量表中出现该请求（轮询等待）
  await expect(async () => {
    const text = await win.locator('.traffic-table').innerText();
    expect(text).toContain('e2e.example.test');
  }).toPass({ timeout: 10000 });

  // 清理规则，避免污染下次运行
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) await window.api.rulesRemove(r.id);
  });
});
