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

test('error template 404 prefills status and body', async () => {
  await openNewRuleModal();
  await win.locator('#rule-error-template').selectOption('http-404');
  const statusInput = win.locator('.form-grid label:has-text("响应状态码") + input');
  await expect(statusInput).toHaveValue('404');
  const bodyTextarea = win.locator('textarea[placeholder=\'{"code":0}\']');
  await expect(bodyTextarea).toContainText('Not Found');
  await closeRuleModal();
});

test('connection template disables response fields', async () => {
  await openNewRuleModal();
  await win.locator('#rule-error-template').selectOption('conn-econnreset');
  const statusInput = win.locator('.form-grid label:has-text("响应状态码") + input');
  const bodyTextarea = win.locator('textarea[placeholder=\'{"code":0}\']');
  await expect(statusInput).toBeDisabled();
  await expect(bodyTextarea).toBeDisabled();
  await expect(win.locator('#rule-connection-only-note')).toBeVisible();
  await win.locator('#rule-error-template').selectOption('custom');
  await expect(statusInput).toBeEnabled();
  await expect(bodyTextarea).toBeEnabled();
  await closeRuleModal();
});

test('manual edit resets error template to custom', async () => {
  await openNewRuleModal();
  await win.locator('#rule-error-template').selectOption('http-404');
  const statusInput = win.locator('.form-grid label:has-text("响应状态码") + input');
  await statusInput.fill('418');
  await expect(win.locator('#rule-error-template')).toHaveValue('custom');
  await closeRuleModal();
});

test('faker catalog modal inserts snippet', async () => {
  await openNewRuleModal();
  await win.getByRole('button', { name: 'Faker 速查…' }).click();
  await win.getByPlaceholder('搜索方法或关键词').fill('email');
  await win.getByRole('button', { name: '插入' }).first().click();
  const body = win.locator('textarea[placeholder=\'{"code":0}\']');
  await expect(body).toHaveValue(/faker\.internet\.email/);
  await win.locator('.faker-modal .icon-btn').click();
  await closeRuleModal();
});

test('editable header table adds and deletes rows', async () => {
  await openNewRuleModal();
  const table = win.locator('table[aria-label="请求头"]');
  await table.getByPlaceholder('Name').first().fill('X-Foo');
  await table.getByPlaceholder('Value').first().fill('bar');
  // Auto-appends empty row
  await expect(table.getByPlaceholder('Name')).toHaveCount(2);
  // Delete first row
  await table.locator('tr').first().getByRole('button', { name: '删除行' }).click();
  await expect(table.getByPlaceholder('Name').first()).toHaveValue('');
  await closeRuleModal();
});

test('body tabs switch to form-data mode', async () => {
  await openNewRuleModal();
  await win.getByRole('button', { name: 'form-data', exact: true }).click();
  const table = win.locator('table[aria-label="请求体表单"]');
  await expect(table).toBeVisible();
  await table.getByPlaceholder('Name').first().fill('user');
  await table.getByPlaceholder('Value').first().fill('alice');
  await closeRuleModal();
});

test('body tabs raw mode with json-deep strategy', async () => {
  await openNewRuleModal();
  await win.getByRole('button', { name: 'raw', exact: true }).click();
  await win.getByLabel('匹配策略').selectOption('json-deep');
  const textarea = win.locator('textarea[placeholder=\'{"keyword": "test"}\']');
  await textarea.fill('{"id":1}');
  await closeRuleModal();
});

