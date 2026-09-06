import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 幂等清理：限速恢复关闭、删除用例规则，防跨运行残留
  await win.evaluate(async () => {
    const s = await window.api.settingsGet();
    await window.api.settingsSet({ throttle: { ...s.throttle, enabled: false } });
    for (const r of await window.api.rulesList()) if (r.name.startsWith('e2e-thr-')) await window.api.rulesRemove(r.id);
  });
  await app.close();
});

const openSettings = async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '设置', exact: true }).click();
};

test('preset fills values, editing switches to custom, chip reflects saved state', async () => {
  await openSettings();
  await win.getByTestId('throttle-enabled').click();
  await win.getByTestId('throttle-preset').selectOption('slow-three-g');
  await expect(win.getByTestId('throttle-latency')).toHaveValue('800');
  await win.getByTestId('throttle-latency').fill('500');
  await expect(win.getByTestId('throttle-preset')).toHaveValue('custom');
  await win.getByTestId('throttle-save').click();
  // chip 依赖状态栏 3s 轮询；custom 档显示带宽数值
  await expect(win.getByTestId('throttle-chip')).toContainText('限速:50KB/s', { timeout: 8000 });
  await win.getByTestId('throttle-chip').click();
  await expect(win.locator('nav.tabs button', { hasText: '设置' })).toHaveClass(/active/);
  // 收尾：关闭限速，chip 消失
  await win.getByTestId('throttle-enabled').click();
  await win.getByTestId('throttle-save').click();
  await expect(win.getByTestId('throttle-chip')).toHaveCount(0);
});

test('throttled request is marked in traffic detail', async () => {
  // API 造数：开启限速（latency 300ms）+ 一条 mock 规则
  await win.evaluate(async () => {
    const s = await window.api.settingsGet();
    await window.api.settingsSet({
      throttle: { enabled: true, preset: 'custom', downKbps: 100000, latencyMs: 300, jitterMs: 0 },
    });
    await window.api.rulesAdd({
      name: 'e2e-thr-rule',
      enabled: true,
      priority: 1,
      match: { urlType: 'exact', urlPattern: 'http://thr.example.test/x', method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'thr-ok' },
    });
  });
  const port = await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  await fetch('http://thr.example.test/x', { dispatcher: agent });
  // 打开流量详情（虚拟列表行选择器同 capture-to-rule.spec.ts）
  await win.locator('nav.tabs').getByRole('button', { name: '流量', exact: true }).click();
  const row = win.locator('.traffic-table .row', { hasText: 'thr.example.test' }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(win.getByTestId('throttle-mark')).toContainText('限速 +', { timeout: 5000 });
});
