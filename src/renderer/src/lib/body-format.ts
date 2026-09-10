const DISPLAY_LIMIT = 500_000;

/** 仅用于显示：会截断，复制路径不要走这里。 */
export function pretty(body: string | undefined): string {
  if (!body) return '';
  if (body.length > DISPLAY_LIMIT) {
    return body.slice(0, DISPLAY_LIMIT) + '\n…（内容过长已截断）';
  }
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}
