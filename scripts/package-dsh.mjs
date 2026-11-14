#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkDshPackage } from './check-dsh-package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'phone-use-dsh-'));
try {
  const core = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const bundle = JSON.parse(await readFile(join(root, 'packages/dsh/package.json'), 'utf8'));
  if (bundle.version !== core.version)
    throw new Error('DSH bundle and shared core versions must match before packaging.');
  const target = join(temporary, 'package');
  await mkdir(target);
  for (const name of ['package.json', 'cordis.patch.yml', 'locale', 'assets', 'screenshots.json'])
    await cp(join(root, 'packages/dsh', name), join(target, name), { recursive: true });
  // The bundle embeds the built shared package; source is never forked per host.
  for (const name of [
    'dist/src',
    'ui',
    'native',
    'assets/ocr',
    'protocols',
    'skills',
    'docs',
    'package.json',
    'phone-use.example.json',
    'LICENSE',
  ]) {
    const destination = join(target, 'core', name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(root, name), destination, { recursive: true });
  }
  await cp(join(root, 'ui/dsh-client.js'), join(target, 'client.js'));
  await cp(join(root, 'LICENSE'), join(target, 'LICENSE'));
  await cp(join(root, 'docs/dsh.md'), join(target, 'README.md'));
  bundle.dependencies = core.dependencies;
  await writeFile(join(target, 'package.json'), JSON.stringify(bundle, null, 2) + '\n');
  const checked = await checkDshPackage(target);
  const releases = join(root, 'releases');
  await mkdir(releases, { recursive: true });
  const name = `mig-everything-phone-use-dsh-${bundle.version}.tgz`,
    archive = join(releases, name);
  execFileSync('tar', ['-czf', archive, '-C', temporary, 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await readFile(archive),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${name}\n`);
  const stable = join(releases, 'phone-use-dsh.tgz');
  await cp(archive, stable);
  await writeFile(`${stable}.sha256`, `${sha256}  phone-use-dsh.tgz\n`);
  console.log(JSON.stringify({ archive, stable, bytes: bytes.length, sha256, ...checked }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
