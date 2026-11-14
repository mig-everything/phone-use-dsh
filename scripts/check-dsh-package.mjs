#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import semver from 'semver';

export async function checkDshPackage(folder) {
  const read = (path) => readFile(join(folder, path), 'utf8');
  const manifest = JSON.parse(await read('package.json'));
  const core = JSON.parse(await read('core/package.json'));
  assert.equal(manifest.name, '@mig-everything/phone-use-dsh');
  assert.equal(manifest.version, core.version);
  assert.equal(manifest.repository.url, 'git+https://github.com/mig-everything/phone-use-dsh.git');
  assert.equal(manifest.repository.directory, 'packages/dsh');
  assert.equal(manifest.private, true, 'GitHub-only release must not accidentally publish to npm');
  assert.deepEqual(manifest.dependencies, core.dependencies);
  assert(semver.satisfies('0.2.2-rc.1', manifest.engines.dsh), 'Tested DSH runtime is excluded');
  assert(
    semver.satisfies('0.2.1-rc.2', manifest.engines.dsh),
    'Declared older runtime is excluded',
  );
  assert(!semver.satisfies('0.3.0', manifest.engines.dsh), 'Untested next minor is included');
  for (const path of [
    manifest.main,
    manifest.exports['./client'],
    manifest.dsh.bundle.patch,
    manifest.icon,
    'LICENSE',
    'core/ui/screen.html',
    'core/skills/phone-use/SKILL.md',
    'core/assets/ocr/models.json',
    'core/assets/ocr/LICENSE',
    'core/native/android-server/LICENSE',
    'core/native/harmony-bridge/LICENSE.HMBot',
    'core/native/harmony-bridge/LICENSE.OpenHarmony',
    'core/native/ios-simulator-input/LICENSE.Meta',
  ]) {
    assert.equal(typeof path, 'string');
    const inside = relative(folder, resolve(folder, path));
    assert(inside && !inside.startsWith('..'), 'Entry escapes package');
    assert((await lstat(join(folder, path))).isFile(), `Missing packaged file: ${path}`);
  }
  assert((await read(manifest.dsh.bundle.patch)).includes(manifest.name));
  const screenshots = JSON.parse(await read('screenshots.json'));
  assert(Array.isArray(screenshots) && screenshots.length >= 1 && screenshots.length <= 8);
  for (const path of screenshots) {
    assert(typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..'));
    assert((await lstat(join(folder, path))).isFile(), `Missing storefront image: ${path}`);
  }
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = relative(folder, path).replaceAll('\\', '/');
      assert(!entry.isSymbolicLink(), `Unexpected symlink: ${name}`);
      assert(
        !/(^|\/)(?:\.git|\.phone-use|node_modules|\.env(?:\..*)?|\.npmrc|phone-use\.local\.json)(?:\/|$)/.test(
          name,
        ) &&
          !/\.(?:pem|p12|pfx|key)$/.test(name) &&
          !/(^|\/)\._/.test(name),
        `Local or credential file in package: ${name}`,
      );
      if (entry.isDirectory()) await walk(path);
      else {
        files.push(name);
        if (/\.(?:json|js|mjs|cjs|map|html|md|yml|ts|cpp|h|mm)$/.test(name)) {
          const text = await readFile(path, 'utf8');
          assert(!/\/Users\/[^/\s]+\//.test(text), `Local user path in ${name}`);
          assert(
            !/https:\/\/github\.com\/mig-everything\/phone-use(?:[/.#\s)]|$)/.test(text),
            `Private repository link in ${name}`,
          );
          assert(
            !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text),
            `Private key in ${name}`,
          );
          assert(
            !/(?:gh[pousr]_[A-Za-z0-9_]{25,}|npm_[A-Za-z0-9]{20,})/.test(text),
            `Credential in ${name}`,
          );
        }
      }
    }
  }
  await walk(folder);
  return { version: manifest.version, files: files.length, screenshots: screenshots.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/check-dsh-package.mjs <archive.tgz>');
  const archive = resolve(process.argv[2]);
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-package-check-'));
  try {
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert(members.every((p) => /^package\//.test(p) && !p.split('/').includes('..')));
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
    const result = await checkDshPackage(join(dir, 'package'));
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    console.log(JSON.stringify({ ...result, sha256 }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
