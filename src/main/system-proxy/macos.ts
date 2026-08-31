import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface NetworkService {
  service: string;
  device: string;
}

export function parseServiceOrder(output: string): NetworkService[] {
  const services: NetworkService[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/^\(\d+\)\s+(.+)$/);
    if (name && lines[i + 1]) {
      const hw = lines[i + 1].match(/Hardware Port: (.+?), Device: ([\w-]+)/);
      if (hw) services.push({ service: name[1].trim(), device: hw[2] });
    }
  }
  return services;
}

export function parseDefaultInterface(routeOutput: string): string | undefined {
  return routeOutput.match(/interface: (\w+)/)?.[1];
}

export async function activeService(): Promise<string | undefined> {
  const [{ stdout: routeOut }, { stdout: orderOut }] = await Promise.all([
    run('route', ['-n', 'get', 'default'], { timeout: 5000 }).catch(() => ({ stdout: '' })),
    run('networksetup', ['-listnetworkserviceorder'], { timeout: 5000 }).catch(() => ({ stdout: '' })),
  ]);
  const device = parseDefaultInterface(routeOut);
  if (!device) return undefined;
  return parseServiceOrder(orderOut).find((s) => s.device === device)?.service;
}

export async function enable(port: number): Promise<void> {
  const service = await activeService();
  if (!service) throw new Error('找不到活跃的网络服务');
  await run('networksetup', ['-setwebproxy', service, '127.0.0.1', String(port)], { timeout: 5000 });
  try {
    await run('networksetup', ['-setsecurewebproxy', service, '127.0.0.1', String(port)], { timeout: 5000 });
  } catch (err) {
    await run('networksetup', ['-setwebproxystate', service, 'off'], { timeout: 5000 }).catch(() => {});
    throw err;
  }
}

export async function disable(): Promise<void> {
  // Cleanup must not depend on the (possibly already disrupted) default route:
  // turn the proxy off on every service, ignoring per-service failures.
  const { stdout: orderOut } = await run('networksetup', ['-listnetworkserviceorder'], { timeout: 5000 });
  for (const { service } of parseServiceOrder(orderOut)) {
    try {
      await run('networksetup', ['-setwebproxystate', service, 'off'], { timeout: 5000 });
      await run('networksetup', ['-setsecurewebproxystate', service, 'off'], { timeout: 5000 });
    } catch {
      /* keep going */
    }
  }
}

export async function isEnabled(): Promise<boolean> {
  const service = await activeService();
  if (!service) return false;
  const [{ stdout: web }, { stdout: secure }] = await Promise.all([
    run('networksetup', ['-getwebproxy', service], { timeout: 5000 }),
    run('networksetup', ['-getsecurewebproxy', service], { timeout: 5000 }),
  ]);
  return /Enabled:\s*Yes/i.test(web) && /Enabled:\s*Yes/i.test(secure);
}
