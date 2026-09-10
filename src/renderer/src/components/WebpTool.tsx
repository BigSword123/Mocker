import { useState } from 'react';
import { api } from '../lib/api';
import { formatBytes, formatRatio } from '../lib/format-bytes';
import { encodeWebp } from '../lib/webp';
import { errorMessage } from './GzipTool';
import type { ScannedImage } from '../../../shared/types';

interface RowResult {
  relPath: string;
  ok: boolean;
  inputBytes: number;
  outputBytes: number;
  error?: string;
}

/** 并发上限：canvas 编解码吃内存，过高会让渲染进程峰值失控 */
const CONCURRENCY = 3;

/** 扫描上限 5000 张，每张都 setState 会把明细表重渲染 5000 次 */
const PROGRESS_FLUSH_EVERY = 20;

export default function WebpTool() {
  const [srcDir, setSrcDir] = useState('');
  const [outDir, setOutDir] = useState('');
  const [files, setFiles] = useState<ScannedImage[]>([]);
  const [quality, setQuality] = useState(80);
  const [rows, setRows] = useState<RowResult[]>([]);
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const pickSrc = async () => {
    setError('');
    try {
      const d = await api.openDirectoryDialog();
      if (!d) return;
      setSrcDir(d);
      setFiles(await api.scanImages(d));
      setRows([]);
      setDone(0);
    } catch (err) {
      setError(errorMessage(err));
      setFiles([]);
    }
  };

  const pickOut = async () => {
    const d = await api.openDirectoryDialog();
    if (d) setOutDir(d);
  };

  const convertOne = async (f: ScannedImage): Promise<RowResult> => {
    try {
      const src = await api.readImage(srcDir, f.relPath);
      // UI 用 0-100 滑块，canvas 的 quality 取值域是 0-1
      const encoded = await encodeWebp(src, quality / 100);
      await api.writeWebp(outDir, f.outName, encoded.bytes);
      return { relPath: f.relPath, ok: true, inputBytes: f.size, outputBytes: encoded.bytes.length };
    } catch (err) {
      return { relPath: f.relPath, ok: false, inputBytes: f.size, outputBytes: 0, error: errorMessage(err) };
    }
  };

  const start = async () => {
    setRunning(true);
    setError('');
    setRows([]);
    setDone(0);
    const collected: RowResult[] = [];
    let cursor = 0;
    let completed = 0;
    // 固定 CONCURRENCY 个 worker 拉同一个游标；convertOne 自己兜住异常，单张失败不中断整批
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= files.length) return;
        collected[i] = await convertOne(files[i]!);
        completed += 1;
        if (completed % PROGRESS_FLUSH_EVERY === 0) {
          setDone(completed);
          setRows(collected.filter(Boolean));
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
    } finally {
      setDone(completed);
      setRows(collected.filter(Boolean));
      setRunning(false);
    }
  };

  const okCount = rows.filter((r) => r.ok).length;
  const inTotal = rows.reduce((a, r) => a + r.inputBytes, 0);
  const outTotal = rows.reduce((a, r) => a + r.outputBytes, 0);
  const ready = srcDir !== '' && outDir !== '' && files.length > 0 && !running;

  return (
    <div className="form-grid" style={{ maxWidth: 860 }}>
      <label htmlFor="webp-src-input">源文件夹</label>
      <div className="form-row">
        <input id="webp-src-input" data-testid="webp-src" value={srcDir} readOnly placeholder="尚未选择" />
        <button data-testid="webp-pick-src" onClick={pickSrc} disabled={running}>
          选择文件夹
        </button>
      </div>

      <label>扫描结果</label>
      <div className="form-note" data-testid="webp-count">
        {srcDir === '' ? '选择文件夹后显示' : `扫描到 ${files.length} 张 png/jpg`}
      </div>

      <label htmlFor="webp-q">质量</label>
      <div className="form-row">
        <input
          id="webp-q"
          data-testid="webp-quality"
          type="range"
          min={1}
          max={100}
          value={quality}
          onChange={(e) => setQuality(Number(e.target.value))}
          disabled={running}
        />
        <span data-testid="webp-quality-value">{quality}</span>
      </div>

      <label htmlFor="webp-out-input">输出文件夹</label>
      <div className="form-row">
        <input id="webp-out-input" data-testid="webp-out" value={outDir} readOnly placeholder="尚未选择" />
        <button data-testid="webp-pick-out" onClick={pickOut} disabled={running}>
          选择文件夹
        </button>
      </div>

      <label />
      <div className="toolbar" style={{ padding: 0 }}>
        <button data-testid="webp-start" className="primary" disabled={!ready} onClick={start}>
          {running ? `转换中 ${done}/${files.length}` : '开始转换'}
        </button>
        {files.length > 0 && (
          <span className="muted" data-testid="webp-progress">
            {done}/{files.length}
          </span>
        )}
      </div>

      {error && (
        <>
          <label />
          <div className="text-err" data-testid="webp-error">
            {error}
          </div>
        </>
      )}

      {rows.length > 0 && (
        <>
          <label>汇总</label>
          <div className="form-note" data-testid="webp-summary">
            成功 {okCount} / 失败 {rows.length - okCount} · {formatBytes(inTotal)} → {formatBytes(outTotal)}（
            {formatRatio(outTotal, inTotal)}）
          </div>

          <label>明细</label>
          <div style={{ maxHeight: 320, overflowY: 'auto', width: '100%' }}>
            <table className="rules-table" data-testid="webp-rows">
              <thead>
                <tr>
                  <th>文件</th>
                  <th>原体积</th>
                  <th>WebP</th>
                  <th>占比</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.relPath}>
                    <td title={r.relPath}>{r.relPath}</td>
                    <td>{formatBytes(r.inputBytes)}</td>
                    <td>{r.ok ? formatBytes(r.outputBytes) : '—'}</td>
                    <td>{r.ok ? formatRatio(r.outputBytes, r.inputBytes) : '—'}</td>
                    <td className={r.ok ? 'text-ok' : 'text-err'}>{r.ok ? '成功' : r.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <label />
      <div className="form-note">
        源图不会被修改，输出按源目录结构镜像写入所选文件夹。已知限制：边长超过 16383px 会编码失败；
        CMYK JPEG 可能解码失败；ICC 色彩配置文件可能不保留；PNG 透明通道会保留；不处理 GIF 与动画。
        单张失败只记在明细里，不中断整批。
      </div>
    </div>
  );
}
