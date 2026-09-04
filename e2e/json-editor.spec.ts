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
  await body.fill('{"name":"alice","age":1}');
  await win.getByRole('button', { name: '树视图', exact: true }).click();
  await expect(win.locator('.json-tree')).toBeVisible();
  await expect(win.getByLabel('字符串值')).toHaveValue('alice');

  // 收起根节点后子行不可见，再展开
  await win.getByRole('button', { name: '收起', exact: true }).click();
  await expect(win.locator('.json-tree-children')).toHaveCount(0);
  await win.getByRole('button', { name: '展开', exact: true }).click();
  await expect(win.locator('.json-tree-children')).toHaveCount(1);

  await win.getByLabel('字符串值').fill('bob');
  await win.getByLabel('数字值').fill('2');
  await win.getByRole('button', { name: '编辑', exact: true }).click();
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
  await body.fill('{"a":1}');
  await win.getByRole('button', { name: '树视图', exact: true }).click();
  await win.getByRole('button', { name: '+属性', exact: true }).click();
  await win.getByLabel('属性名').last().fill('b');
  const strValues = win.getByLabel('字符串值');
  await strValues.last().fill('x');
  await win.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(body).toHaveValue('{\n  "a": 1,\n  "b": "x"\n}');

  // 删除属性 b：键名在 input 的 value 里，hasText 匹配不到，改从键名 input 找所在行
  await win.getByRole('button', { name: '树视图', exact: true }).click();
  const keyInput = win.getByLabel('属性名').last();
  await expect(keyInput).toHaveValue('b');
  const bRow = keyInput.locator('..');
  await bRow.getByRole('button', { name: '删除节点' }).click();
  await win.getByRole('button', { name: '编辑', exact: true }).click();
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
