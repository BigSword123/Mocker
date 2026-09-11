import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

let app: ElectronApplication;
let win: Page;

// 模式切换要跑 adb + networksetup，秒级；用条件等待而不是固定 sleep
const MODE_TIMEOUT = 20000;

const systemProxy = async () => win.evaluate(async () => window.api.systemProxyStatus());

/**
 * 必须经状态栏 UI 切模式。直接调 api.monitorSetMode 不会通知状态栏——它的 mode
 * 靠 3s 轮询同步，期间它的 React 状态是过期的，而 switchMode 有 `next === mode`
 * 早退，点击会被静默丢弃（实测：persisted 与系统代理都不变，高亮 1s 后才纠正）。
 */
const setModeViaUi = async (mode: 'off' | 'phone' | 'computer') => {
  await win.getByTestId(`monitor-${mode}`).click();
  await expect(win.getByTestId(`monitor-${mode}`)).toHaveClass(/text-ok/, {
    timeout: MODE_TIMEOUT,
  });
  await expect
    .poll(async () => win.evaluate(async () => (await window.api.settingsGet()).monitorMode), {
      timeout: MODE_TIMEOUT,
    })
    .toBe(mode);
};

const openSettings = async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '设置', exact: true }).click();
  // SettingsPanel 在 settingsGet() 返回前只渲染「加载中…」，保存按钮此时还不存在
  await expect(win.getByTestId('settings-save')).toBeVisible({ timeout: MODE_TIMEOUT });
};

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
  await win.waitForSelector('[data-testid="monitor-mode"]');
  // 从确定状态起步：持久化的 monitorMode 可能已是 computer，那样启动即接管系统代理，
  // 第 2 个用例的 off→computer 转变就不会发生，Bug A 的回归会变成空断言
  await setModeViaUi('off');
  await expect.poll(systemProxy, { timeout: MODE_TIMEOUT }).toBe(false);
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

test('settings page no longer has its own system-proxy button', async () => {
  await openSettings();
  await expect(win.getByTestId('system-proxy-hint')).toContainText('状态栏');
  await expect(win.getByRole('button', { name: '开启系统代理' })).toHaveCount(0);
  await expect(win.getByRole('button', { name: '关闭系统代理' })).toHaveCount(0);
  await expect(win.getByTestId('autostart-proxy')).toBeVisible();
});

test('saving settings keeps a mocker-owned system proxy on', async () => {
  // 刻意不重新 openSettings：设置页在上一个用例就已挂载并停留在此，
  // 「面板先挂载、系统代理后开启、再保存」正是 Bug A 的触发顺序
  await setModeViaUi('computer');
  await expect.poll(systemProxy, { timeout: MODE_TIMEOUT }).toBe(true);

  await win.getByTestId('settings-save').click();
  await expect(win.getByTestId('settings-message')).toContainText('已保存，代理已重启生效', {
    timeout: MODE_TIMEOUT,
  });

  // 回归 Bug A：旧代码用挂载时的快照，走到这里系统代理已被静默关掉
  await expect.poll(systemProxy, { timeout: MODE_TIMEOUT }).toBe(true);
  expect(await win.evaluate(async () => (await window.api.proxyStatus()).running)).toBe(true);
  expect(await win.evaluate(async () => (await window.api.settingsGet()).monitorMode)).toBe(
    'computer',
  );
});

test('saving settings does not enable a system proxy mocker does not own', async () => {
  await setModeViaUi('off');
  await expect.poll(systemProxy, { timeout: MODE_TIMEOUT }).toBe(false);

  // monitorMode 不属于保存 patch，保存不会把模式改回去
  await openSettings();
  await win.getByTestId('settings-save').click();
  await expect(win.getByTestId('settings-message')).toContainText('已保存', {
    timeout: MODE_TIMEOUT,
  });
  expect(await systemProxy()).toBe(false);
});
