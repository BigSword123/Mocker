import type { NetworkError } from './types';

export type ErrorTemplateCategory = 'http-4xx' | 'http-5xx' | 'connection';

export type ErrorTemplatePayload =
  | { kind: 'http'; status: number; body: string; headers?: Record<string, string> }
  | { kind: 'connection'; networkError: NetworkError };

export interface ErrorTemplate {
  id: string;
  category: ErrorTemplateCategory;
  label: string;
  description: string;
  payload: ErrorTemplatePayload;
}

function httpErr(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } }, null, 2);
}

export const ERROR_TEMPLATES: ErrorTemplate[] = [
  {
    id: 'http-400',
    category: 'http-4xx',
    label: '400 Bad Request',
    description: '请求参数错误',
    payload: { kind: 'http', status: 400, body: httpErr('BAD_REQUEST', '请求参数错误') },
  },
  {
    id: 'http-401',
    category: 'http-4xx',
    label: '401 Unauthorized',
    description: '未授权',
    payload: { kind: 'http', status: 401, body: httpErr('UNAUTHORIZED', '未授权，请重新登录') },
  },
  {
    id: 'http-403',
    category: 'http-4xx',
    label: '403 Forbidden',
    description: '无权访问',
    payload: { kind: 'http', status: 403, body: httpErr('FORBIDDEN', '无权访问该资源') },
  },
  {
    id: 'http-404',
    category: 'http-4xx',
    label: '404 Not Found',
    description: '资源不存在',
    payload: { kind: 'http', status: 404, body: httpErr('NOT_FOUND', '请求的资源不存在') },
  },
  {
    id: 'http-405',
    category: 'http-4xx',
    label: '405 Method Not Allowed',
    description: '方法不允许',
    payload: {
      kind: 'http',
      status: 405,
      body: httpErr('METHOD_NOT_ALLOWED', '请求方法不允许'),
    },
  },
  {
    id: 'http-408',
    category: 'http-4xx',
    label: '408 Request Timeout',
    description: '请求超时',
    payload: { kind: 'http', status: 408, body: httpErr('REQUEST_TIMEOUT', '请求超时') },
  },
  {
    id: 'http-409',
    category: 'http-4xx',
    label: '409 Conflict',
    description: '资源冲突',
    payload: { kind: 'http', status: 409, body: httpErr('CONFLICT', '资源冲突') },
  },
  {
    id: 'http-422',
    category: 'http-4xx',
    label: '422 Unprocessable Entity',
    description: '无法处理',
    payload: { kind: 'http', status: 422, body: httpErr('UNPROCESSABLE', '请求数据无法处理') },
  },
  {
    id: 'http-429',
    category: 'http-4xx',
    label: '429 Too Many Requests',
    description: '限流',
    payload: {
      kind: 'http',
      status: 429,
      body: httpErr('RATE_LIMIT', '请求过于频繁，请稍后重试'),
      headers: { 'retry-after': '60' },
    },
  },
  {
    id: 'http-500',
    category: 'http-5xx',
    label: '500 Internal Server Error',
    description: '服务端错误',
    payload: { kind: 'http', status: 500, body: httpErr('INTERNAL_ERROR', '服务器内部错误') },
  },
  {
    id: 'http-501',
    category: 'http-5xx',
    label: '501 Not Implemented',
    description: '未实现',
    payload: { kind: 'http', status: 501, body: httpErr('NOT_IMPLEMENTED', '功能未实现') },
  },
  {
    id: 'http-502',
    category: 'http-5xx',
    label: '502 Bad Gateway',
    description: '网关错误',
    payload: { kind: 'http', status: 502, body: httpErr('BAD_GATEWAY', '网关错误') },
  },
  {
    id: 'http-503',
    category: 'http-5xx',
    label: '503 Service Unavailable',
    description: '服务不可用',
    payload: {
      kind: 'http',
      status: 503,
      body: httpErr('SERVICE_UNAVAILABLE', '服务暂不可用'),
      headers: { 'retry-after': '30' },
    },
  },
  {
    id: 'http-504',
    category: 'http-5xx',
    label: '504 Gateway Timeout',
    description: '网关超时',
    payload: { kind: 'http', status: 504, body: httpErr('GATEWAY_TIMEOUT', '网关超时') },
  },
  {
    id: 'conn-econnreset',
    category: 'connection',
    label: 'Connection reset',
    description: '连接被重置',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ECONNRESET' } },
  },
  {
    id: 'conn-etimedout',
    category: 'connection',
    label: 'Connection timed out',
    description: '连接超时',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ETIMEDOUT' } },
  },
  {
    id: 'conn-enotfound',
    category: 'connection',
    label: 'Host not found',
    description: '域名解析失败',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ENOTFOUND' } },
  },
  {
    id: 'conn-econnrefused',
    category: 'connection',
    label: 'Connection refused',
    description: '连接被拒绝',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'ECONNREFUSED' } },
  },
  {
    id: 'conn-truncate',
    category: 'connection',
    label: 'Response truncated',
    description: '响应被截断',
    payload: { kind: 'connection', networkError: { probability: 100, type: 'TRUNCATE' } },
  },
];

export function findById(id: string): ErrorTemplate | undefined {
  return ERROR_TEMPLATES.find((template) => template.id === id);
}
