import { useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatRatio } from '../lib/format-bytes';
import { gzipCompress, gzipDecodeBytes, gunzipText, toBase64 } from '../lib/body-codec';
import type { GzipFileResult } from '../../../shared/types';

/** DecompressionStream 等 API 抛的错可能 message 为空串，必须逐级回退 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || String(err);
  return String(err);
}

export default function GzipTool() {
  const [mode, setMode] = useState<'file' | 'text'>('file');

  const [inputPath, setInputPath] = useState('');
  const [result, setResult] = useState<GzipFileResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [textInput, setTextInput] = useState('');
  const [textOutput, setTextOutput] = useState('');
  const [textError, setTextError] = useState('');
  const [textBusy, setTextBusy] = useState(false);

  const pick = async () => {
    // gzip 输入是文件不是目录，复用现有单文件选择器
    const p = await api.openFileDialog();
    if (p) {
      setInputPath(p);
      setResult(null);
      setError('');
    }
  };

  const run = async (action: 'compress' | 'decompress') => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api.gzipFile(action, inputPath));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const runText = async (action: 'compress' | 'decompress') => {
    setTextBusy(true);
    setTextError('');
    setTextOutput('');
    try {
      if (action === 'compress') {
        // gzipCompress 只返回原始 bytes，base64 由调用方组合
        setTextOutput(toBase64((await gzipCompress(textInput)).bytes));
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = gzipDecodeBytes(textInput, 'base64');
      } catch {
        throw new Error('不是合法的 base64');
      }
      // DecompressionStream 失败时 message 是空串、name 是 TypeError，对用户毫无信息量，
      // 所以先查魔数给出可操作的文案，与文件模式保持一致
      if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        throw new Error('base64 解开了，但不是 gzip 数据（缺少 1f 8b 魔数）');
      }
      setTextOutput(await gunzipText(bytes));
    } catch (err) {
      setTextError(errorMessage(err));
    } finally {
      setTextBusy(false);
    }
  };

  return (
    <>
      <div className="tab-row">
        <button
          data-testid="gzip-mode-file"
          className={mode === 'file' ? 'active' : ''}
          onClick={() => setMode('file')}
        >
          文件模式
        </button>
        <button
          data-testid="gzip-mode-text"
          className={mode === 'text' ? 'active' : ''}
          onClick={() => setMode('text')}
        >
          文本模式
        </button>
      </div>

      {mode === 'file' && (
        <div className="form-grid" style={{ maxWidth: 720 }}>
          <label htmlFor="gzip-input">输入文件</label>
          <div className="form-row">
            <input
              id="gzip-input"
              data-testid="gzip-path"
              value={inputPath}
              readOnly
              placeholder="尚未选择文件"
            />
            <button data-testid="gzip-pick" onClick={pick} disabled={busy}>
              选择文件
            </button>
          </div>

          <label>操作</label>
          <div className="toolbar" style={{ padding: 0 }}>
            <button
              data-testid="gzip-compress"
              className="primary"
              disabled={inputPath === '' || busy}
              onClick={() => run('compress')}
            >
              压缩为 .gz
            </button>
            <button
              data-testid="gzip-decompress"
              disabled={inputPath === '' || busy}
              onClick={() => run('decompress')}
            >
              解压 .gz
            </button>
          </div>

          <label>结果</label>
          <div>
            {busy && <span className="muted">处理中…</span>}
            {error && (
              <span className="text-err" data-testid="gzip-error">
                {error}
              </span>
            )}
            {result && !error && !busy && (
              <div className="form-note" data-testid="gzip-result">
                {result.saved ? (
                  <>
                    已写入 <code>{result.filePath}</code>
                    <br />
                    {formatBytes(result.inputBytes)} → {formatBytes(result.outputBytes)}（
                    {formatRatio(result.outputBytes, result.inputBytes)}）
                  </>
                ) : (
                  <span className="muted">
                    已取消保存。原体积 {formatBytes(result.inputBytes)}，结果体积{' '}
                    {formatBytes(result.outputBytes)}
                  </span>
                )}
              </div>
            )}
          </div>

          <label />
          <div className="form-note">
            解压上限 256 MB，超限会中止并报「疑似解压炸弹」。文件在主进程用异步 zlib
            处理，不阻塞抓包。
          </div>
        </div>
      )}

      {mode === 'text' && (
        <div className="form-grid" style={{ maxWidth: 720 }}>
          <label htmlFor="gzip-text-in">输入</label>
          <textarea
            id="gzip-text-in"
            data-testid="gzip-text-input"
            rows={6}
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="压缩：填原始文本；解压：填 gzip 的 base64"
          />

          <label>操作</label>
          <div className="toolbar" style={{ padding: 0 }}>
            <button
              data-testid="gzip-text-compress"
              className="primary"
              disabled={textInput === '' || textBusy}
              onClick={() => runText('compress')}
            >
              压缩 → base64
            </button>
            <button
              data-testid="gzip-text-decompress"
              disabled={textInput === '' || textBusy}
              onClick={() => runText('decompress')}
            >
              解压 base64 → 文本
            </button>
          </div>

          <label htmlFor="gzip-text-out">结果</label>
          <textarea
            id="gzip-text-out"
            data-testid="gzip-text-output"
            rows={6}
            value={textOutput}
            readOnly
          />

          {textError && (
            <>
              <label />
              <div className="text-err" data-testid="gzip-text-error">
                {textError}
              </div>
            </>
          )}

          <label />
          <div className="form-note">
            纯渲染进程计算（Chromium 的 CompressionStream），不经过 IPC，也不落盘。
            二进制用 base64 表示，与 HAR 对二进制 body 的处理一致。
          </div>
        </div>
      )}
    </>
  );
}
