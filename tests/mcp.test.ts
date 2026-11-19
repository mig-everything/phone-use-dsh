import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer, UI_URI } from '../src/mcp.js';
import { createHttpServer } from '../src/http.js';
import { DemoAdapter } from '../src/adapters/demo.js';
import { PhoneService } from '../src/core/service.js';
import { Fleet } from './fleet.js';

test('official SDK handshake, discovery, screen fallback, errors and resource loading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-mcp-')),
    service = new PhoneService([new DemoAdapter()], dir);
  const server = createMcpServer(service),
    client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const list = await client.listTools();
    assert.equal(list.tools.length, 19);
    for (const tool of list.tools) {
      for (const hint of [
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ] as const) {
        assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name}.${hint}`);
      }
    }
    for (const tool of list.tools.filter(
      (tool) =>
        tool.name !== 'phone_console' &&
        ((tool._meta?.ui as any)?.visibility?.includes('model') ||
          !(tool._meta?.ui as any)?.visibility),
    )) {
      assert.equal(
        (tool._meta?.ui as any)?.resourceUri,
        undefined,
        'only the explicit console opener may create preview tabs',
      );
      assert.equal(tool._meta?.['openai/outputTemplate'], undefined);
    }
    assert.deepEqual(
      (list.tools.find((tool) => tool.name === 'phone_console')?._meta?.ui as any)?.visibility,
      ['model', 'app'],
    );
    assert.deepEqual(
      list.tools.find((tool) => tool.name === 'phone_console')?._meta?.['openai/ui'],
      { entrypoints: [{ type: 'thread' }] },
    );
    const opened = await client.callTool({
      name: 'phone_open',
      arguments: { device_id: 'demo:foldable' },
    });
    const session_id = (opened.structuredContent as any).session_id;
    const screen = await client.callTool({ name: 'phone_screen', arguments: { session_id } });
    assert.ok((screen.content as any[]).some((c) => c.type === 'image'));
    const result = await client.callTool({
      name: 'phone_act',
      arguments: { session_id, action: { kind: 'tap', x: 12, y: 12 } },
    });
    assert.equal(result.isError, true);
    const resources = await client.readResource({ uri: UI_URI });
    assert.equal(resources.contents[0]!.mimeType, 'text/html;profile=mcp-app');
    const resource = resources.contents[0]!;
    assert.ok('text' in resource);
    assert.match(resource.text, /ui\/initialize/);
    await client.callTool({ name: 'phone_close', arguments: { session_id } });
  } finally {
    await client.close();
    await server.close();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
test('headless stdio MCP observes, taps controls, types and swipes without a sidebar or UI capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-stdio-'));
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/src/cli.js'), 'stdio', '--demo'],
    env: { ...process.env, PHONE_USE_STATE_DIR: dir } as Record<string, string>,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
      assert.equal(result._meta?.['openai/outputTemplate'], undefined);
      return result;
    };
    assert.equal(
      ((await call('phone_devices')).structuredContent as any).devices[0].id,
      'demo:foldable',
    );
    const { session_id } = (await call('phone_open', { device_id: 'demo:foldable' }))
      .structuredContent as any;
    const tree = await call('phone_inspect', { session_id });
    assert(!(tree.content as any[]).some((c) => c.type === 'image'));
    const tapped = await call('phone_act', {
      session_id,
      action: {
        kind: 'tap_node',
        node_id: 'input',
        observation_id: (tree.structuredContent as any).observation.id,
      },
    });
    const typed = await call('phone_act', {
      session_id,
      action: {
        kind: 'text',
        text: 'MCP 独立操作',
        observation_id: (tapped.structuredContent as any).observation.id,
      },
    });
    assert.match(JSON.stringify(typed.structuredContent), /MCP 独立操作/);
    const observed = await call('phone_observe', { session_id, wait_for: 'none', ocr: 'off' });
    assert((observed.content as any[]).some((c) => c.type === 'image'));
    const action = {
      kind: 'swipe',
      x: 0.5,
      y: 0.8,
      to_x: 0.5,
      to_y: 0.2,
      space: 'normalized',
      duration_ms: 200,
      observation_id: (observed.structuredContent as any).observation.id,
    };
    await call('phone_act', { session_id, action, observe: false });
    const stale = await client.callTool({ name: 'phone_act', arguments: { session_id, action } });
    assert.equal((stale.structuredContent as any).error.code, 'STALE_OBSERVATION');
    await call('phone_act', { session_id, action: { kind: 'key', key: 'home' } });
    await call('phone_close', { session_id });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('HTTP requires bearer authentication, rejects browser origins and supports the SDK client', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-http-')),
    service = new PhoneService([new DemoAdapter()], dir);
  const token = 'test-only-token-with-at-least-32-characters',
    http = createHttpServer(service, token);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`);
  const client = new Client({ name: 'http-test', version: '1' });
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' },
        })
      ).status,
      403,
    );
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const result = await client.callTool({ name: 'phone_devices', arguments: {} });
    assert.equal((result.structuredContent as any).devices.length, 1);
  } finally {
    await client.close();
    await service.shutdown();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('thread panel opens without arguments, reuses sessions and rejects cross-thread access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-panel-'));
  // This test checks after_id against a cached frame, independent of host CPU load.
  const now = Date.now();
  const service = new PhoneService([new Fleet()], dir, () => now),
    server = createMcpServer(service);
  const client = new Client({ name: 'panel-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = (name: string, args: Record<string, unknown> = {}, scope?: string) =>
    client.callTool({
      name,
      arguments: args,
      ...(scope ? { _meta: { 'openai/session': scope } } : {}),
    });
  try {
    await server.connect(a);
    await client.connect(b);
    const first = (await call('phone_screen', {}, 'A')).structuredContent as any;
    assert.deepEqual(first.panel.sessions, []);
    const panel_id = first.panel.panel_id;
    const opened = (
      await call('phone_panel_action', {
        panel_id,
        command: { kind: 'open', device_id: 'demo:phone-1' },
      })
    ).structuredContent as any;
    const reused = (await call('phone_open', { device_id: 'demo:phone-1' }, 'A'))
      .structuredContent as any;
    assert.equal(opened.session_id, reused.session_id);
    assert.equal(reused.reused, true);
    for (let i = 0; i < 3; i++) await call('phone_focus', { session_id: opened.session_id }, 'A');
    const selected = (await call('phone_panel', { panel_id })).structuredContent as any;
    assert.equal(selected.panel.panel_id, panel_id);
    assert.equal(selected.panel.selection.session_id, opened.session_id);
    assert.equal(selected.panel.sessions.length, 1);
    const ticket = await call('phone_connect', { panel_id });
    assert.ok((ticket._meta?.stream as any).token);
    assert.equal(JSON.stringify(ticket.structuredContent).includes('token'), false);
    assert.equal(
      ((await call('phone_devices', {}, 'B')).structuredContent as any).sessions.length,
      0,
    );
    assert.equal(
      (await call('phone_observe', { session_id: opened.session_id }, 'B')).isError,
      true,
    );
    const other = (await call('phone_screen', {}, 'B')).structuredContent as any;
    const forbidden = await call('phone_panel_action', {
      panel_id: other.panel.panel_id,
      command: { kind: 'close', session_id: opened.session_id },
    });
    assert.equal(forbidden.isError, true);
    assert.equal(
      ((await call('phone_panel', { panel_id })).structuredContent as any).panel.sessions.length,
      1,
    );
    const frame = await call('phone_frame', { panel_id, session_id: opened.session_id });
    assert.ok(frame._meta?.frame);
    assert.ok(!(frame.content as any[]).some((c) => c.type === 'image'));
    assert.equal((frame._meta?.frame as any).mimeType, 'image/jpeg');
    const unchanged = await call('phone_frame', {
      panel_id,
      session_id: opened.session_id,
      after_id: (frame.structuredContent as any).observation.id,
    });
    assert.equal(unchanged._meta?.frame, undefined);
    const inspection = await call('phone_inspect', { session_id: opened.session_id }, 'A');
    assert.equal((inspection.structuredContent as any).observation.kind, 'tree');
    assert.ok(!(inspection.content as any[]).some((c) => c.type === 'image'));
    const screenshot = await call('phone_panel_action', {
      panel_id,
      command: { kind: 'screenshot', session_id: opened.session_id },
    });
    assert.equal((screenshot._meta?.frame as any).mimeType, 'image/png');
    assert.equal((screenshot.structuredContent as any).observation.stability.status, 'stable');
  } finally {
    await client.close();
    await server.close();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('parallel device observations remain labeled; partial actions never cross devices or replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-batch-')),
    fleet = new Fleet();
  const service = new PhoneService([fleet], dir),
    server = createMcpServer(service),
    client = new Client({ name: 'batch-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  try {
    await server.connect(a);
    await client.connect(b);
    const sessions = await Promise.all(
      ['demo:phone-1', 'demo:phone-2'].map(
        async (device_id) =>
          ((await call('phone_open', { device_id })).structuredContent as any).session_id,
      ),
    );
    const observed = await call('phone_observe_many', { session_ids: sessions });
    const data = observed.structuredContent as any;
    assert.equal(data.all_succeeded, true);
    assert.equal((observed.content as any[]).filter((c) => c.type === 'image').length, 2);
    assert.deepEqual(
      data.results.map((r: any) => r.device_id),
      ['demo:phone-1', 'demo:phone-2'],
    );
    const result = await call('phone_batch', {
      operations: sessions.map((session_id) => ({
        session_id,
        action: { kind: 'tap', x: 100, y: 200, observation_id: data.results[0].observation.id },
      })),
    });
    const batch = result.structuredContent as any;
    assert.equal(batch.all_succeeded, false);
    assert.equal(batch.results[0].applied, true);
    assert.equal(batch.results[1].error.code, 'STALE_OBSERVATION');
    assert.equal(fleet.calls.length, 1);
    assert.equal(fleet.calls[0]!.device, 'demo:phone-1');
    const duplicate = await call('phone_batch', {
      operations: [sessions[0], sessions[0]].map((session_id) => ({
        session_id,
        action: { kind: 'key', key: 'home' },
      })),
    });
    assert.equal(duplicate.isError, true);
    assert.equal(fleet.calls.length, 1);
    fleet.broken.add('demo:phone-1');
    const partial = (await call('phone_observe_many', { session_ids: sessions }))
      .structuredContent as any;
    assert.equal(partial.results[0].status, 'error');
    assert.equal(partial.results[1].status, 'ok');
  } finally {
    await client.close();
    await server.close();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('batch dispatch is concurrent, bounded at four, and preserves per-device outcomes', async () => {
  let release!: () => void, fourStarted!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    fourStarted = r;
  });
  class SlowFleet extends Fleet {
    active = 0;
    peak = 0;
    override async execute(
      device: Parameters<Fleet['execute']>[0],
      action: Parameters<Fleet['execute']>[1],
    ) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      if (this.active === 4) fourStarted();
      try {
        await gate;
        await super.execute(device, action);
      } finally {
        this.active--;
      }
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-concurrent-')),
    fleet = new SlowFleet(6);
  const service = new PhoneService([fleet], dir),
    server = createMcpServer(service),
    client = new Client({ name: 'parallel-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const sessions = await Promise.all(
      (await fleet.discover()).map(async (d) => (await service.open(d.id)).session_id),
    );
    const result = client.callTool({
      name: 'phone_batch',
      arguments: {
        operations: sessions.map((session_id) => ({
          session_id,
          action: { kind: 'key', key: 'home' },
          observe: false,
        })),
      },
    });
    await ready;
    assert.equal(fleet.active, 4);
    release();
    assert.equal(
      ((await result).structuredContent as { all_succeeded: boolean }).all_succeeded,
      true,
    );
    assert.equal(fleet.peak, 4);
    assert.equal(fleet.calls.length, 6);
  } finally {
    release();
    await client.close();
    await server.close();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
