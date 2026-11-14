#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { companionFiles } from './companion-files.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const name = `phone-use-${manifest.version}`;
const temporary = await mkdtemp(join(tmpdir(), 'phone-use-release-'));
const folder = join(temporary, name),
  destination = join(source, 'releases');
try {
  await mkdir(folder);
  // Explicit allowlist: no screenshots, local configuration, device data or repository credentials.
  for (const path of [
    ...companionFiles,
    'dist/src',
    'protocols',
    'native',
    'assets/ocr',
    'ui',
    'skills',
    'docs',
    'scripts',
    '.codex-plugin',
    'plugin.json',
    'mcp.json',
    '.mcp.json',
    'package.json',
    'package-lock.json',
    'phone-use.example.json',
    'README.md',
    'LICENSE',
  ]) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await cp(join(source, path), join(folder, path), { recursive: true });
  }
  await mkdir(destination, { recursive: true });
  const archive = join(destination, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', temporary, name], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${name}.tar.gz\n`);
  console.log(
    JSON.stringify(
      {
        archive,
        bytes: bytes.length,
        sha256,
        install:
          'Extract, then run node scripts/install-work.mjs. Node.js 22+ and network for production dependencies are required.',
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
