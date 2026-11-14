import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';

export async function previewCertificate(directory: string) {
  await promisify(execFile)(process.execPath, [
    resolve('scripts/setup-preview-tls.mjs'),
    '--directory',
    join(directory, 'tls'),
  ]);
  const certificate = join(directory, 'tls/localhost.pem'),
    key = join(directory, 'tls/localhost-key.pem');
  const ca = await readFile(certificate);
  const x509 = new X509Certificate(ca);
  const spki = createHash('sha256')
    .update(x509.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  return { certificate, key, ca, spki };
}
