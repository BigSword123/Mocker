import * as macos from './macos';
import * as windows from './windows';

function impl() {
  if (process.platform === 'darwin') return macos;
  if (process.platform === 'win32') return windows;
  throw new Error(`不支持的平台: ${process.platform}`);
}

export async function enableSystemProxy(port: number): Promise<void> {
  await impl().enable(port);
}

export async function disableSystemProxy(): Promise<void> {
  await impl().disable();
}

export async function systemProxyEnabled(): Promise<boolean> {
  try {
    return await impl().isEnabled();
  } catch {
    return false;
  }
}
