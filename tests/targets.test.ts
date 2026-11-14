import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describeNodes } from '../src/core/perception.js';
import { ExactTargetResolver } from '../src/core/targets.js';
import { PhoneService } from '../src/core/service.js';
import { resolveTapPlan } from '../src/core/planning.js';
import { createMcpServer } from '../src/mcp.js';
import { Fleet } from './fleet.js';
import type { Device, UINode } from '../src/core/types.js';
import { parseHarmonyTree, parseAndroidTree, parseIOSTree } from '../src/adapters/parsers.js';

const node = (id: string, text: string, extra: Partial<UINode> = {}): UINode => ({
  id,
  text,
  resourceId: '',
  type: 'Button',
  bounds: { x: 20, y: 30, width: 100, height: 50 },
  enabled: true,
  clickable: true,
  focused: false,
  ...extra,
});

test('exact aliases do not guess substrings or cross-platform meaning, and repeated names require context', () => {
  const resolver = new ExactTargetResolver();
  const nodes = describeNodes([
    node('personal', 'Personal', { type: 'Row', clickable: false }),
    node('p', 'Open', { parentId: 'personal' }),
    node('work', 'Work', { type: 'Row', clickable: false }),
    node('w', 'Open', { parentId: 'work', resourceId: 'work.open' }),
    node('d', 'Continue', { enabled: false }),
    node('s', 'Continuously'),
  ]);
  assert.equal(resolver.resolve(nodes, { names: ['Open'] }).status, 'ambiguous');
  assert.equal(
    resolver.resolve(nodes, { names: ['ＯＰＥＮ'], context: 'work' }).selected_node_id,
    'w',
  );
  assert.equal(resolver.resolve(nodes, { names: ['继续'] }).status, 'missing');
  assert.equal(resolver.resolve(nodes, { names: ['Continue'] }).status, 'disabled');
  assert.equal(resolver.resolve(nodes, { names: ['Cont'] }).status, 'missing');
  assert.equal(
    resolver.resolve(nodes, { resource_id: 'work.open', role: 'button' }).selected_node_id,
    'w',
  );
  assert.throws(() => resolver.resolve(nodes, { role: 'button' }));
  assert.equal(
    resolver.resolve(describeNodes([node('long', 'a'.repeat(160) + ' different action')]), {
      names: ['a'.repeat(160)],
    }).status,
    'missing',
  );
});

test('native Harmony, Android and WDA trees map shared explicit aliases to their own control IDs', () => {
  const pages = [
    parseHarmonyTree({
      attributes: { type: 'Button', text: '继续', clickable: true, bounds: '[10,20][110,70]' },
    }),
    parseAndroidTree(
      '<hierarchy><node class="android.widget.Button" text="Continue" clickable="true" bounds="[20,30][140,90]" /></hierarchy>',
    ),
    parseIOSTree({
      type: 'Application',
      children: [
        {
          type: 'Button',
          label: 'Continue',
          rect: { x: 30, y: 40, width: 160, height: 50 },
          isEnabled: '1',
        },
      ],
    }),
  ];
  for (const page of pages) {
    const resolution = new ExactTargetResolver().resolve(describeNodes(page), {
      names: ['继续', 'Continue'],
      role: 'button',
    });
    assert.equal(resolution.status, 'matched');
    assert.ok(page.some((n) => n.id === resolution.selected_node_id));
  }
});

class Pages extends Fleet {
  duplicate = false;
  changed = false;
  override async tree(device: Device) {
    const name = this.changed ? 'Delete account' : device.id.endsWith('1') ? '继续' : 'Continue';
    // Targets beyond the usual 500-node observation budget must still be searched.
    return [
      ...Array.from({ length: 550 }, (_, i) =>
        node(`label-${i}`, `Text ${i}`, { type: 'Text', clickable: false }),
      ),
      node('continue', name),
      ...(this.duplicate ? [node('second', name)] : []),
    ];
  }
}

test('shared intent resolves whole trees independently and prepares no operations on any ambiguity', async () => {
  const fleet = new Pages(),
    dir = await mkdtemp(join(tmpdir(), 'phone-use-targets-'));
  const service = new PhoneService([fleet], dir);
  try {
    const targets = await Promise.all(
      (await fleet.discover()).map(async (device) => ({
        session_id: (await service.open(device.id)).session_id,
      })),
    );
    const plan = await resolveTapPlan(service, targets, { names: ['继续', 'Continue'] });
    assert.equal(plan.ready, true);
    assert.equal(plan.operations.length, 2);
    assert.notEqual(
      plan.operations[0]!.action.observation_id,
      plan.operations[1]!.action.observation_id,
    );
    assert.equal(fleet.calls.length, 0);
    assert.equal(fleet.captures.size, 0);
    fleet.changed = true;
    await assert.rejects(
      service.act(plan.operations[0]!.session_id, plan.operations[0]!.action, false),
      (error: any) => error.code === 'STALE_NODE',
    );
    assert.equal(fleet.calls.length, 0);
    fleet.changed = false;
    fleet.duplicate = true;
    const ambiguous = await resolveTapPlan(service, targets, { names: ['继续', 'Continue'] });
    assert.equal(ambiguous.ready, false);
    assert.deepEqual(ambiguous.operations, []);
    await assert.rejects(
      resolveTapPlan(service, targets, { names: ['Continue'] }, 'other-thread'),
      (error: any) => error.code === 'SESSION_CLOSED',
    );
    await assert.rejects(
      resolveTapPlan(service, [targets[0]!, targets[0]!], { names: ['Continue'] }),
      (error: any) => error.code === 'INVALID_TARGETS',
    );
  } finally {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP resolution returns batch-ready per-device operations and explicit overrides, without automatic execution', async () => {
  const fleet = new Pages(),
    dir = await mkdtemp(join(tmpdir(), 'phone-use-plan-mcp-'));
  const service = new PhoneService([fleet], dir),
    server = createMcpServer(service),
    client = new Client({ name: 'plan-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const first = await service.open('demo:phone-1'),
      second = await service.open('demo:phone-2');
    const result = await client.callTool({
      name: 'phone_resolve_many',
      arguments: {
        targets: [
          { session_id: first.session_id },
          { session_id: second.session_id, selector: { names: ['Continue'] } },
        ],
        selector: { names: ['继续'] },
      },
    });
    assert.equal(result.isError, undefined);
    const data = result.structuredContent as any;
    assert.equal(data.ready, true);
    assert.equal(fleet.calls.length, 0);
    const applied = await client.callTool({
      name: 'phone_batch',
      arguments: { operations: data.operations },
    });
    assert.equal((applied.structuredContent as any).all_succeeded, true);
    assert.equal(fleet.calls.length, 2);
    assert.deepEqual(fleet.calls.map((c) => c.device).sort(), ['demo:phone-1', 'demo:phone-2']);
  } finally {
    await client.close();
    await server.close();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
