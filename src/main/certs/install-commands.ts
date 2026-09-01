import * as path from 'node:path';
import type { CertInstallCommands } from '../../shared/types';

const MAC_CONVENTIONAL = '$HOME/Library/Application Support/mocker/certs/ca.pem';
const WIN_CONVENTIONAL = '%APPDATA%\\mocker\\certs\\ca.pem';

export function buildCertInstallCommands(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): CertInstallCommands {
  const realPath = path.join(dataDir, 'certs', 'ca.pem');
  const macPath = platform === 'darwin' ? realPath : MAC_CONVENTIONAL;
  const winPath = platform === 'win32' ? realPath : WIN_CONVENTIONAL;
  return {
    platform: platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'other',
    macos: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${macPath}"`,
    windows: `certutil -addstore -f ROOT "${winPath}"`,
  };
}
