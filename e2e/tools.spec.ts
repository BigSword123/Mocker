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

test('实用工具 tab 位于设备接入左侧', async () => {
  await win.waitForSelector('[data-testid="tools-tab"]');
  const order = await win.$$eval('.tabs button', (btns) => btns.map((b) => b.getAttribute('data-testid')));
  expect(order).toEqual([
    'traffic-tab',
    'rules-tab',
    'redirects-tab',
    'tools-tab',
    'device-tab',
    'settings-tab',
  ]);
});

test('时间戳正向转换（指定时区）', async () => {
  await win.getByTestId('tools-tab').click();
  await win.getByTestId('tool-tab-timestamp').click();

  await win.getByTestId('ts-zone').selectOption('UTC');
  await win.getByTestId('ts-unit').selectOption('ms');
  await win.getByTestId('ts-input').fill('1789000000123');

  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 00:26:40.123');
  await expect(win.getByTestId('ts-iso')).toHaveText('2026-09-10T00:26:40.123+00:00');

  await win.getByTestId('ts-zone').selectOption('Asia/Shanghai');
  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 08:26:40.123');
  await expect(win.getByTestId('ts-offset')).toHaveText('UTC+08:00');
});

test('时间戳自动识别秒与毫秒', async () => {
  await win.getByTestId('ts-zone').selectOption('UTC');
  await win.getByTestId('ts-unit').selectOption('auto');

  await win.getByTestId('ts-input').fill('1789000000');
  await expect(win.getByTestId('ts-detected')).toHaveText('识别为：秒');
  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 00:26:40.000');

  await win.getByTestId('ts-input').fill('1789000000123');
  await expect(win.getByTestId('ts-detected')).toHaveText('识别为：毫秒');
  await expect(win.getByTestId('ts-standard')).toHaveText('2026-09-10 00:26:40.123');
});

test('时间戳反向解析回到同一毫秒值', async () => {
  await win.getByTestId('ts-zone').selectOption('Asia/Shanghai');
  await win.getByTestId('dt-input').fill('2026-09-10 08:26:40.123');

  await expect(win.getByTestId('dt-ms')).toHaveText('1789000000123');
  await expect(win.getByTestId('dt-s')).toHaveText('1789000000');
});

test('非法输入行内报错且不崩', async () => {
  await win.getByTestId('ts-input').fill('abc');
  await expect(win.getByTestId('ts-error')).toContainText('请输入数字时间戳');

  await win.getByTestId('dt-input').fill('not a date');
  await expect(win.getByTestId('dt-error')).toContainText('无法解析');
});
