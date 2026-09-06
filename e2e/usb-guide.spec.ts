import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await app.close();
});

test('usb direct-connect section renders regardless of adb availability', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '设备接入', exact: true }).click();
  await expect(win.getByRole('heading', { name: 'Android USB 直连（不同网段可用）' })).toBeVisible({ timeout: 10000 });
  await expect(win.getByTestId('adb-tunnel')).toBeVisible();
  await expect(win.getByTestId('adb-clear')).toBeVisible();
  // 不点会修改手机状态的操作按钮
  await expect(win.getByRole('heading', { name: '手动操作' })).toBeVisible();
  await expect(win.getByText('结束后清理（必做，否则手机断网）')).toBeVisible();
});
