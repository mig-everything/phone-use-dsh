#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({
  options: {
    device: { type: 'string' },
    demo: { type: 'boolean' },
    config: { type: 'string' },
    output: { type: 'string' },
    manifest: { type: 'string' },
  },
});
const client = new Client({ name: 'phone-use-smoke', version: '0.4.0' });
let command = process.execPath,
  args = [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'stdio'],
  env = process.env,
  cwd;
if (values.manifest) {
  const path = resolve(values.manifest),
    root = dirname(path);
  const server = JSON.parse(await readFile(path, 'utf8')).mcpServers.phone_use;
  command = server.command.startsWith('./') ? resolve(root, server.command) : server.command;
  args = server.args.map((arg) => arg.replaceAll('${PLUGIN_ROOT}', root));
  cwd = (server.cwd ?? root).replaceAll('${PLUGIN_ROOT}', root);
  env = { ...process.env, ...server.env };
}
if (values.demo) args.push('--demo');
if (values.config) args.push('--config', values.config);
const transport = new StdioClientTransport({
  command,
  args,
  stderr: 'inherit',
  env,
  ...(cwd ? { cwd } : {}),
});
let sessionId;
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result;
}
try {
  await client.connect(transport);
  const discovered = (await call('phone_devices')).structuredContent;
  if (!values.device) {
    console.log(JSON.stringify(discovered, null, 2));
    console.log('Choose an exact ID with --device; this check does not send phone actions.');
  } else {
    const opened = (await call('phone_open', { device_id: values.device })).structuredContent;
    sessionId = opened.session_id;
    const result = await call('phone_observe', {
      session_id: sessionId,
      with_tree: true,
      max_nodes: 500,
    });
    const data = result.structuredContent,
      screenshot = result.content.find((c) => c.type === 'image');
    if (!screenshot) throw new Error('No screenshot returned');
    const uri = (await client.listResources()).resources.find(
      (resource) => resource.name === 'phone-screen',
    )?.uri;
    if (!uri) throw new Error('Screen resource missing');
    const resources = await client.readResource({ uri });
    if (resources.contents[0]?.mimeType !== 'text/html;profile=mcp-app')
      throw new Error('Screen resource missing');
    if (values.output)
      await writeFile(values.output, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
    console.log(
      JSON.stringify(
        {
          device: opened.device,
          display: data.observation.display,
          nodeCount: data.observation.nodes.length,
          warnings: data.observation.warnings,
          screenshotBytes: Buffer.from(screenshot.data, 'base64').length,
          mcpAppsResource: true,
          actionsSubmitted: 0,
          ...(values.output ? { screenshot: values.output } : {}),
        },
        null,
        2,
      ),
    );
  }
} finally {
  try {
    if (sessionId) await call('phone_close', { session_id: sessionId });
  } finally {
    await client.close();
  }
}
