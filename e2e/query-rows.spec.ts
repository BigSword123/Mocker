import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';

let app: ElectronApplication;
let win: Page;
const HOST = 'e2e-query.example.test';
const CLEANUP_NAMES = ['e2e-query-rows', 'e2e-query-fallback', 'e2e-query-legacy'];

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
});

test.afterAll(async () => {
  // 只清理本测试创建的规则，避免误删开发者的真实规则
  await win.evaluate(async (names) => {
    for (const r of await window.api.rulesList()) {
      if (names.includes(r.name)) await window.api.rulesRemove(r.id);
    }
  }, CLEANUP_NAMES);
  await app.close();
});

test('query rows match enabled rows only; legacy record query still matches', async () => {
  await win.waitForSelector('[data-testid="traffic-tab"]');

  // 确保代理在运行
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  const status = await win.evaluate(() => window.api.proxyStatus());
  expect(status.running).toBe(true);

  // 行规则先加（优先级高，先检查）；fallback 无 query 条件兜底，用于证明行规则未命中
  await win.evaluate(async (rules) => {
    for (const r of rules) await window.api.rulesAdd(r);
  }, [
    {
      name: 'e2e-query-rows',
      enabled: true,
      match: {
        urlType: 'wildcard',
        // req.url 含 query string，exact 匹配会连查询串一起比对，这里用通配符只锁路径
        urlPattern: `http://${HOST}/api*`,
        method: 'ANY',
        query: [
          { enabled: true, name: 'page', value: '2', description: '' },
          { enabled: false, name: 'debug', value: '1', description: '' },
        ],
      },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'query-hit' },
    },
    {
      name: 'e2e-query-fallback',
      enabled: true,
      match: { urlType: 'wildcard', urlPattern: `http://${HOST}/api*`, method: 'ANY' },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'query-fallback' },
    },
    {
      // 旧版持久化格式：query 是 Record
      name: 'e2e-query-legacy',
      enabled: true,
      match: {
        urlType: 'wildcard',
        urlPattern: `http://${HOST}/legacy*`,
        method: 'ANY',
        query: { page: '2' },
      },
      action: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'legacy-hit' },
    },
  ]);

  const agent = new ProxyAgent(`http://127.0.0.1:${status.port}`);
  const get = async (path: string) => {
    const res = await fetch(`http://${HOST}${path}`, { dispatcher: agent });
    return { status: res.status, text: await res.text() };
  };

  // 命中：启用行 page=2 满足
  expect(await get('/api?page=2')).toEqual({ status: 200, text: 'query-hit' });
  // 禁用行 debug=1 不参与匹配
  expect(await get('/api?page=2&debug=1')).toEqual({ status: 200, text: 'query-hit' });
  // 值不相等 → 行规则未命中，落到 fallback
  expect(await get('/api?page=3')).toEqual({ status: 200, text: 'query-fallback' });
  // 缺少 page → 落到 fallback
  expect(await get('/api?debug=1')).toEqual({ status: 200, text: 'query-fallback' });
  // 旧 Record 格式规则仍按原语义匹配
  expect(await get('/legacy?page=2')).toEqual({ status: 200, text: 'legacy-hit' });
  await agent.close();
});
