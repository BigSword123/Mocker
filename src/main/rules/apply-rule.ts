import type { MockRule, RenderContext } from '../../shared/types';
import { renderTemplate } from './template';
import { resolveNetworkError, type NetworkErrorResolution } from './network-error';
import { sleep } from '../util/sleep';

export interface MockComputation {
  status: number;
  headers: Record<string, string>;
  body: string;
  warnings: string[];
  /** 概率网络异常命中时的处理决定；null 表示走正常 mock 响应。 */
  networkError: NetworkErrorResolution | null;
}

export interface MockComputationOptions {
  signal?: AbortSignal;
  rng?: () => number;
  sequenceIndex?: number;
}

/**
 * 纯计算：给定命中规则与渲染上下文，算出代理/重放共用的 mock 结果。
 * 顺序与原 proxy-server.handleMatched 一致：概率异常 → 固定延迟 → 模板渲染。
 * signal 在延迟期间中止时抛出（调用方决定如何收尾）。
 */
export async function computeMockResult(
  matched: MockRule,
  ctx: RenderContext,
  options: MockComputationOptions = {},
): Promise<MockComputation> {
  if ('responses' in matched.action) {
    const responses = matched.action.responses;
    const idx = Math.max(0, Math.min(options.sequenceIndex ?? 0, responses.length - 1));
    const step = responses[idx]!;
    const warnings: string[] = [];
    const body = renderTemplate(step.body, ctx, matched.action.fakerLocale, warnings);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(step.headers)) {
      headers[k] = renderTemplate(v, ctx, matched.action.fakerLocale, warnings);
    }
    return { status: step.status, headers, body, warnings, networkError: null };
  }

  const action = matched.action;
  const ne = action.networkError;
  const rng = options.rng ?? Math.random;
  if (ne && rng() * 100 < ne.probability) {
    return { status: 0, headers: {}, body: '', warnings: [], networkError: resolveNetworkError(ne) };
  }

  const delayMs = action.delayMs ?? 0;
  if (delayMs > 0) {
    await sleep(delayMs, options.signal);
  }

  const warnings: string[] = [];
  const body = renderTemplate(action.body, ctx, action.fakerLocale, warnings);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(action.headers)) {
    headers[k] = renderTemplate(v, ctx, action.fakerLocale, warnings);
  }
  return { status: action.status, headers, body, warnings, networkError: null };
}
