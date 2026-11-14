/** Maintainer-only: build the small macOS input bridge using the installed Xcode SDK. */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = new URL('../native/ios-simulator-input/', import.meta.url);
if (process.platform !== 'darwin') throw new Error('Build the iOS simulator bridge on macOS.');
const source = fileURLToPath(new URL('phone_use.mm', root));
const binary = fileURLToPath(new URL('bin/phone-use-ios-input', root));
await mkdir(new URL('bin/', root), { recursive: true });
execFileSync(
  '/usr/bin/xcrun',
  [
    'clang++',
    '-std=c++17',
    '-fobjc-arc',
    '-fblocks',
    '-O2',
    '-mmacosx-version-min=13.0',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-framework',
    'Foundation',
    source,
    '-o',
    binary,
  ],
  { stdio: 'inherit' },
);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' });
execFileSync(binary, ['--self-test'], { stdio: 'inherit' });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  protocol: 1,
  source: sha256(await readFile(source)),
  binary: sha256(await readFile(binary)),
};
await writeFile(new URL('bin/sha256.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ...manifest, bytes: (await readFile(binary)).length }));
