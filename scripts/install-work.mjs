#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { companionFiles } from './companion-files.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { discoverDriver, installDependencies, launcher } from './host-runtime.mjs';
if (Number(process.versions.node.split('.')[0]) < 22)
  throw new Error('Phone Use requires Node.js 22 or later, with npm.');

const { values } = parseArgs({ options: { config: { type: 'string' } } });

const source = fileURLToPath(new URL('../', import.meta.url));
const parent = join(homedir(), '.codex', 'plugins');
const destination = join(parent, 'phone-use-local');
const catalogPath = join(homedir(), '.agents', 'plugins', 'marketplace.json');
const sourcePath = `./${relative(homedir(), destination).replaceAll('\\', '/')}`;
const readOptional = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
};
const original = await readOptional(catalogPath);
const catalog = original
  ? JSON.parse(original)
  : {
      name: 'phone-use-local',
      interface: { displayName: 'Phone Use Local' },
      plugins: [],
    };
if (!Array.isArray(catalog.plugins) || typeof catalog.name !== 'string') {
  throw new Error('The existing personal marketplace has an unsupported format.');
}
const existing = catalog.plugins.find((plugin) => plugin.name === 'phone-use');
if (existing && (existing.source?.path ?? existing.source) !== sourcePath) {
  throw new Error('The personal marketplace already contains a different phone-use plugin.');
}
const previousManifest = await readOptional(join(destination, 'plugin.json'));
if (previousManifest && !(await readOptional(join(destination, '.phone-use-managed')))) {
  throw new Error(`Refusing to replace an unmanaged plugin at ${destination}`);
}
const previousConfig = await readOptional(join(destination, 'mcp.json'));
const previousEnv = previousConfig
  ? (JSON.parse(previousConfig).mcpServers?.phone_use?.env ?? {})
  : {};
const configuration = values.config ?? process.env.PHONE_USE_CONFIG ?? previousEnv.PHONE_USE_CONFIG;
const configPath = configuration ? resolve(configuration) : undefined;
if (configPath && !(await readOptional(configPath)))
  throw new Error(`Cannot read device configuration: ${configPath}`);
const deviceConfig = configPath ? JSON.parse(await readOptional(configPath)) : {};
const configuredBinaries = {
  hdc: deviceConfig.harmony?.binary,
  adb: deviceConfig.android?.binary,
  scrcpy: deviceConfig.android?.video?.scrcpy,
};
const configuredFfmpeg =
  deviceConfig.harmony?.video?.ffmpeg ||
  deviceConfig.android?.video?.ffmpeg ||
  deviceConfig.android?.emulator?.ffmpeg;

await mkdir(parent, { recursive: true });
const stage = await mkdtemp(join(parent, 'phone-use-stage-'));
try {
  // Include production dependencies inside the plugin so the desktop cache is self-contained.
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
    'LICENSE',
    'README.md',
    'phone-use.example.json',
  ]) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(source, path), join(stage, path), { recursive: true });
  }
  const lock = await readOptional(join(source, 'package-lock.json'));
  if (lock) await writeFile(join(stage, 'package-lock.json'), lock);
  await installDependencies(stage, !!lock);
  const driverEnv = {
    ...(configPath ? { PHONE_USE_CONFIG: configPath } : {}),
    ...(previousEnv.PHONE_USE_STATE_DIR
      ? { PHONE_USE_STATE_DIR: previousEnv.PHONE_USE_STATE_DIR }
      : {}),
  };
  for (const [binary, variable] of [
    ['hdc', 'PHONE_USE_HDC'],
    ['adb', 'PHONE_USE_ADB'],
    ['scrcpy', 'PHONE_USE_SCRCPY'],
    ['ffmpeg', 'PHONE_USE_FFMPEG'],
  ]) {
    if (binary === 'ffmpeg' && configuredFfmpeg && !process.env[variable]) continue;
    const override = process.env[variable] ?? configuredBinaries[binary];
    const found = await discoverDriver(binary, override ?? previousEnv[variable]);
    if (found) driverEnv[variable] = found;
  }
  for (const filename of ['mcp.json', '.mcp.json']) {
    const config = JSON.parse(await readFile(join(stage, filename), 'utf8'));
    Object.assign(config.mcpServers.phone_use, launcher(driverEnv));
    await writeFile(join(stage, filename), `${JSON.stringify(config, null, 2)}\n`);
  }
  execFileSync(
    process.execPath,
    [
      join(stage, 'scripts/smoke-device.mjs'),
      '--manifest',
      join(stage, 'mcp.json'),
      '--demo',
      '--device',
      'demo:foldable',
    ],
    {
      cwd: stage,
      stdio: 'pipe',
    },
  );
  await writeFile(join(stage, '.phone-use-managed'), 'Managed by scripts/install-work.mjs\n');
  if ((await readOptional(catalogPath)) !== original)
    throw new Error('Marketplace changed during installation; rerun.');
  if (previousManifest) await rename(destination, `${destination}.backup-${Date.now()}`);
  await rename(stage, destination);
  const entry = {
    name: 'phone-use',
    source: { source: 'local', path: sourcePath },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  if (existing) catalog.plugins[catalog.plugins.indexOf(existing)] = entry;
  else catalog.plugins.push(entry);
  await mkdir(join(homedir(), '.agents', 'plugins'), { recursive: true });
  const temporary = `${catalogPath}.phone-use-${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, catalogPath);
  console.log(`Prepared ${destination}`);
  console.log(`Marketplace: ${catalog.interface?.displayName ?? catalog.name}`);
  console.log(`Install with: codex plugin add phone-use@${catalog.name}`);
  if (configPath) console.log(`Device configuration: ${configPath}`);
  console.log('After installation, validate the host loader with: node scripts/check-work.mjs');
  console.log(
    'Reconnect the local Work chat and select Phone Use to load updated tools. Restart the desktop app only if it still uses the old plugin.',
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
