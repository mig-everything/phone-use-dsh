#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
assert(npm, 'Run npm run package:core so the current npm executable is available.');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const destination = join(root, 'releases');
await mkdir(destination, { recursive: true });
const [packed] = JSON.parse(
  execFileSync(
    process.execPath,
    [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  ),
);
assert.equal(packed.name, 'phone-use');
assert.equal(packed.version, manifest.version);
assert.equal(packed.filename, `phone-use-${manifest.version}.tgz`);
const files = new Set(packed.files.map((file) => file.path));
for (const entry of Object.values(manifest.exports)) {
  for (const path of Object.values(entry))
    assert(files.has(path.replace(/^\.\//, '')), `Missing SDK export: ${path}`);
}
for (const path of [
  manifest.bin['phone-use'],
  'scripts/start.mjs',
  'ui/screen.html',
  'assets/ocr/models.json',
  'assets/ocr/LICENSE',
  'native/android-server/LICENSE',
  'native/harmony-bridge/LICENSE.HMBot',
  'native/harmony-bridge/LICENSE.OpenHarmony',
  'native/ios-simulator-input/LICENSE.Meta',
])
  assert(files.has(path), `Missing runtime file: ${path}`);
const archive = join(destination, packed.filename);
const bytes = await readFile(archive);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${archive}.sha256`, `${sha256}  ${packed.filename}\n`);
console.log(
  JSON.stringify({
    archive,
    version: manifest.version,
    files: files.size,
    bytes: bytes.length,
    sha256,
  }),
);
