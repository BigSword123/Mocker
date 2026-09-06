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

async function openNewRuleModal() {
  await win.locator('nav.tabs').getByRole('button', { name: '规则', exact: true }).click();
  await win.getByRole('button', { name: '新建规则', exact: true }).click();
  await expect(win.locator('.modal h2')).toHaveText('新建规则');
}

async function closeRuleModal() {
  await win.getByRole('button', { name: '取消', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);
}

const responseBody = () => win.locator('textarea[placeholder=\'{"code":0}\']');

test('格式化按钮美化响应体 JSON', async () => {
  await openNewRuleModal();
  const body = responseBody();
  await body.fill('{"a":1,"b":[1,2]}');
  await win.getByRole('button', { name: '格式化 JSON', exact: true }).click();
  await expect(body).toHaveValue('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  await closeRuleModal();
});

test('格式化非法 JSON 显示行内错误且不改写内容', async () => {
  await openNewRuleModal();
  const body = responseBody();
  await body.fill('{oops}');
  await win.getByRole('button', { name: '格式化 JSON', exact: true }).click();
  await expect(win.locator('.json-editor-error')).toBeVisible();
  await expect(body).toHaveValue('{oops}');
  await closeRuleModal();
});

test('树视图展开收起并可编辑回写', async () => {
  await openNewRuleModal();
  const body = responseBody();
  // 静态模式下 modal 内只有一个 json-editor；树视图里 textarea 已卸载，不能按 has 过滤
  const editor = win.locator('.json-editor');
  await body.fill('{"name":"alice","age":1}');
  await editor.getByRole('button', { name: '树视图', exact: true }).click();
  await expect(win.locator('.json-tree')).toBeVisible();
  await expect(win.getByLabel('字符串值')).toHaveValue('alice');

  // 收起根节点后子行不可见，再展开
  await win.getByRole('button', { name: '收起', exact: true }).click();
  await expect(win.locator('.json-tree-children')).toHaveCount(0);
  await win.getByRole('button', { name: '展开', exact: true }).click();
  await expect(win.locator('.json-tree-children')).toHaveCount(1);

  await win.getByLabel('字符串值').fill('bob');
  await win.getByLabel('数字值').fill('2');
  await editor.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(body).toHaveValue('{\n  "name": "bob",\n  "age": 2\n}');
  await closeRuleModal();
});

test('非法 JSON 进树视图提示并返回编辑', async () => {
  await openNewRuleModal();
  const body = responseBody();
  await body.fill('{{faker.person.firstName}}');
  await win.getByRole('button', { name: '树视图', exact: true }).click();
  await expect(win.locator('.json-tree-error')).toContainText('不是合法 JSON');
  await win.getByRole('button', { name: '返回编辑', exact: true }).click();
  await expect(body).toBeVisible();
  await expect(body).toHaveValue('{{faker.person.firstName}}');
  await closeRuleModal();
});

test('树视图新增属性与删除节点同步回响应体', async () => {
  await openNewRuleModal();
  const body = responseBody();
  const editor = win.locator('.json-editor');
  await body.fill('{"a":1}');
  await editor.getByRole('button', { name: '树视图', exact: true }).click();
  await editor.getByRole('button', { name: '+属性', exact: true }).click();
  await win.getByLabel('属性名').last().fill('b');
  const strValues = win.getByLabel('字符串值');
  await strValues.last().fill('x');
  await editor.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(body).toHaveValue('{\n  "a": 1,\n  "b": "x"\n}');

  // 删除属性 b：键名在 input 的 value 里，hasText 匹配不到，改从键名 input 找所在行
  await editor.getByRole('button', { name: '树视图', exact: true }).click();
  const keyInput = win.getByLabel('属性名').last();
  await expect(keyInput).toHaveValue('b');
  const bRow = keyInput.locator('..');
  await bRow.getByRole('button', { name: '删除节点' }).click();
  await editor.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(body).toHaveValue('{\n  "a": 1\n}');
  await closeRuleModal();
});

test('请求体 raw 模式同样支持格式化', async () => {
  await openNewRuleModal();
  await win.getByRole('button', { name: 'raw', exact: true }).click();
  const reqBody = win.locator('textarea[placeholder=\'{"keyword": "test"}\']');
  await reqBody.fill('{"k":1}');
  const reqEditor = win.locator('.json-editor').filter({ has: reqBody });
  await reqEditor.getByRole('button', { name: '格式化 JSON', exact: true }).click();
  await expect(reqBody).toHaveValue('{\n  "k": 1\n}');
  await closeRuleModal();
});

test('预览渲染结果为 JSON 时美化展示', async () => {
  await openNewRuleModal();
  const body = responseBody();
  await body.fill('{"code":"{{uuid}}"}');
  await win.getByRole('button', { name: '刷新预览', exact: true }).click();
  await expect(win.locator('pre.preview')).toContainText('{\n  "code": "');
  await closeRuleModal();
});

test('序列响应行使用同样的 JSON 编辑器（格式化 + 树视图）', async () => {
  await openNewRuleModal();
  await win.getByTestId('mode-sequential').check();

  const seq = win.getByTestId('sequential-editor');
  await expect(seq.locator('.seq-row')).toHaveCount(1);
  // 静态响应块已隐藏，页面上只剩序列行的响应体编辑器
  await expect(win.locator('textarea[placeholder=\'{"code":0}\']')).toHaveCount(1);

  const row0 = seq.locator('.seq-row').nth(0);
  const body0 = row0.locator('textarea');
  await body0.fill('{"a":1,"b":[1,2]}');
  await row0.getByRole('button', { name: '格式化 JSON', exact: true }).click();
  await expect(body0).toHaveValue('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');

  await row0.getByRole('button', { name: '树视图', exact: true }).click();
  await expect(row0.locator('.json-tree')).toBeVisible();
  await row0.getByRole('button', { name: '编辑', exact: true }).click();

  await win.getByTestId('seq-add').click();
  await expect(seq.locator('.seq-row')).toHaveCount(2);
  await expect(seq.locator('.json-editor')).toHaveCount(2);
  await closeRuleModal();
});

test('序列响应经编辑器保存后重新打开不丢', async () => {
  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) if (r.name === 'e2e-seq-editor') await window.api.rulesRemove(r.id);
  });
  await openNewRuleModal();
  await win.locator('.modal .form-grid input').first().fill('e2e-seq-editor');
  await win.locator('input[placeholder="http://api.example.com/*"]').fill('http://e2e.example.test/seq-editor');
  await win.getByTestId('mode-sequential').check();

  const seq = win.getByTestId('sequential-editor');
  await seq.locator('.seq-row').nth(0).locator('textarea').fill('{"n":1}');
  await win.getByTestId('seq-add').click();
  await win.getByLabel('序列响应 2 状态码').fill('201');
  await win.getByRole('button', { name: '保存', exact: true }).click();
  await expect(win.locator('.modal')).toHaveCount(0);

  await win.locator('.rules-table tr', { hasText: 'e2e-seq-editor' }).getByRole('button', { name: '编辑', exact: true }).click();
  await expect(win.getByTestId('sequential-editor').locator('.seq-row')).toHaveCount(2);
  await expect(win.locator('.seq-row').nth(0).locator('textarea')).toHaveValue('{"n":1}');
  await expect(win.getByLabel('序列响应 2 状态码')).toHaveValue('201');

  await win.evaluate(async () => {
    for (const r of await window.api.rulesList()) if (r.name === 'e2e-seq-editor') await window.api.rulesRemove(r.id);
  });
  await closeRuleModal();
});

test('序列模式下错误模板填入最后一条响应', async () => {
  await openNewRuleModal();
  await win.getByTestId('mode-sequential').check();
  const seq = win.getByTestId('sequential-editor');
  await win.getByTestId('seq-add').click();
  await expect(win.locator('.form-note', { hasText: '模板填入最后一条响应' })).toContainText('第 2 条');

  // 连接类模板在序列模式下不可选
  await expect(win.locator('#rule-error-template optgroup[label*="连接异常"]')).toHaveCount(0);

  await win.locator('#rule-error-template').selectOption('http-429');
  const last = seq.locator('.seq-row').nth(1);
  await expect(last.locator('input[type="number"]')).toHaveValue('429');
  await expect(last.locator('textarea')).toHaveValue(/RATE_LIMIT/);
  await expect(win.locator('#rule-error-template')).toHaveValue('http-429');

  // 改动最后一条 = 脱离模板；改动前面的条目不影响标记
  await last.locator('textarea').fill('{"x":1}');
  await expect(win.locator('#rule-error-template')).toHaveValue('custom');

  await win.locator('#rule-error-template').selectOption('http-404');
  await seq.locator('.seq-row').nth(0).locator('textarea').fill('{"keep":true}');
  await expect(win.locator('#rule-error-template')).toHaveValue('http-404');
  await closeRuleModal();
});
