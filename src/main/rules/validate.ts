import {
  DELAY_MS_MAX,
  NETWORK_ERROR_TYPES,
  type NetworkError,
  type RuleAction,
} from '../../shared/types';

export function validateAction(action: RuleAction): void {
  if (action.kind === 'sequential') {
    if (!Array.isArray(action.responses) || action.responses.length === 0) {
      throw new Error('序列响应至少需要 1 个响应');
    }
    action.responses.forEach((r, i) => {
      if (r.status < 100 || r.status > 999) {
        throw new Error(`第 ${i + 1} 个响应的状态码无效: ${r.status}`);
      }
    });
    return;
  }
  if (action.delayMs !== undefined) {
    if (!Number.isInteger(action.delayMs)) {
      throw new Error('delayMs 必须是整数');
    }
    if (action.delayMs < 0 || action.delayMs > DELAY_MS_MAX) {
      throw new Error(`delayMs 必须在 0-${DELAY_MS_MAX} 之间`);
    }
  }
  if (action.networkError) {
    validateNetworkError(action.networkError);
  }
}

function validateNetworkError(ne: NetworkError): void {
  if (!NETWORK_ERROR_TYPES.includes(ne.type)) {
    throw new Error(`未知 networkError.type: ${ne.type}`);
  }
  if (typeof ne.probability !== 'number' || Number.isNaN(ne.probability)) {
    throw new Error('probability 必须是数值');
  }
  if (ne.probability < 0 || ne.probability > 100) {
    throw new Error('probability 必须在 0-100 之间');
  }
  if (ne.type === 'HTTP_STATUS') {
    const code = ne.errorStatusCode;
    if (code === undefined || !Number.isInteger(code) || code < 100 || code > 999) {
      throw new Error('HTTP_STATUS 需要 100-999 的整数 errorStatusCode');
    }
  }
}
