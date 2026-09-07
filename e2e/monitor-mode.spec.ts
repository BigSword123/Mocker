import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 必须恢复：本 spec 会真实修改系统代理，结束必回 off
  await win
    .evaluate(async () => {
      await window.api.monitorSetMode('off');
    })
    .catch(() => {});
  await app.close();
});

test('mode switch persists and is mutually exclusive', async () => {
  await win.waitForSelector('[data-testid="monitor-mode"]');

  // 电脑模式：真实设置系统代理
  await win.getByTestId('monitor-computer').click();
  await expect(win.getByTestId('monitor-computer')).toHaveClass(/text-ok/);
  expect(await win.evaluate(async () => (await window.api.settingsGet()).monitorMode)).toBe('computer');
  expect(await win.evaluate(async () => window.api.systemProxyStatus())).toBe(true);

  // 切手机模式：互斥清理系统代理（真机上若无设备会有 notice，不在这里断言环境差异）
  // adb 操作耗时秒级，用 poll 等待持久化完成
  await win.getByTestId('monitor-phone').click();
  await expect
    .poll(async () => win.evaluate(async () => (await window.api.settingsGet()).monitorMode))
    .toBe('phone');
  expect(await win.evaluate(async () => window.api.systemProxyStatus())).toBe(false);

  await win.getByTestId('monitor-off').click();
  await expect
    .poll(async () => win.evaluate(async () => (await window.api.settingsGet()).monitorMode))
    .toBe('off');
  expect(await win.evaluate(async () => window.api.systemProxyStatus())).toBe(false);
});
