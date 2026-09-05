import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
const RULE_NAMES = ['e2e-sc-off', 'e2e-sc-on'];

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) if (r.name === 'e2e-sc-off' || r.name === 'e2e-sc-on') await window.api.rulesRemove(r.id);
    for (const s of await window.api.scenariosList()) await window.api.scenariosRemove(s.name);
  });
  await app.close();
});

test('scenario disabled suppresses its rules', async () => {
  const port = await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });

  await win.evaluate(async () => {
    await window.api.scenariosAdd('e2e-sc');
    await window.api.scenariosSetEnabled('e2e-sc', true);
    await window.api.rulesAdd({
      name: 'e2e-sc-off',
      enabled: true,
      scenario: 'e2e-sc',
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-off', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'OFF-RULE' },
    });
    await window.api.rulesAdd({
      name: 'e2e-sc-on',
      enabled: true,
      scenario: undefined,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/sc-on', method: 'ANY' },
      action: { status: 200, headers: {}, body: 'ON-RULE' },
    });
  });

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    let r1 = await fetch('http://e2e.example.test/sc-off', { dispatcher: agent });
    expect(await r1.text()).toBe('OFF-RULE');
    let r2 = await fetch('http://e2e.example.test/sc-on', { dispatcher: agent });
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
});
