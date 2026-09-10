import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  gzipCompress,
  gzipDecodeBytes,
  gunzipText,
  sniffGzip,
  toBase64,
  toHexDump,
  type CompressResult,
} from '../lib/body-codec';
import { pretty } from '../lib/body-format';

type BodyView = 'raw' | 'gunzip' | 'gzip';

const GZIP_INPUT_MAX_BYTES = 5 * 1024 * 1024;
const HEX_RENDER_LIMIT = 4096;

type Calc<T> =
  | { status: 'idle' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }
  | { status: 'too-large'; message: string };

/** DecompressionStream 失败抛的是 message 为空的 TypeError，必须回退到 name。 */
function messageOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e instanceof Error && e.name) return e.name;
  return String(e);
}

interface Props {
  body: string | undefined;
  eventId: string;
}

export default function ResponseBodyViews({ body, eventId }: Props) {
  const text = body ?? '';
  const [view, setView] = useState<BodyView>('raw');
  const [copied, setCopied] = useState<string | null>(null);
  const [gunzipCalc, setGunzipCalc] = useState<Calc<string>>({ status: 'idle' });
  const [gzipCalc, setGzipCalc] = useState<Calc<CompressResult>>({ status: 'idle' });

  const sniff = useMemo(() => sniffGzip(text), [text]);
  const empty = text.length === 0;

  useEffect(() => {
    setView('raw');
    setCopied(null);
    setGunzipCalc({ status: 'idle' });
    setGzipCalc({ status: 'idle' });
  }, [eventId]);

  useEffect(() => {
    if (view !== 'gunzip' || gunzipCalc.status !== 'idle' || !sniff.via) return;
    let cancelled = false;
    gunzipText(gzipDecodeBytes(text, sniff.via))
      .then((value) => {
        if (!cancelled) setGunzipCalc({ status: 'ok', value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setGunzipCalc({ status: 'error', message: messageOf(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [view, gunzipCalc.status, sniff, text]);

  useEffect(() => {
    if (view !== 'gzip' || gzipCalc.status !== 'idle') return;
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > GZIP_INPUT_MAX_BYTES) {
      setGzipCalc({
        status: 'too-large',
        message: `响应体过大（${(byteLength / (1024 * 1024)).toFixed(1)} MB），不支持压缩查看`,
      });
      return;
    }
    let cancelled = false;
    gzipCompress(text)
      .then((value) => {
        if (!cancelled) setGzipCalc({ status: 'ok', value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setGzipCalc({ status: 'error', message: messageOf(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [view, gzipCalc.status, text]);

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  };
  const label = (key: string, base: string) => (copied === key ? '已复制' : base);
  const tabClass = (v: BodyView) => (view === v ? 'tab active' : 'tab');

  let actions: ReactNode = null;
  let content: ReactNode = null;

  if (view === 'raw') {
    actions = (
      <button type="button" data-testid="copy-body-raw" disabled={empty} onClick={() => copy('raw', text)}>
        {label('raw', '复制')}
      </button>
    );
    content = <pre data-testid="body-view-content">{pretty(text) || '（无）'}</pre>;
  } else if (view === 'gunzip') {
    if (!sniff.detected) {
      content = (
        <div className="muted" data-testid="body-view-content">
          未检测到 gzip 内容
        </div>
      );
    } else if (gunzipCalc.status === 'ok') {
      actions = (
        <button type="button" data-testid="copy-body-gunzip" onClick={() => copy('gunzip', gunzipCalc.value)}>
          {label('gunzip', '复制')}
        </button>
      );
      content = <pre data-testid="body-view-content">{pretty(gunzipCalc.value) || '（空）'}</pre>;
    } else if (gunzipCalc.status === 'error') {
      content = (
        <div className="text-err" data-testid="body-view-error">
          gzip 解压失败：{gunzipCalc.message}
        </div>
      );
    } else {
      content = <div className="muted">解压中…</div>;
    }
  } else if (gzipCalc.status === 'ok') {
    const r = gzipCalc.value;
    actions = (
      <>
        <button type="button" data-testid="copy-body-hex" onClick={() => copy('hex', toHexDump(r.bytes))}>
          {label('hex', '复制 hex')}
        </button>
        <button type="button" data-testid="copy-body-base64" onClick={() => copy('base64', toBase64(r.bytes))}>
          {label('base64', '复制 base64')}
        </button>
      </>
    );
    content = (
      <>
        <div className="body-gzip-stats" data-testid="body-gzip-stats">
          原始 {r.rawBytes.toLocaleString('en-US')} B → gzip {r.gzippedBytes.toLocaleString('en-US')} B（
          {(r.ratio * 100).toFixed(1)}%）
        </div>
        <pre className="body-hex" data-testid="body-view-content">{toHexDump(r.bytes, HEX_RENDER_LIMIT)}</pre>
      </>
    );
  } else if (gzipCalc.status === 'error') {
    content = (
      <div className="text-err" data-testid="body-view-error">
        gzip 压缩失败：{gzipCalc.message}
      </div>
    );
  } else if (gzipCalc.status === 'too-large') {
    content = (
      <div className="text-warn" data-testid="body-view-error">
        {gzipCalc.message}
      </div>
    );
  } else {
    content = <div className="muted">压缩中…</div>;
  }

  return (
    <div className="body-view">
      <div className="body-view-bar">
        <div className="body-tabs">
          <button type="button" className={tabClass('raw')} data-testid="body-view-raw" onClick={() => setView('raw')}>
            原始
          </button>
          <button
            type="button"
            className={tabClass('gunzip')}
            data-testid="body-view-gunzip"
            disabled={!sniff.detected || empty}
            onClick={() => setView('gunzip')}
          >
            gzip 解压
          </button>
          <button
            type="button"
            className={tabClass('gzip')}
            data-testid="body-view-gzip"
            disabled={empty}
            onClick={() => setView('gzip')}
          >
            gzip 压缩
          </button>
        </div>
        <div className="body-view-actions">{actions}</div>
      </div>
      {content}
    </div>
  );
}
