import { randomUUID } from 'node:crypto';
import type { BodyWindowPayload } from '../shared/types';

export type { BodyWindowPayload };

/** 弹窗加载完就会来取；超过这个时间没取说明窗口没开起来，不能一直占着这份 body。 */
export const BODY_WINDOW_TTL_MS = 60_000;

export interface BodyWindowStoreOptions {
  now?: () => number;
  newToken?: () => string;
  ttlMs?: number;
}

interface Entry {
  payload: BodyWindowPayload;
  expiresAt: number;
}

/**
 * 一次性 payload 仓库。body 可能有几 MB，不适合塞进 URL，也不适合用
 * did-finish-load 后推送（要和渲染进程注册监听抢时序），所以走「主进程暂存 +
 * 弹窗自己按 token 来拉」。
 */
export class BodyWindowStore {
  private readonly pending = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly newToken: () => string;
  private readonly ttlMs: number;

  constructor(opts: BodyWindowStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.newToken = opts.newToken ?? (() => randomUUID());
    this.ttlMs = opts.ttlMs ?? BODY_WINDOW_TTL_MS;
  }

  put(payload: BodyWindowPayload): string {
    this.sweep();
    const token = this.newToken();
    this.pending.set(token, { payload, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /** 取走即删；过期的返回 null 但也一样删掉，不留垃圾。 */
  take(token: string): BodyWindowPayload | null {
    const entry = this.pending.get(token);
    if (!entry) return null;
    this.pending.delete(token);
    return entry.expiresAt > this.now() ? entry.payload : null;
  }

  get size(): number {
    return this.pending.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token);
    }
  }
}
