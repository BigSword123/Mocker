export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'ANY';
export type UrlPatternType = 'exact' | 'wildcard' | 'regex';

export interface RuleMatch {
  urlType: UrlPatternType;
  urlPattern: string;
  method: HttpMethod;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  bodyContains?: string;
}

export interface RuleAction {
  status: number;
  headers: Record<string, string>;
  body: string;
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
export type RulePatch = Partial<Omit<MockRule, 'id' | 'priority'>>;

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
