import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCertInstallCommands } from '../src/main/certs/install-commands';

const DATA = '/some/data dir';

describe('buildCertInstallCommands', () => {
  it('darwin: macos command embeds the real cert path', () => {
    const r = buildCertInstallCommands(DATA, 'darwin');
    expect(r.platform).toBe('macos');
    const realPath = path.join(DATA, 'certs', 'ca.pem');
    expect(r.macos).toBe(
      `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${realPath}"`,
    );
    expect(r.windows).toContain('%APPDATA%\\mocker\\certs\\ca.pem');
  });

  it('win32: windows command embeds the real cert path', () => {
    const r = buildCertInstallCommands(DATA, 'win32');
    expect(r.platform).toBe('windows');
    const realPath = path.join(DATA, 'certs', 'ca.pem');
    expect(r.windows).toBe(`certutil -addstore -f ROOT "${realPath}"`);
    expect(r.macos).toContain('$HOME/Library/Application Support/mocker/certs/ca.pem');
  });

  it('other platforms: both commands use conventional paths', () => {
    const r = buildCertInstallCommands(DATA, 'linux');
    expect(r.platform).toBe('other');
    expect(r.macos).toContain('$HOME/Library/Application Support/mocker/certs/ca.pem');
    expect(r.windows).toContain('%APPDATA%\\mocker\\certs\\ca.pem');
  });
});
