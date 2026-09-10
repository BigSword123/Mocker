import { useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatRatio } from '../lib/format-bytes';
import type { GzipFileResult } from '../../../shared/types';

/** DecompressionStream 等 API 抛的错可能 message 为空串，必须逐级回退 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || String(err);
  return String(err);
}

export default function GzipTool() {
  const [inputPath, setInputPath] = useState('');
  const [result, setResult] = useState<GzipFileResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    // gzip 输入是文件不是目录，复用现有单文件选择器
    const p = await api.openFileDialog();
    if (p) {
      setInputPath(p);
      setResult(null);
      setError('');
    }
  };

  const run = async (mode: 'compress' | 'decompress') => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(await api.gzipFile(mode, inputPath));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
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
  );
}
