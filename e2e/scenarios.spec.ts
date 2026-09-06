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
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) if (r.name.startsWith('e2e-sc-')) await window.api.rulesRemove(r.id);
    for (const s of await window.api.scenariosList()) if (!s.builtin) await window.api.scenariosRemove(s.name, null);
  });
  await app.close();
});

const proxyPort = async () => {
  return win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });
};

/** 面板只在挂载时拉数据：API 造数后切走再切回，强制重挂拿到新数据 */
const reopenRulesTab = async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '流量', exact: true }).click();
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
};

test('scenario disabled suppresses its rules; ungrouped always effective', async () => {
  const port = await proxyPort();
  await win.evaluate(async () => {
    // 幂等：跨运行残留（上次运行中断未清理）不应让本用例崩掉
    if (!(await window.api.scenariosList()).some((s) => s.name === 'e2e-sc')) await window.api.scenariosAdd('e2e-sc');
    await window.api.scenariosSetEnabled('e2e-sc', true);
    const rules = await window.api.rulesList();
    if (!rules.some((r) => r.name === 'e2e-sc-off')) {
      await window.api.rulesAdd({
        name: 'e2e-sc-off',
        enabled: true,
        scenario: 'e2e-sc',
        match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-off', method: 'ANY' },
        action: { status: 200, headers: {}, body: 'OFF-RULE' },
      });
    }
    if (!rules.some((r) => r.name === 'e2e-sc-on')) {
      await window.api.rulesAdd({
        name: 'e2e-sc-on',
        enabled: true,
        scenario: undefined,
        match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-on', method: 'ANY' },
        action: { status: 200, headers: {}, body: 'ON-RULE' },
      });
    }
  });

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r1 = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent });
    expect(await r1.text()).toBe('OFF-RULE');
    const r2 = await fetch('http://e2e.example.test/sc-on', { dispatcher: agent });
    expect(await r2.text()).toBe('ON-RULE');
  } finally {
    await agent.close();
  }

  await win.evaluate(async () => { await window.api.scenariosSetEnabled('e2e-sc', false); });
  const agent2 = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r3 = await fetch('http://e2e.example.test/sc-on', { dispatcher: agent2 });
    expect(await r3.text()).toBe('ON-RULE');
    const r4 = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent2 });
    expect(r4.status).not.toBe(200);
  } finally {
    await agent2.close();
  }
  await win.evaluate(async () => { await window.api.scenariosSetEnabled('e2e-sc', true); });
});

test('rules page groups by scenario; builtin group has no rename/delete', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await expect(win.locator('[data-testid="group-默认"]')).toBeVisible();
  const defaultHead = win.locator('[data-testid="group-默认-head"]');
  await expect(defaultHead.getByTestId('group-默认-rename')).toHaveCount(0);
  await expect(defaultHead.getByTestId('group-默认-delete')).toHaveCount(0);
  await expect(defaultHead.getByTestId('group-默认-toggle')).toBeVisible();
});

test('per-group create presets the scenario field', async () => {
  await reopenRulesTab();
  await win.locator('[data-testid="group-e2e-sc-create"]').click();
  const modal = win.locator('.modal');
  await expect(modal).toBeVisible();
  await expect(win.getByTestId('scenario-field')).toHaveValue('e2e-sc');
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);
});

test('group toggle switch suppresses the group (UI path)', async () => {
  await reopenRulesTab();
  const head = win.locator('[data-testid="group-e2e-sc-head"]');
  const toggle = head.getByTestId('group-e2e-sc-toggle');
  // 受控复选框 + 异步 IPC 时用 click，uncheck 的即时状态校验会与渲染竞争
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  const port = await proxyPort();
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent });
    expect(r.status).not.toBe(200);
  } finally {
    await agent.close();
  }
  await toggle.click();
  await expect(toggle).toBeChecked();
});

test('inline rename cascades to rules', async () => {
  await reopenRulesTab();
  const head = win.locator('[data-testid="group-e2e-sc-head"]');
  await head.getByTestId('group-e2e-sc-rename').click();
  await head.getByTestId('group-e2e-sc-rename-input').fill('e2e-sc-renamed');
  await head.getByTestId('group-e2e-sc-rename-input').press('Enter');
  await expect(win.locator('[data-testid="group-e2e-sc-renamed"]')).toBeVisible();
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-off')?.scenario,
  );
  expect(scenario).toBe('e2e-sc-renamed');
  // 改回，供后续用例与清理使用
  const head2 = win.locator('[data-testid="group-e2e-sc-renamed-head"]');
  await head2.getByTestId('group-e2e-sc-renamed-rename').click();
  await head2.getByTestId('group-e2e-sc-renamed-rename-input').fill('e2e-sc');
  await head2.getByTestId('group-e2e-sc-renamed-rename-input').press('Enter');
  await expect(win.locator('[data-testid="group-e2e-sc"]')).toBeVisible();
});

test('move-to select re-assigns a rule to another scenario', async () => {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-sc-move',
      enabled: true,
      scenario: undefined,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-move', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'MOVE-RULE' },
    });
  });
  await reopenRulesTab();
  const row = win.locator('[data-testid="group-ungrouped"] tr', { hasText: 'e2e-sc-move' });
  await row.getByTestId('move-e2e-sc-move').selectOption('e2e-sc');
  await expect(win.locator('[data-testid="group-e2e-sc"] tr', { hasText: 'e2e-sc-move' })).toBeVisible();
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-move')?.scenario,
  );
  expect(scenario).toBe('e2e-sc');
});

test('delete scenario transfers entries to chosen target', async () => {
  await win.evaluate(async () => { await window.api.scenariosAdd('e2e-sc-doomed'); });
  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-sc-doomed-rule',
      enabled: true,
      scenario: 'e2e-sc-doomed',
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-doomed', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'DOOMED' },
    });
  });
  await reopenRulesTab();
  const head = win.locator('[data-testid="group-e2e-sc-doomed-head"]');
  await head.getByTestId('group-e2e-sc-doomed-delete').click();
  await head.getByTestId('group-e2e-sc-doomed-move-to').selectOption('默认');
  await head.getByTestId('group-e2e-sc-doomed-confirm-delete').click();
  await expect(win.locator('[data-testid="group-e2e-sc-doomed"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="group-默认"] tr', { hasText: 'e2e-sc-doomed-rule' })).toBeVisible();
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-doomed-rule')?.scenario,
  );
  expect(scenario).toBe('默认');
});

test('drag scenario head onto another to reorder (persisted)', async () => {
  await win.evaluate(async () => { await window.api.scenariosAdd('e2e-drag'); });
  await reopenRulesTab();
  const dataTransfer = await win.evaluateHandle(() => new DataTransfer());
  await win.locator('[data-testid="group-e2e-drag"] .drag-handle').dispatchEvent('dragstart', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('dragover', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('drop', { dataTransfer });
  const names = await win.evaluate(async () => (await window.api.scenariosList()).map((s) => s.name));
  expect(names.indexOf('e2e-drag')).toBeLessThan(names.indexOf('默认'));
});

test('drag a rule row onto a scenario group to re-assign (persisted)', async () => {
  await reopenRulesTab();
  const dataTransfer = await win.evaluateHandle(() => new DataTransfer());
  const row = win.locator('[data-testid="group-ungrouped"] tr', { hasText: 'e2e-sc-on' });
  await row.dispatchEvent('dragstart', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('dragover', { dataTransfer });
  await win.locator('[data-testid="group-默认-head"]').dispatchEvent('drop', { dataTransfer });
  const scenario = await win.evaluate(async () =>
    (await window.api.rulesList()).find((r) => r.name === 'e2e-sc-on')?.scenario,
  );
  expect(scenario).toBe('默认');
});

test('group collapse/expand and order swap buttons', async () => {
  await win.evaluate(async () => {
    if (!(await window.api.scenariosList()).some((s) => s.name === 'e2e-order')) await window.api.scenariosAdd('e2e-order');
  });
  await reopenRulesTab();
  const grp = win.locator('[data-testid="group-e2e-order"]');

  // 收起隐藏表格与新建按钮，展开恢复
  await grp.getByTestId('group-e2e-order-collapse').click();
  await expect(grp.locator('table')).toHaveCount(0);
  await expect(grp.getByTestId('group-e2e-order-create')).toHaveCount(0);
  await grp.getByTestId('group-e2e-order-collapse').click();
  await expect(grp.locator('table')).toHaveCount(1);

  // ↑ 上移一位并持久化；未分组没有顺序按钮
  const before = await win.evaluate(async () => (await window.api.scenariosList()).map((s) => s.name).indexOf('e2e-order'));
  await grp.getByTestId('group-e2e-order-up').click();
  const after = await win.evaluate(async () => (await window.api.scenariosList()).map((s) => s.name).indexOf('e2e-order'));
  expect(after).toBe(before - 1);
  await expect(win.locator('[data-testid="group-ungrouped-up"]')).toHaveCount(0);
});
