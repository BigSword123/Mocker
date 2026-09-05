import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
let tmpDir: string;
let htmlFile: string;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mocker-e2e-maplocal-'));
  htmlFile = path.join(tmpDir, 'page.html');
  await fs.writeFile(htmlFile, '<html><body>MAP LOCAL OK</body></html>');
});

test.afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await win.evaluate(async () => {
    for (const r of await window.api.redirectsList()) await window.api.redirectsRemove(r.id);
  });
  await app.close();
});

test('map-local returns file content', async () => {
  const port = await win.evaluate(async () => {
    if (!(await window.api.proxyStatus()).running) await window.api.proxyStart();
    return (await window.api.proxyStatus()).port;
  });

  await win.evaluate(async (target: string) => {
    await window.api.redirectsAdd({
      name: 'e2e-maplocal',
      enabled: true,
      match: { urlType: 'exact', urlPattern: 'http://e2e.example.test/maplocal', method: 'ANY' },
      action: 'mapLocal',
      target,
    });
  }, htmlFile);

  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const res = await fetch('http://e2e.example.test/maplocal', { dispatcher: agent });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html><body>MAP LOCAL OK</body></html>');
  } finally {
    await agent.close();
  }

  await expect(async () => {
    const text = await win.locator('.traffic-table').innerText();
    expect(text).toContain('maplocal');
  }).toPass({ timeout: 10_000 });
});
