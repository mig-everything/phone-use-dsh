#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { codexLauncher } from './host-runtime.mjs';

const { values } = parseArgs({
  options: {
    codex: { type: 'string' },
    marketplace: { type: 'string' },
    interactive: { type: 'boolean' },
  },
});
const bundled =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
let binary = values.codex;
if (!binary) {
  try {
    await access(bundled);
    binary = bundled;
  } catch {
    binary = 'codex';
  }
}
// This is a separate loader validation process. It does not restart the desktop app,
// mutate host configuration, start a model turn or operate a phone.
const launcher = await codexLauncher(binary === 'codex' ? undefined : binary);
const child = spawn(launcher.command, [...launcher.args, 'app-server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
const lines = createInterface({ input: child.stdout });
let next = 1;
const loaderWarnings = [];
child.stderr.on('data', (chunk) => {
  for (const line of chunk.toString().split('\n'))
    if (line.includes('failed to parse plugin MCP server') && line.includes('phone-use'))
      loaderWarnings.push(line.slice(-1500));
});
function fail(error) {
  for (const p of pending.values()) p.reject(error);
  pending.clear();
}
child.on('error', fail);
child.on('exit', () => fail(new Error('Host loader exited before completing the check.')));
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
  else callback.resolve(message.result);
});
function call(method, params) {
  const id = next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Host request timed out: ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
async function check() {
  const { plugin } = await call('plugin/read', {
    marketplacePath: values.marketplace ?? join(homedir(), '.agents/plugins/marketplace.json'),
    pluginName: 'phone-use',
  });
  if (!plugin.mcpServers.includes('phone_use'))
    throw new Error(
      `Host did not load phone_use from the installed plugin. ${loaderWarnings.join('\n')}`,
    );
  const { data } = await call('mcpServerStatus/list', { serverName: 'phone_use', detail: 'full' });
  const server = data.find(
    (entry) => entry.name === 'phone_use' || entry.pluginId === plugin.summary.id,
  );
  if (!server || server.toolsError)
    throw new Error(server?.toolsError ?? 'Host MCP inventory is empty.');
  if (server.pluginId !== plugin.summary.id)
    throw new Error(
      'Host phone_use does not come from the installed plugin. Check for a standalone MCP registration overriding it.',
    );
  if (server.serverInfo?.version !== plugin.summary.localVersion)
    throw new Error('The running MCP server version differs from the installed plugin version.');
  const tools = Object.values(server.tools),
    screen = tools.find((tool) => tool.name === 'phone_console');
  if (!screen?._meta?.['openai/ui']?.entrypoints?.some((item) => item.type === 'thread'))
    throw new Error('Host did not discover the conversation panel entrypoint.');
  if (!screen._meta?.ui?.visibility?.includes('model'))
    throw new Error(
      'The dashboard opener is hidden from the model; the conversation fallback is unavailable.',
    );
  const uri = screen._meta.ui.resourceUri;
  const resource = await call('mcpServer/resource/read', { server: server.name, uri });
  if (!JSON.stringify(resource).includes('text/html;profile=mcp-app'))
    throw new Error('Host could not load the panel HTML resource.');
  console.log(
    JSON.stringify({
      plugin: plugin.summary.id,
      version: plugin.summary.localVersion,
      server: server.name,
      tools: tools.length,
      threadEntrypoint: true,
      modelConsole: true,
      resource: uri,
      loader: binary,
      desktopWindowVerified: false,
    }),
  );
}
try {
  await call('initialize', {
    clientInfo: { name: 'phone_use_host_check', version: '0.5.2' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  if (values.interactive) {
    console.log('Separate host check: type check, reload (this check process only), or exit.');
    const input = createInterface({ input: process.stdin });
    try {
      for await (const command of input) {
        if (command.trim() === 'exit') break;
        try {
          if (command.trim() === 'reload') await call('config/mcpServer/reload');
          await check();
        } catch (error) {
          console.error(error.message);
        }
      }
    } finally {
      input.close();
    }
  } else await check();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  lines.close();
  child.stdin.end();
  child.kill('SIGTERM');
}
