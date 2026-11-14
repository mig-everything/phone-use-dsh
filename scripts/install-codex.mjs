#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { codexLauncher } from './host-runtime.mjs';
await access(new URL('../dist/src/cli.js', import.meta.url));
const entry = fileURLToPath(new URL('./start.mjs', import.meta.url));
if (!process.argv.includes('--apply')) {
  console.log('Register the local MCP server with:');
  console.log(`codex mcp add phone_use -- node '${entry.replaceAll("'", "'\\''")}'`);
  console.log('Run this script with --apply to execute the registration.');
} else {
  const cli = await codexLauncher();
  const result = spawnSync(
    cli.command,
    [...cli.args, 'mcp', 'add', 'phone_use', '--', process.execPath, entry],
    {
      stdio: 'inherit',
      shell: false,
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
