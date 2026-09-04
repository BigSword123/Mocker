export interface FakerEntry {
  path: string;
  label: string;
  snippet: string;
  example: string;
  args?: string;
}

export interface FakerCategory {
  id: string;
  label: string;
  entries: FakerEntry[];
}

const entry = (path: string, label: string, example: string, args?: string): FakerEntry => ({
  path,
  label,
  example,
  args,
  snippet: `{{${path}}}`,
});

export const FAKER_CATALOG: FakerCategory[] = [
  {
    id: 'person',
    label: '人员',
    entries: [
      entry('faker.person.firstName', '名', '张伟'),
      entry('faker.person.lastName', '姓', '李'),
      entry('faker.person.fullName', '全名', '张伟'),
      entry('faker.person.sex', '性别', 'male'),
      entry('faker.person.jobTitle', '职位', '高级软件工程师'),
      entry('faker.person.avatar', '头像 URL', 'https://avatars.githubusercontent.com/...'),
    ],
  },
  {
    id: 'internet',
    label: '网络',
    entries: [
      entry('faker.internet.email', '邮箱', 'zhangwei@example.org'),
      entry('faker.internet.userName', '用户名', 'zhangwei99'),
      entry('faker.internet.password', '密码', 'aB3$kL9!mN2@pQ7'),
      entry('faker.internet.url', 'URL', 'https://wonderful-lake.name'),
      entry('faker.internet.ip', 'IPv4 地址', '203.0.113.42'),
      entry('faker.internet.domainName', '域名', 'example.com'),
    ],
  },
  {
    id: 'location',
    label: '位置',
    entries: [
      entry('faker.location.city', '城市', '北京市'),
      entry('faker.location.country', '国家', '中国'),
      entry('faker.location.zipCode', '邮编', '100000'),
      entry('faker.location.streetAddress', '街道地址', '长安街 1 号'),
      entry('faker.location.latitude', '纬度', '39.9042'),
      entry('faker.location.longitude', '经度', '116.4074'),
    ],
  },
  {
    id: 'date',
    label: '日期',
    entries: [
      entry('faker.date.past', '过去日期', '2024-03-15T08:30:00.000Z'),
      entry('faker.date.future', '未来日期', '2027-11-22T14:20:00.000Z'),
      entry('faker.date.recent', '最近几天', '2026-09-03T19:10:00.000Z'),
      entry('faker.date.birthdate', '出生日期', '1990-06-18T00:00:00.000Z'),
    ],
  },
  {
    id: 'number',
    label: '数字',
    entries: [
      entry('faker.number.int', '整数', '42', 'min, max'),
      entry('faker.number.float', '浮点数', '3.14', 'min, max, fractionDigits'),
      entry('faker.number.bigint', '大整数', '9007199254740991', 'min, max'),
    ],
  },
  {
    id: 'string',
    label: '字符串',
    entries: [
      entry('faker.string.uuid', 'UUID', '123e4567-e89b-12d3-a456-426614174000'),
      entry('faker.string.nanoid', 'Nano ID', 'a1B2_c3D4'),
      entry('faker.string.alpha', '字母串', 'abcXYZ'),
      entry('faker.string.alphanumeric', '字母数字串', 'aB3cD4'),
    ],
  },
  {
    id: 'finance',
    label: '金融',
    entries: [
      entry('faker.finance.amount', '金额', '1234.56'),
      entry('faker.finance.currencyCode', '货币代码', 'CNY'),
      entry('faker.finance.creditCardNumber', '信用卡号', '4111-1111-1111-1111'),
      entry('faker.finance.iban', 'IBAN', 'DE89370400440532013000'),
    ],
  },
  {
    id: 'company',
    label: '公司',
    entries: [
      entry('faker.company.name', '公司名', '腾讯科技有限公司'),
      entry('faker.company.catchPhrase', '口号', 'Innovative holistic synergy'),
      entry('faker.company.bs', '商业描述', 'leverage scalable platforms'),
    ],
  },
  {
    id: 'phone',
    label: '电话',
    entries: [entry('faker.phone.number', '电话号码', '138-1234-5678')],
  },
  {
    id: 'commerce',
    label: '商业',
    entries: [
      entry('faker.commerce.productName', '商品名', '智能无线鼠标'),
      entry('faker.commerce.price', '价格', '299.99'),
      entry('faker.commerce.productDescription', '商品描述', '高性能低功耗'),
    ],
  },
  {
    id: 'image',
    label: '图片',
    entries: [
      entry('faker.image.url', '随机图片 URL', 'https://loremflickr.com/640/480'),
      entry('faker.image.avatar', '头像', 'https://avatars.githubusercontent.com/...'),
    ],
  },
  {
    id: 'color',
    label: '颜色',
    entries: [
      entry('faker.color.human', '人可读颜色名', 'teal'),
      entry('faker.color.rgb', 'RGB 十六进制', '#3a7b9c'),
      entry('faker.color.hex', 'Hex 颜色', '#ff5733'),
    ],
  },
  {
    id: 'lorem',
    label: '文本',
    entries: [
      entry('faker.lorem.word', '单词', 'lorem'),
      entry('faker.lorem.words', '多个单词', 'lorem ipsum dolor'),
      entry('faker.lorem.sentence', '句子', 'Lorem ipsum dolor sit amet.'),
      entry('faker.lorem.paragraph', '段落', 'Lorem ipsum dolor sit amet, consectetur...'),
    ],
  },
];

export function findByPath(path: string): FakerEntry | undefined {
  for (const c of FAKER_CATALOG) {
    const e = c.entries.find((x) => x.path === path);
    if (e) return e;
  }
  return undefined;
}
