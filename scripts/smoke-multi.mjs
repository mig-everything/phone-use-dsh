#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { values } = parseArgs({
  options: { devices: { type: 'string' }, config: { type: 'string' }, output: { type: 'string' } },
});
const ids =
  values.devices
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean) ?? [];
if (!ids.length || new Set(ids).size !== ids.length || ids.length > 8)
  throw new Error(
    'Pass 1–8 distinct exact device IDs with --devices id1,id2. This check is read-only.',
  );
const args = [fileURLToPath(new URL('../dist/src/cli.js', import.meta.url)), 'stdio'];
if (values.config) args.push('--config', values.config);
const client = new Client({ name: 'phone-use-multi-smoke', version: '0.4.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args,
  env: process.env,
  stderr: 'inherit',
});
const sessions = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.structuredContent));
  return result;
}
try {
  await client.connect(transport);
  for (const device_id of ids)
    sessions.push((await call('phone_open', { device_id })).structuredContent.session_id);
  const result = await call('phone_observe_many', { session_ids: sessions });
  const data = result.structuredContent;
  const panel = (await call('phone_screen')).structuredContent.panel;
  if (panel.sessions.length !== sessions.length)
    throw new Error('Panel did not attach every session.');
  const tools = await client.listTools();
  const screen = tools.tools.find((tool) => tool.name === 'phone_console');
  if (!screen?._meta?.['openai/ui']?.entrypoints?.some((e) => e.type === 'thread'))
    throw new Error('Conversation panel entrypoint missing.');
  const resource = await client.readResource({ uri: screen._meta.ui.resourceUri });
  if (resource.contents[0]?.mimeType !== 'text/html;profile=mcp-app')
    throw new Error('UI resource missing.');
  const summary = {
    all_succeeded: data.all_succeeded,
    started_at: data.started_at,
    completed_at: data.completed_at,
    actionsSubmitted: 0,
    panelSessions: panel.sessions.length,
    threadEntrypoint: true,
    results: [],
  };
  const images = result.content.filter((item) => item.type === 'image');
  let imageIndex = 0;
  if (values.output) await mkdir(values.output, { recursive: true, mode: 0o700 });
  for (const item of data.results) {
    const frame = item.observation ? images[imageIndex++] : undefined;
    const row = {
      session_id: item.session_id,
      device_id: item.device_id,
      status: item.status,
      display: item.observation?.display,
      nodeCount: item.observation?.nodes.length,
      warnings: item.observation?.warnings,
      error: item.error,
      screenshotBytes: frame ? Buffer.from(frame.data, 'base64').length : 0,
    };
    if (values.output && frame) {
      row.screenshot = join(values.output, `${imageIndex}.png`);
      await writeFile(row.screenshot, Buffer.from(frame.data, 'base64'), { mode: 0o600 });
    }
    summary.results.push(row);
  }
  if (values.output)
    await writeFile(join(values.output, 'smoke.json'), JSON.stringify(summary, null, 2), {
      mode: 0o600,
    });
  console.log(JSON.stringify(summary, null, 2));
  if (!data.all_succeeded) process.exitCode = 1;
} finally {
  await Promise.allSettled(sessions.map((session_id) => call('phone_close', { session_id })));
  await client.close();
}
