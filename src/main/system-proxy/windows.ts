import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export async function enable(port: number): Promise<void> {
  // Write ProxyServer before enabling, so a partial failure never leaves the proxy on with a stale server.
  await run('reg', ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `127.0.0.1:${port}`, '/f'], { timeout: 5000 });
  await run('reg', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'], { timeout: 5000 });
}

export async function disable(): Promise<void> {
  await run('reg', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'], { timeout: 5000 });
}

export async function isEnabled(): Promise<boolean> {
  try {
    const { stdout } = await run('reg', ['query', KEY, '/v', 'ProxyEnable'], { timeout: 5000 });
    return /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout);
  } catch {
    return false;
  }
}
