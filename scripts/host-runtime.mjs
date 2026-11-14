import { access } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, win32 } from 'node:path';
import { homedir } from 'node:os';

export function launcher(
  env,
  platform = process.platform,
  executable = process.execPath,
  path = process.env.PATH ?? '',
) {
  return platform === 'win32'
    ? { command: 'node.exe', env: { ...env, PATH: `${win32.dirname(executable)};${path}` } }
    : { command: './scripts/launch-node.sh', env: { ...env, PHONE_USE_NODE: executable } };
}

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
export async function installDependencies(cwd, locked) {
  const args = [
    locked ? 'ci' : 'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];
  if (process.platform !== 'win32') return execFileSync('npm', args, { cwd, stdio: 'inherit' });
  // npm.cmd cannot be execFile'd on Windows; invoke its JS entry directly, without a shell.
  const paths =
    spawnSync('where.exe', ['npm'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/) ?? [];
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...paths.map((path) => join(dirname(path), 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ].filter((path) => path?.endsWith('npm-cli.js'));
  for (const path of candidates)
    if (await exists(path))
      return execFileSync(process.execPath, [path, ...args], { cwd, stdio: 'inherit' });
  throw new Error(
    'Cannot locate npm-cli.js. Install Node.js 22+ with npm, then rerun this installer.',
  );
}

/** Preserve explicit configuration, then discover installed SDKs without downloading SDKs. */
export async function discoverDriver(binary, override) {
  if (override && (await exists(override))) return override;
  const result = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [override ?? binary],
    { encoding: 'utf8' },
  );
  if (result.status === 0) return result.stdout.trim().split(/\r?\n/)[0];
  if (override) return override;
  const executable = process.platform === 'win32' ? `${binary}.exe` : binary;
  const roots =
    binary === 'adb'
      ? [
          process.env.ANDROID_HOME,
          process.env.ANDROID_SDK_ROOT,
          join(homedir(), 'Library', 'Android', 'sdk'),
          join(homedir(), 'Android', 'Sdk'),
          process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
        ]
      : [];
  const candidates = roots.filter(Boolean).map((root) => join(root, 'platform-tools', executable));
  if (binary === 'hdc')
    candidates.push(
      '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc',
    );
  for (const path of candidates) if (await exists(path)) return path;
}

/** npm's Windows codex.cmd shim needs a shell; use its JS entry or a native exe instead. */
export async function codexLauncher(explicit) {
  if (process.platform !== 'win32') return { command: explicit ?? 'codex', args: [] };
  const paths = explicit
    ? [explicit]
    : (spawnSync('where.exe', ['codex'], { encoding: 'utf8' })
        .stdout?.trim()
        .split(/\r?\n/)
        .filter(Boolean) ?? []);
  const native = paths.find((path) => /\.exe$/i.test(path));
  if (native) return { command: native, args: [] };
  for (const path of paths) {
    const entry = join(dirname(path), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (await exists(entry)) return { command: process.execPath, args: [entry] };
  }
  throw new Error(
    'Cannot locate a native Codex CLI or its npm entry. Install Codex CLI, or configure the displayed MCP command in your client.',
  );
}
