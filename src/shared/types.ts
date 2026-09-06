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
  scenario?: string;
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
  origin?: 'capture' | 'replay' | 'imported';
  replayedFromId?: string;
  sequenceIndex?: number;
  /** 实际施加的限速延迟，仅在 >0ms 时写入，单位 ms */
  throttledMs?: number;
}

export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface TrafficFilter {
  text: string;
  method: string;
  status: string;
  host: string;
}

export type HttpsMode = 'whitelist' | 'full';

export interface Settings {
  proxyPort: number;
  wsPort: number;
  httpsMode: HttpsMode;
  whitelist: string[];
  autoStartProxy: boolean;
  throttle: ThrottleSettings;
}

export type ThrottlePreset = 'three-g' | 'slow-three-g' | 'dialup' | 'weak-wifi' | 'custom';

export interface ThrottleSettings {
  enabled: boolean;
  preset: ThrottlePreset;
  downKbps: number;
  latencyMs: number;
  jitterMs: number;
}

export const DOWN_KBPS_MAX = 100_000;
export const LATENCY_MS_MAX = 60_000;
export const JITTER_MS_MAX = 30_000;

export const THROTTLE_PRESETS: Record<
  Exclude<ThrottlePreset, 'custom'>,
  Pick<ThrottleSettings, 'downKbps' | 'latencyMs' | 'jitterMs'>
> = {
  'three-g': { downKbps: 200, latencyMs: 300, jitterMs: 100 },
  'slow-three-g': { downKbps: 50, latencyMs: 800, jitterMs: 300 },
  dialup: { downKbps: 6, latencyMs: 120, jitterMs: 20 },
  'weak-wifi': { downKbps: 400, latencyMs: 100, jitterMs: 80 },
};

export const THROTTLE_PRESET_LABELS: Record<ThrottlePreset, string> = {
  'three-g': '3G',
  'slow-three-g': '慢速 3G',
  dialup: '56K 拨号',
  'weak-wifi': '弱 WiFi',
  custom: '自定义',
};

export const DEFAULT_SETTINGS: Settings = {
  proxyPort: 8888,
  wsPort: 8899,
  httpsMode: 'whitelist',
  whitelist: [],
  autoStartProxy: true,
  throttle: { enabled: false, preset: 'three-g', ...THROTTLE_PRESETS['three-g'] },
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

export type RuleAction =
  | {
      status: number;
      headers: Record<string, string>;
      body: string;
      delayMs?: number;
      fakerLocale?: string;
      networkError?: NetworkError;
    }
  | {
      responses: SequentialResponse[];
      fakerLocale?: string;
    };

export interface SequentialResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RedirectRule {
  id: string;
  name: string;
  enabled: boolean;
  scenario?: string;
  priority: number;
  match: RuleMatch;
  action: 'mapLocal' | 'mapRemote';
  target: string;
}

export interface MapLocalSaveInput {
  url: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

export interface Scenario {
  name: string;
  enabled: boolean;
  /** 内置场景「默认」：不可删除、不可改名，缺失时启动自动补种 */
  builtin?: boolean;
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

export interface AdbDevice {
  serial: string;
  state: string;
}

export interface AdbStatus {
  adbAvailable: boolean;
  installHint?: string;
  devices: AdbDevice[];
  activeSerial?: string;
  tunnelActive: boolean;
  phoneProxySet: boolean;
}

export interface AdbOpResult {
  ok: boolean;
  message: string;
}
