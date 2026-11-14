import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pathToFileURL } from 'node:url';

test('installed launcher uses native Node on Windows and an explicit runtime on POSIX', async () => {
  const { launcher } = await import(pathToFileURL(resolve('scripts/host-runtime.mjs')).href);
  const windows = launcher(
    { PHONE_USE_CONFIG: 'C:\\Device Data\\phone.json' },
    'win32',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Windows',
  );
  assert.equal(windows.command, 'node.exe');
  assert.equal(windows.env.PATH, 'C:\\Program Files\\nodejs;C:\\Windows');
  assert.equal(windows.env.PHONE_USE_CONFIG, 'C:\\Device Data\\phone.json');
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-native-launch-'));
  const client = new Client({ name: 'native-launcher-test', version: '1' });
  try {
    const local = launcher({ PHONE_USE_STATE_DIR: dir });
    await client.connect(
      new StdioClientTransport({
        ...local,
        cwd: resolve('.'),
        args: [resolve('scripts/start.mjs'), '--demo'],
        stderr: 'pipe',
      }),
    );
    const result = await client.callTool({ name: 'phone_devices', arguments: {} });
    assert.equal((result.structuredContent as any).devices[0].id, 'demo:foldable');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'Work launcher starts MCP with a minimal PATH and spaced plugin and Node paths',
  { skip: process.platform === 'win32' ? 'POSIX launcher' : false },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'phone-use Work '));
    const client = new Client({ name: 'launcher-test', version: '1' });
    try {
      await mkdir(join(root, 'scripts'));
      await cp('scripts/launch-node.sh', join(root, 'scripts/launch-node.sh'));
      await cp('scripts/start.mjs', join(root, 'scripts/start.mjs'));
      await symlink(resolve('dist'), join(root, 'dist'), 'dir');
      await symlink(process.execPath, join(root, 'node runtime'));
      await client.connect(
        new StdioClientTransport({
          command: './scripts/launch-node.sh',
          args: [join(root, 'scripts/start.mjs'), '--demo'],
          cwd: root,
          env: {
            PATH: '/usr/bin:/bin',
            PHONE_USE_NODE: join(root, 'node runtime'),
            PHONE_USE_STATE_DIR: join(root, 'state'),
          },
          stderr: 'pipe',
        }),
      );
      const result = await client.callTool({ name: 'phone_screen', arguments: {} });
      assert.equal(result.isError, undefined);
      const data = result.structuredContent as { panel: { devices: { id: string }[] } };
      assert.equal(data.panel.devices[0]?.id, 'demo:foldable');
      const uri = (await client.listResources()).resources.find(
        (resource) => resource.name === 'phone-screen',
      )!.uri;
      const resource = await client.readResource({ uri });
      assert.equal(resource.contents[0]?.mimeType, 'text/html;profile=mcp-app');
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
