import { _electron as electron, test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fetch, ProxyAgent } from 'undici';
import { gzipSync } from 'node:zlib';

let app: ElectronApplication;
let win: Page;

const RULE_NESTED = 'e2e-bw-nested';
const RULE_BIG = 'e2e-bw-big';
const RULE_GZIP = 'e2e-bw-gzip';
const RULE_NAMES = [RULE_NESTED, RULE_BIG, RULE_GZIP];

const URL_NESTED = 'http://e2e.example.test/bw-nested';
const URL_BIG = 'http://e2e.example.test/bw-big';
const URL_GZIP = 'http://e2e.example.test/bw-gzip';

/** deep.l2 在 JsonTree 里是第 3 层，超过 shouldAutoOpen 的深度上限，默认必须收起 */
const NESTED = '{"id":1,"user":{"name":"张三"},"deep":{"l2":{"leaf":"found-me"}}}';
const BIG = JSON.stringify({ items: Array.from({ length: 5_000 }, (_, i) => ({ i })) });
const GZIPPED = Buffer.from(gzipSync(new TextEncoder().encode(NESTED), { level: 9 })).toString('base64');

test.beforeAll(async () => {
  app = await electron.launch({ args: ['.'] });
  win = await app.firstWindow();
  // 持久化的 monitorMode 可能是「电脑」，那会打开真实系统代理，把用户浏览器的流量
  // 灌进虚拟滚动表，本 spec 的行会被挤出已渲染范围。先关掉，再只用 ProxyAgent 打流量。
  await win.evaluate(() => window.api.monitorSetMode('off'));
  await win.locator('[data-testid="filter-host"]').fill('e2e.example.test');
});

test.afterAll(async () => {
  await win.locator('[data-testid="filter-clear"]').click();
  await win.evaluate(async (names: string[]) => {
    for (const r of await window.api.rulesList()) {
      if (names.includes(r.name)) await window.api.rulesRemove(r.id);
    }
  }, RULE_NAMES);
  await win.evaluate(() => window.api.monitorSetMode('computer'));
  await app.close();
});

async function ensureProxy(): Promise<number> {
  await win.evaluate(async () => {
    const status = await window.api.proxyStatus();
    if (!status.running) await window.api.proxyStart();
  });
  return (await win.evaluate(() => window.api.proxyStatus())).port;
}

async function addRule(name: string, url: string, body: string): Promise<void> {
  await win.evaluate(
    async ([n, u, b]: [string, string, string]) => {
      await window.api.rulesAdd({
        name: n,
        enabled: true,
        match: { urlType: 'exact', urlPattern: u, method: 'GET' },
        action: { status: 200, headers: { 'content-type': 'application/json' }, body: b },
      });
    },
    [name, url, body] as [string, string, string],
  );
}

async function fetchViaProxy(port: number, url: string): Promise<void> {
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  try {
    await fetch(url, { method: 'GET', dispatcher: agent });
  } finally {
    await agent.close();
  }
}

async function selectRow(keyword: string): Promise<void> {
  const row = win.locator('.traffic-table .row', { hasText: keyword }).first();
  await row.waitFor({ state: 'visible', timeout: 10_000 });
  await row.click();
}

/** 弹窗由主进程创建，这里等它出现再等 payload 落地（标题栏只在拿到内容后才渲染）。 */
async function openPopout(): Promise<Page> {
  const [popout] = await Promise.all([
    app.waitForEvent('window'),
    win.locator('[data-testid="body-open-window"]').click(),
  ]);
  await expect(popout.locator('[data-testid="body-window-title"]')).toBeVisible({ timeout: 15_000 });
  return popout;
}

test('文本视图完整展示格式化后的响应体', async () => {
  const port = await ensureProxy();
  await addRule(RULE_NESTED, URL_NESTED, NESTED);
  await fetchViaProxy(port, URL_NESTED);
  await selectRow('bw-nested');

  const popout = await openPopout();
  try {
    const title = popout.locator('[data-testid="body-window-title"]');
    await expect(title).toContainText('GET');
    await expect(title).toContainText('e2e.example.test');
    await expect(title).toContainText(URL_NESTED);

    const lines = popout.locator('[data-testid="virtual-lines"]');
    const expected = JSON.stringify(JSON.parse(NESTED), null, 2).split('\n').length;
    await expect(lines).toHaveAttribute('data-line-count', String(expected));
    await expect(lines.locator('.virtual-line').first()).toContainText('{');
    // 100k 以内走高亮：深层键会带上 json-d* 配色
    await expect(lines.locator('.json-d1').first()).toBeVisible();
  } finally {
    await popout.close();
  }
});

test('树视图默认收起深层节点，且为只读', async () => {
  await selectRow('bw-nested');
  const popout = await openPopout();
  try {
    await popout.locator('[data-testid="body-window-tab-tree"]').click();
    const tree = popout.locator('[data-testid="body-window-tree"]');
    await expect(tree).toBeVisible();

    await expect(tree.locator('.json-tree-key', { hasText: 'user' })).toBeVisible();
    await expect(tree.locator('.json-tree-ro', { hasText: 'found-me' })).toHaveCount(0);

    // 只读：没有任何编辑控件
    await expect(tree.locator('input')).toHaveCount(0);
    await expect(tree.locator('.json-tree-add')).toHaveCount(0);
    await expect(tree.locator('.json-tree-del')).toHaveCount(0);

    // 这个 fixture 里只有 deep.l2 深到会被默认收起，所以「展开」按钮有且仅有一个
    const collapsed = tree.locator('.json-tree-toggle[aria-label="展开"]');
    await expect(collapsed).toHaveCount(1);
    await collapsed.click();
    await expect(tree.locator('.json-tree-ro', { hasText: 'found-me' })).toBeVisible();
  } finally {
    await popout.close();
  }
});

test('路径映射表列出全部路径，可搜索并复制', async () => {
  await selectRow('bw-nested');
  const popout = await openPopout();
  try {
    await popout.locator('[data-testid="body-window-tab-paths"]').click();

    // $ / $.id / $.user / $.user.name / $.deep / $.deep.l2 / $.deep.l2.leaf
    await expect(popout.locator('[data-testid="path-table-count"]')).toHaveText('7 行');
    await expect(popout.locator('.path-row[data-path="$"]')).toBeVisible();
    await expect(popout.locator('.path-row[data-path="$.deep.l2.leaf"]')).toBeVisible();
    await expect(popout.locator('.path-row[data-path="$.user.name"] .path-cell-preview')).toHaveText('张三');

    await popout.locator('[data-testid="path-table-search"]').fill('deep');
    await expect(popout.locator('[data-testid="path-table-count"]')).toHaveText('3 / 7 行');
    await expect(popout.locator('.path-row[data-path="$.user.name"]')).toHaveCount(0);

    const copy = popout
      .locator('.path-row[data-path="$.deep.l2"]')
      .locator('[data-testid="path-copy"]');
    await copy.click();
    await expect(copy).toHaveText('已复制', { timeout: 5_000 });
  } finally {
    await popout.close();
  }
});

test('超大响应体不截断，只渲染视口内的行', async () => {
  const port = await ensureProxy();
  await addRule(RULE_BIG, URL_BIG, BIG);
  await fetchViaProxy(port, URL_BIG);
  await selectRow('bw-big');

  const popout = await openPopout();
  try {
    const expected = JSON.stringify(JSON.parse(BIG), null, 2).split('\n').length;
    expect(expected).toBeGreaterThan(10_000);

    const lines = popout.locator('[data-testid="virtual-lines"]');
    await expect(lines).toHaveAttribute('data-line-count', String(expected), { timeout: 30_000 });

    const rendered = await lines.locator('.virtual-line').count();
    expect(rendered).toBeLessThan(300);

    // 滚到底部仍能渲染出最后一行，证明全量数据都在
    await lines.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(lines.locator('.virtual-line').last()).toContainText('}', { timeout: 10_000 });
  } finally {
    await popout.close();
  }
});

test('gzip 响应体自动解压，可切回原始内容', async () => {
  const port = await ensureProxy();
  await addRule(RULE_GZIP, URL_GZIP, GZIPPED);
  await fetchViaProxy(port, URL_GZIP);
  await selectRow('bw-gzip');

  const popout = await openPopout();
  try {
    const toggle = popout.locator('[data-testid="body-window-gunzip"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked({ timeout: 10_000 });

    const lines = popout.locator('[data-testid="virtual-lines"]');
    const decompressed = JSON.stringify(JSON.parse(NESTED), null, 2).split('\n').length;
    await expect(lines).toHaveAttribute('data-line-count', String(decompressed));
    await expect(lines.locator('.virtual-line', { hasText: 'found-me' }).first()).toBeVisible();

    await toggle.uncheck();
    await expect(lines).toHaveAttribute('data-line-count', '1');
    await expect(lines.locator('.virtual-line').first()).toContainText(GZIPPED.slice(0, 24));
    // base64 不是 JSON，结构化视图必须置灰而不是渲染出错误的树
    await expect(popout.locator('[data-testid="body-window-tab-tree"]')).toBeDisabled();
    await expect(popout.locator('[data-testid="body-window-tab-paths"]')).toBeDisabled();
    await expect(popout.locator('[data-testid="body-window-not-json"]')).toBeVisible();

    await toggle.check();
    await expect(popout.locator('[data-testid="body-window-tab-tree"]')).toBeEnabled();
    await expect(popout.locator('[data-testid="body-window-not-json"]')).toHaveCount(0);
  } finally {
    await popout.close();
  }
});
