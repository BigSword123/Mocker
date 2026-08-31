import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface NetworkService {
  service: string;
  device: string;
}

export function parseServiceOrder(output: string): NetworkService[] {
  const services: NetworkService[] = [];
  const lines = output.split('\n');
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
    run('route', ['-n', 'get', 'default']).catch(() => ({ stdout: '' })),
    run('networksetup', ['-listnetworkserviceorder']),
  ]);
  const device = parseDefaultInterface(routeOut);
  if (!device) return undefined;
  return parseServiceOrder(orderOut).find((s) => s.device === device)?.service;
}

export async function enable(port: number): Promise<void> {
  const service = await activeService();
  if (!service) throw new Error('找不到活跃的网络服务');
  await run('networksetup', ['-setwebproxy', service, '127.0.0.1', String(port)]);
  await run('networksetup', ['-setsecurewebproxy', service, '127.0.0.1', String(port)]);
}

export async function disable(): Promise<void> {
  const service = await activeService();
  if (!service) return;
  await run('networksetup', ['-setwebproxystate', service, 'off']);
  await run('networksetup', ['-setsecurewebproxystate', service, 'off']);
}

export async function isEnabled(): Promise<boolean> {
  const service = await activeService();
  if (!service) return false;
  const { stdout } = await run('networksetup', ['-getwebproxy', service]);
  return /Enabled:\s*Yes/i.test(stdout);
}
