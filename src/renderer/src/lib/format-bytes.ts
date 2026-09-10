export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** out/in 占比；in 为 0 时无意义，返回占位而非 NaN */
export function formatRatio(out: number, input: number): string {
  if (!Number.isFinite(input) || input <= 0) return '—';
  return `${((out / input) * 100).toFixed(1)}%`;
}
