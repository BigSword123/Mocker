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
    for (const r of await window.api.rulesList()) if (r.name === 'e2e-seq') await window.api.rulesRemove(r.id);
  });
  await app.close();
});

test('sequential rule returns responses in order, stays at last', async () => {
  const port = await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });

  await win.evaluate(async () => {
    await window.api.rulesAdd({
      name: 'e2e-seq',
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/seq', method: 'ANY' },
      action: {
        responses: [
          { status: 200, headers: {}, body: 'first' },
          { status: 201, headers: {}, body: 'second' },
          { status: 202, headers: {}, body: 'last' },
        ],
      },
    });
  });

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const r1 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe('first');
    const r2 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r2.status).toBe(201);
    expect(await r2.text()).toBe('second');
    const r3 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r3.status).toBe(202);
    expect(await r3.text()).toBe('last');
    const r4 = await fetch('http://e2e.example.test/seq', { dispatcher: agent });
    expect(r4.status).toBe(202);
    expect(await r4.text()).toBe('last');
  } finally {
    await agent.close();
  }
});
