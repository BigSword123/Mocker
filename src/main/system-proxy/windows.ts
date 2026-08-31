import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export async function enable(port: number): Promise<void> {
  await run('reg', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await run('reg', ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `127.0.0.1:${port}`, '/f']);
}

export async function disable(): Promise<void> {
  await run('reg', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
}

export async function isEnabled(): Promise<boolean> {
  try {
    const { stdout } = await run('reg', ['query', KEY, '/v', 'ProxyEnable']);
    return /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout);
  } catch {
    return false;
  }
}
