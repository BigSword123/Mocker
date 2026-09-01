import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

async function openNewRuleModal() {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await win.getByRole('button', { name: '新建规则', exact: true }).click();
  await expect(win.locator('.modal h2')).toHaveText('新建规则');
}

async function closeRuleModal() {
  await win.getByRole('button', { name: '取消', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);
}

test('rule editor shows 动态数据 and 行为模拟 sections', async () => {
  await openNewRuleModal();
  await expect(win.locator('details.form-section summary', { hasText: '动态数据' })).toBeVisible();
  await expect(win.locator('details.form-section summary', { hasText: '行为模拟' })).toBeVisible();
  await closeRuleModal();
});

test('snippet button inserts {{uuid}} into response body', async () => {
  await openNewRuleModal();
  const body = win.locator('textarea[placeholder=\'{"code":0}\']');
  await expect(body).toBeVisible();
  await win.getByRole('button', { name: '+uuid', exact: true }).click();
  await expect(body).toHaveValue('{{uuid}}');
  await closeRuleModal();
});

test('template preview renders {{req.host}} from example context', async () => {
  await openNewRuleModal();
  const body = win.locator('textarea[placeholder=\'{"code":0}\']');
  await body.fill('host={{req.host}}');
  await win.getByRole('button', { name: '刷新预览', exact: true }).click();
  await expect(win.locator('pre.preview')).toContainText('host=example.test');
  await closeRuleModal();
});

test('saving out-of-range delay shows server-side delayMs error', async () => {
  await openNewRuleModal();
  await win.getByPlaceholder('http://api.example.com/*').fill('http://x.test/');
  const delay = win.locator('input[type="number"][max="300000"]');
  await expect(delay).toHaveCount(1);
  await delay.fill('999999');
  await win.getByRole('button', { name: '保存', exact: true }).click();
  const err = win.locator('.modal .text-err');
  await expect(err).toBeVisible();
  await expect(err).toContainText('delayMs');
  // 校验失败，弹窗保持打开且未保存任何规则
  await expect(win.locator('.modal h2')).toHaveText('新建规则');
  await closeRuleModal();
});
