import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCa } from '../src/main/certs/ca';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mocker-ca-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ensureCa', () => {
  it('generates a self-signed CA on first run', async () => {
    const ca = await ensureCa(dir);
    const cert = forge.pki.certificateFromPem(ca.certPem);
    expect(cert.subject.getField('CN').value).toBe('Mocker Root CA');
    expect(cert.isIssuer(cert)).toBe(true);
    const tenYearsMs = 9 * 365 * 24 * 3600 * 1000;
    expect(cert.validity.notAfter.getTime() - Date.now()).toBeGreaterThan(tenYearsMs);
    expect(forge.pki.privateKeyFromPem(ca.keyPem)).toBeTruthy();
  });

  it('reuses existing CA on second run', async () => {
    const first = await ensureCa(dir);
    const second = await ensureCa(dir);
    expect(second.certPem).toBe(first.certPem);
  });

  it('regenerates when expiring within one year', async () => {
    await ensureCa(dir);
    const future = new Date(Date.now() + 9.5 * 365 * 24 * 3600 * 1000);
    const renewed = await ensureCa(dir, future);
    expect(renewed.notAfter.getTime()).toBeGreaterThan(future.getTime() + 9 * 365 * 24 * 3600 * 1000);
  });

  it('regenerates when cert file is corrupt', async () => {
    await mkdir(join(dir, 'certs'), { recursive: true });
    await writeFile(join(dir, 'certs', 'ca.pem'), 'garbage');
    await writeFile(join(dir, 'certs', 'ca.key'), 'garbage');
    const ca = await ensureCa(dir);
    expect(() => forge.pki.certificateFromPem(ca.certPem)).not.toThrow();
  });

  it('writes key file with 0o600 permissions', async () => {
    await ensureCa(dir);
    const st = await stat(join(dir, 'certs', 'ca.key'));
    expect(st.mode & 0o777).toBe(0o600);
    // 续期路径会重新写文件，权限仍需保持 0o600
    const future = new Date(Date.now() + 9.5 * 365 * 24 * 3600 * 1000);
    await ensureCa(dir, future);
    const st2 = await stat(join(dir, 'certs', 'ca.key'));
    expect(st2.mode & 0o777).toBe(0o600);
  });
});
