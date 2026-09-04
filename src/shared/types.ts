export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ANY';
export type UrlPatternType = 'exact' | 'wildcard' | 'regex';

export interface HeaderRow {
  enabled: boolean;
  name: string;
  value: string;
  description?: string;
}

export type BodyMode = 'none' | 'raw' | 'form-data' | 'urlencoded';
export type BodyMatchStrategy = 'contains' | 'equals' | 'json-deep';

export interface RuleBody {
  mode: BodyMode;
  raw?: string;
  rawContentType?: string;
  form?: HeaderRow[];
  matchStrategy?: BodyMatchStrategy;
}

export interface RuleMatch {
  urlType: UrlPatternType;
  urlPattern: string;
  method: HttpMethod;
  query?: Record<string, string> | HeaderRow[];
  headers?: Record<string, string> | HeaderRow[];
  bodyContains?: string;
  body?: RuleBody;
}

export interface MockRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match: RuleMatch;
  action: RuleAction;
}

export type RuleInput = Omit<MockRule, 'id' | 'priority'>;
export type RulePatch = Partial<Omit<MockRule, 'id'>>;

export interface TrafficEvent {
  id: string;
  startedAt: number;
  completedAt?: number;
  method: string;
  url: string;
  host: string;
  path: string;
  status?: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  mocked: boolean;
  matchedRuleId?: string;
  error?: string;
  renderWarnings?: string[];
  errorTriggered?: boolean;
}

export type HttpsMode = 'whitelist' | 'full';

export interface Settings {
  proxyPort: number;
  wsPort: number;
  httpsMode: HttpsMode;
  whitelist: string[];
  autoStartProxy: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  proxyPort: 8888,
  wsPort: 8899,
  httpsMode: 'whitelist',
  whitelist: [],
  autoStartProxy: true,
};

export interface ProxyStatus {
  running: boolean;
  port: number;
  localIps: string[];
}

export interface CertInfo {
  expiresAt: number;
}

export interface CertInstallCommands {
  platform: 'macos' | 'windows' | 'other';
  macos: string;
  windows: string;
}

export const NETWORK_ERROR_TYPES = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'TRUNCATE',
  'HTTP_STATUS',
] as const;

export type NetworkErrorType = (typeof NETWORK_ERROR_TYPES)[number];

export interface NetworkError {
  probability: number;
  type: NetworkErrorType;
  errorStatusCode?: number;
}

export interface RuleAction {
  status: number;
  headers: Record<string, string>;
  body: string;
  delayMs?: number;
  fakerLocale?: string;
  networkError?: NetworkError;
}

export interface RenderContext {
  method: string;
  url: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
}

export const DELAY_MS_MAX = 300_000;
