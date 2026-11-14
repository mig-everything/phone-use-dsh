#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Preparing a leaf certificate does not change OS/browser trust. Trust is an
// explicit, separate step, restricted to SSL for 127.0.0.1 in the user keychain.
const { values } = parseArgs({
  options: {
    directory: { type: 'string' },
    config: { type: 'string' },
    'trust-macos': { type: 'boolean', default: false },
  },
});
const directory = resolve(
  values.directory ?? join(homedir(), '.local/state/phone-use/preview-tls'),
);
const certificate = join(directory, 'localhost.pem'),
  key = join(directory, 'localhost-key.pem');
await mkdir(directory, { recursive: true, mode: 0o700 });
let cert;
try {
  cert = await readFile(certificate);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const temporary = await mkdtemp(join(tmpdir(), 'phone-use-tls-'));
  try {
    await chmod(temporary, 0o700);
    await writeFile(
      join(temporary, 'openssl.cnf'),
      `[req]
prompt = no
distinguished_name = dn
x509_extensions = extensions
[dn]
CN = Phone Use local preview
[extensions]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
`,
      { mode: 0o600 },
    );
    execFileSync(
      process.env.PHONE_USE_OPENSSL ?? 'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-days',
        '365',
        '-config',
        join(temporary, 'openssl.cnf'),
        '-keyout',
        join(temporary, 'key.pem'),
        '-out',
        join(temporary, 'cert.pem'),
      ],
      { stdio: 'pipe', timeout: 10000 },
    );
    cert = await readFile(join(temporary, 'cert.pem'));
    await writeFile(key, await readFile(join(temporary, 'key.pem')), { mode: 0o600, flag: 'wx' });
    await writeFile(certificate, cert, { mode: 0o600, flag: 'wx' });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
const x509 = new X509Certificate(cert);
if (
  x509.ca ||
  !x509.checkIP('127.0.0.1') ||
  !x509.checkPrivateKey(createPrivateKey(await readFile(key))) ||
  Date.parse(x509.validFrom) > Date.now() ||
  Date.parse(x509.validTo) < Date.now()
)
  throw new Error(
    'Existing preview certificate is invalid. Inspect it before replacing its files.',
  );
await chmod(key, 0o600);
if (values.config) {
  const file = resolve(values.config),
    config = JSON.parse(await readFile(file, 'utf8'));
  config.preview = { ...config.preview, tls: { certificate, key } };
  const temporary = `${file}.preview-tls.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
const trustArguments = [
  'add-trusted-cert',
  '-r',
  'trustRoot',
  '-p',
  'ssl',
  '-s',
  '127.0.0.1',
  '-k',
  join(homedir(), 'Library/Keychains/login.keychain-db'),
  certificate,
];
if (values['trust-macos']) {
  if (process.platform !== 'darwin') throw new Error('--trust-macos is only available on macOS.');
  execFileSync('/usr/bin/security', trustArguments, { stdio: 'inherit' });
}
console.log(
  JSON.stringify(
    {
      certificate,
      key,
      sha256: x509.fingerprint256,
      expires: x509.validTo,
      ca: x509.ca,
      trustInstalled: values['trust-macos'],
      configuration: { preview: { tls: { certificate, key } } },
      macosTrustCommand: ['/usr/bin/security', ...trustArguments],
      macosRemoveCommand: [
        '/usr/bin/security',
        'delete-certificate',
        '-Z',
        x509.fingerprint256.replaceAll(':', ''),
        join(homedir(), 'Library/Keychains/login.keychain-db'),
      ],
    },
    null,
    2,
  ),
);
