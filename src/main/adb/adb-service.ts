import { execFile } from 'node:child_process';
import type { AdbDevice, AdbOpResult, AdbStatus } from '../../shared/types';

export type AdbRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export const ADB_TIMEOUT_MS = 5000;

export const ADB_INSTALL_HINT =
  process.platform === 'win32'
    ? '未检测到 adb：从 https://developer.android.com/tools/adb 下载 platform-tools 并加入 PATH 后重启应用'
    : '未检测到 adb：可执行 brew install android-platform-tools 安装后重试';

export function parseAdbDevices(stdout: string): AdbDevice[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('\t'))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state: state ?? 'unknown' };
    });
}

export function pickActiveSerial(devices: AdbDevice[]): string | undefined {
  return devices.find((d) => d.state === 'device')?.serial;
}

export function parseAdbReverseListHas(stdout: string, port: number): boolean {
  return stdout.split('\n').some((l) => l.includes(`tcp:${port}`));
}

export function parseAdbProxyValue(stdout: string): boolean {
  const v = stdout.trim();
  return v !== '' && v.toLowerCase() !== 'null';
}

const defaultRunner: AdbRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

export class AdbService {
  constructor(private readonly runner: AdbRunner = defaultRunner) {}

  private async run(serial: string | undefined, args: string[]): Promise<string> {
    return this.runner('adb', serial ? ['-s', serial, ...args] : args, ADB_TIMEOUT_MS);
  }

  async status(proxyPort: number): Promise<AdbStatus> {
    const st: AdbStatus = { adbAvailable: false, installHint: ADB_INSTALL_HINT, devices: [], tunnelActive: false, phoneProxySet: false };
    try {
      await this.runner('adb', ['version'], ADB_TIMEOUT_MS);
    } catch {
      return st;
    }
    st.adbAvailable = true;
    st.installHint = undefined;
    try {
      st.devices = parseAdbDevices(await this.run(undefined, ['devices']));
      st.activeSerial = pickActiveSerial(st.devices);
    } catch {
      return st;
    }
    try {
      st.tunnelActive = parseAdbReverseListHas(await this.run(undefined, ['reverse', '--list']), proxyPort);
    } catch { /* 尽力而为 */ }
    if (st.activeSerial) {
      try {
        st.phoneProxySet = parseAdbProxyValue(await this.run(st.activeSerial, ['shell', 'settings', 'get', 'global', 'http_proxy']));
      } catch { /* 尽力而为 */ }
    }
    return st;
  }

  private async op(label: string, argsOf: () => string[]): Promise<AdbOpResult> {
    let serial: string | undefined;
    try {
      serial = pickActiveSerial(parseAdbDevices(await this.run(undefined, ['devices'])));
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      return { ok: false, message: e?.code === 'ENOENT' ? ADB_INSTALL_HINT : `adb 执行失败：${e?.message ?? String(err)}` };
    }
    if (!serial) return { ok: false, message: '未检测到已授权设备：请连接数据线并在手机上允许 USB 调试' };
    try {
      await this.run(serial, argsOf());
      return { ok: true, message: `${label}成功（设备 ${serial}）` };
    } catch (err: unknown) {
      return { ok: false, message: `${label}失败：${String((err as Error)?.message ?? err).slice(0, 200)}` };
    }
  }

  setupTunnel(proxyPort: number): Promise<AdbOpResult> {
    return this.op('建立隧道', () => ['reverse', `tcp:${proxyPort}`, `tcp:${proxyPort}`]);
  }

  setPhoneProxy(proxyPort: number): Promise<AdbOpResult> {
    return this.op('设置手机代理', () => ['shell', 'settings', 'put', 'global', 'http_proxy', `127.0.0.1:${proxyPort}`]);
  }

  clearPhoneProxy(): Promise<AdbOpResult> {
    return this.op('恢复手机网络', () => ['shell', 'settings', 'put', 'global', 'http_proxy', ':0']);
  }
}
