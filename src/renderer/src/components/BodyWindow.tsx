import { useEffect, useMemo, useState } from 'react';
import type { BodyWindowPayload } from '../../../shared/types';
import { gzipDecodeBytes, gunzipText, sniffGzip } from '../lib/body-codec';
import { flattenJson } from '../lib/json-flatten';
import { formatJson, parseJsonBody, tokenizeLines, type JsonToken } from '../lib/json-format';
import { shouldAutoOpen } from '../lib/json-tree';
import JsonTree from './JsonTree';
import PathTable from './PathTable';
import VirtualLines from './VirtualLines';

type Tab = 'text' | 'tree' | 'paths';

/** 超过这个长度就不做语法高亮：几 MB 的体会切出上百万个 token 对象，光构造就卡死页面。 */
const HIGHLIGHT_MAX_LENGTH = 100_000;

const NOOP = (): void => {};

/**
 * payload 是一次性取走的，而 StrictMode 会把 effect 跑两遍：第二次必然拿到 null。
 * 按 token 缓存这一个 promise，让重复挂载共用同一次 IPC。
 */
const taken = new Map<string, Promise<BodyWindowPayload | null>>();

function takeOnce(token: string): Promise<BodyWindowPayload | null> {
  let p = taken.get(token);
  if (!p) {
    p = window.api.bodyWindowTake(token);
    taken.set(token, p);
  }
  return p;
}

function plainLines(text: string): JsonToken[][] {
  return text.split('\n').map((t) => (t.length > 0 ? [{ text: t, kind: 'plain', depth: 0 }] : []));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface Props {
  token: string;
}

export default function BodyWindow({ token }: Props) {
  const [payload, setPayload] = useState<BodyWindowPayload | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('text');
  const [gunzipped, setGunzipped] = useState<string | null>(null);
  const [gunzipError, setGunzipError] = useState<string | null>(null);
  const [useGunzip, setUseGunzip] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    takeOnce(token)
      .then((p) => {
        if (cancelled) return;
        if (p) setPayload(p);
        else setFailed('内容已失效，请回到流量详情重新打开');
      })
      .catch(() => {
        if (!cancelled) setFailed('读取内容失败');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const raw = payload?.body ?? '';
  const sniff = useMemo(() => sniffGzip(raw), [raw]);

  // 检测到 gzip 就默认解压：压缩字节没法读，「展示完全」的前提是先能看懂。
  useEffect(() => {
    if (!payload || !sniff.detected || !sniff.via) return;
    let cancelled = false;
    gunzipText(gzipDecodeBytes(raw, sniff.via))
      .then((value) => {
        if (cancelled) return;
        setGunzipped(value);
        setUseGunzip(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setGunzipError(e instanceof Error && e.message ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [payload, raw, sniff]);

  useEffect(() => {
    if (!payload) return;
    document.title = `${payload.method} ${payload.status ?? '—'} · ${hostOf(payload.url)}`;
  }, [payload]);

  const text = useGunzip && gunzipped !== null ? gunzipped : raw;

  const formatted = useMemo(() => {
    const r = formatJson(text);
    return r.ok ? r.formatted : text;
  }, [text]);

  const lines = useMemo<JsonToken[][]>(
    () => (formatted.length <= HIGHLIGHT_MAX_LENGTH ? tokenizeLines(formatted) : plainLines(formatted)),
    [formatted],
  );

  const parsed = useMemo(() => parseJsonBody(text), [text]);

  // 拍平几十万行有成本，只在真正切到该页时做。
  const flat = useMemo(
    () => (tab === 'paths' && parsed.ok ? flattenJson(parsed.value) : null),
    [tab, parsed],
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (failed) {
    return (
      <div className="body-window">
        <div className="body-window-error text-err" data-testid="body-window-error">
          {failed}
        </div>
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="body-window">
        <div className="body-window-loading muted" data-testid="body-window-loading">
          读取中…
        </div>
      </div>
    );
  }

  const tabClass = (t: Tab): string => (tab === t ? 'tab active' : 'tab');
  const byteLength = new TextEncoder().encode(text).byteLength;

  return (
    <div className="body-window">
      <header className="body-window-head">
        <div className="body-window-title" data-testid="body-window-title">
          <span className="body-window-method">{payload.method}</span>
          {payload.status !== undefined && <span className="body-window-status">{payload.status}</span>}
          <span className="body-window-url" title={payload.url}>
            {payload.url}
          </span>
        </div>
        <div className="body-window-actions">
          {sniff.detected && (
            <label className="body-window-toggle">
              <input
                type="checkbox"
                data-testid="body-window-gunzip"
                checked={useGunzip}
                disabled={gunzipped === null}
                onChange={(e) => setUseGunzip(e.target.checked)}
              />
              gzip 解压
            </label>
          )}
          <span className="body-window-size" data-testid="body-window-size">
            {byteLength.toLocaleString('en-US')} B
          </span>
          <button type="button" data-testid="body-window-copy" disabled={text.length === 0} onClick={() => void copy()}>
            {copied ? '已复制' : '复制全文'}
          </button>
        </div>
      </header>

      {gunzipError && (
        <div className="body-window-notice text-err" data-testid="body-window-gunzip-error">
          gzip 解压失败，正在显示原始内容：{gunzipError}
        </div>
      )}

      <nav className="body-tabs body-window-tabs">
        <button type="button" className={tabClass('text')} data-testid="body-window-tab-text" onClick={() => setTab('text')}>
          文本
        </button>
        <button
          type="button"
          className={tabClass('tree')}
          data-testid="body-window-tab-tree"
          disabled={!parsed.ok}
          onClick={() => setTab('tree')}
        >
          树视图
        </button>
        <button
          type="button"
          className={tabClass('paths')}
          data-testid="body-window-tab-paths"
          disabled={!parsed.ok}
          onClick={() => setTab('paths')}
        >
          路径映射表
        </button>
        {!parsed.ok && text.trim().length > 0 && (
          <span className="body-window-hint muted" data-testid="body-window-not-json">
            非 JSON，仅文本视图可用
          </span>
        )}
      </nav>

      <main className="body-window-content">
        {tab === 'text' ? (
          <VirtualLines lines={lines} />
        ) : tab === 'tree' && parsed.ok ? (
          <div className="json-tree" data-testid="body-window-tree">
            <JsonTree value={parsed.value} onChange={NOOP} readOnly autoOpen={shouldAutoOpen} />
          </div>
        ) : flat ? (
          <PathTable rows={flat.rows} truncated={flat.truncated} />
        ) : null}
      </main>
    </div>
  );
}
