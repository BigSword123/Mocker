import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import forge from 'node-forge';

export interface CaMaterial {
  keyPem: string;
  certPem: string;
  notAfter: Date;
}

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;
const RENEW_WINDOW_MS = 365 * 24 * 3600 * 1000;

export async function ensureCa(dataDir: string, now: Date = new Date()): Promise<CaMaterial> {
  const certPath = path.join(dataDir, 'certs', 'ca.pem');
  const keyPath = path.join(dataDir, 'certs', 'ca.key');
  try {
    const [certPem, keyPem] = await Promise.all([
      fs.readFile(certPath, 'utf8'),
      fs.readFile(keyPath, 'utf8'),
    ]);
    const cert = forge.pki.certificateFromPem(certPem);
    if (cert.validity.notAfter.getTime() - now.getTime() > RENEW_WINDOW_MS) {
      return { keyPem, certPem, notAfter: cert.validity.notAfter };
    }
  } catch {
    // 缺失或损坏：重新生成
  }
  const generated = generateCa(now);
  await fs.mkdir(path.dirname(certPath), { recursive: true });
  await Promise.all([
    fs.writeFile(certPath, generated.certPem, 'utf8'),
    fs.writeFile(keyPath, generated.keyPem, { encoding: 'utf8', mode: 0o600 }),
  ]);
  return generated;
}

export function generateCa(now: Date): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(now.getTime() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(now.getTime() + TEN_YEARS_MS);
  const attrs = [{ name: 'commonName', value: 'Mocker Root CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
    notAfter: cert.validity.notAfter,
  };
}
