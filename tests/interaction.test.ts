import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { PhoneService } from '../src/core/service.js';
import { DemoAdapter } from '../src/adapters/demo.js';
import { settleFrame } from '../src/core/settle.js';
import { modelContent, compactModelData } from '../src/core/presentation.js';
import { jsonResult } from '../src/mcp.js';
import type { Device, DriverAction, Frame, UINode } from '../src/core/types.js';

class Page extends DemoAdapter {
  reads = 0;
  captures = 0;
  actions = 0;
  duplicate = false;
  drift = false;
  override async tree(): Promise<UINode[]> {
    this.reads++;
    const [base] = await super.tree();
    const button = {
      ...base!,
      id: 'continue',
      type: 'Button',
      text: 'Continue',
      bounds: { x: this.drift && this.reads % 2 === 0 ? 40 : 20, y: 100, width: 80, height: 40 },
    };
    return [
      button,
      ...(this.duplicate ? [{ ...button, id: 'other' }] : []),
      { ...base!, id: 'done', type: 'Button', text: this.actions ? 'Done' : 'Waiting' },
    ];
  }
  override async capture() {
    this.captures++;
    return super.capture();
  }
  override async execute(device: Device, action: DriverAction) {
    this.actions++;
    await super.execute(device, action);
  }
}
async function fixture(page = new Page()) {
  const dir = await mkdtemp(join(tmpdir(), 'phone-interaction-'));
  const service = new PhoneService([page], dir);
  const { session_id } = await service.open('demo:foldable');
  return {
    page,
    service,
    session_id,
    close: async () => {
      await service.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('atomic exact selector tap keeps validation and a targeted tree follow-up captures no image', async () => {
  const f = await fixture();
  try {
    const result = await f.service.act(
      f.session_id,
      { kind: 'tap_target', selector: { names: ['Continue'] } },
      { mode: 'tree', query: 'Done', max_nodes: 1 },
    );
    assert.ok(result.inspection);
    assert.deepEqual(
      result.inspection.observation.nodes.map((n) => n.id),
      ['done'],
    );
    assert.equal(f.page.captures, 0);
    assert.equal(f.page.actions, 1);
    f.page.duplicate = true;
    await assert.rejects(
      f.service.act(f.session_id, { kind: 'tap_target', selector: { names: ['Continue'] } }),
      (e: any) => e.code === 'TARGET_AMBIGUOUS',
    );
    assert.equal(f.page.actions, 1);
    f.page.duplicate = false;
    f.page.drift = true;
    await assert.rejects(
      f.service.act(f.session_id, { kind: 'tap_target', selector: { names: ['Continue'] } }),
      (e: any) => e.code === 'STALE_NODE',
    );
    assert.equal(f.page.actions, 1, 'moving target is never retried');
  } finally {
    await f.close();
  }
});

test('SDK action defaults to tree; readiness wait holds a unique target without screenshots and cancels', async () => {
  const f = await fixture();
  try {
    const acted = await f.service.act(f.session_id, { kind: 'key', key: 'home' });
    assert.ok(acted.inspection);
    assert.equal(f.page.captures, 0);
    const waited = await f.service.waitFor(f.session_id, {
      condition: { kind: 'target', selector: { names: ['Continue'] } },
      timeout_ms: 2000,
      interval_ms: 100,
      quiet_ms: 200,
    });
    assert.equal(waited.wait.status, 'matched');
    assert.ok(waited.inspection);
    assert.ok(waited.wait.samples >= 3);
    assert.equal(f.page.captures, 0);
    f.page.duplicate = true;
    const ambiguous = await f.service.waitFor(f.session_id, {
      condition: { kind: 'target', selector: { names: ['Continue'] } },
      timeout_ms: 250,
      interval_ms: 100,
      quiet_ms: 100,
    });
    assert.equal(ambiguous.wait.status, 'timeout');
    await assert.rejects(
      f.service.waitFor(
        f.session_id,
        {
          condition: { kind: 'target', selector: { names: ['Missing'] } },
        },
        AbortSignal.timeout(30),
      ),
      (e: any) => e.name === 'AbortError' || e.name === 'TimeoutError',
    );
    assert.equal(f.page.actions, 1);
  } finally {
    await f.close();
  }
});

test('region stability ignores background animation, but full-frame animation times out', async () => {
  const base = await new DemoAdapter().capture();
  let count = 0;
  const capture = async (): Promise<Frame> => ({
    ...base,
    bytes: await sharp({
      create: {
        width: 360,
        height: 720,
        channels: 3,
        background: count++ % 2 ? '#fff' : '#000',
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 180, height: 720, channels: 3, background: '#aaa' },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer(),
  });
  const region = await settleFrame(capture, 1500, 70, {
    region: { x: 0, y: 0, width: 0.45, height: 1 },
    quietMs: 150,
    maxSamples: 30,
  });
  assert.equal(region.stability.status, 'stable');
  const full = await settleFrame(capture, 300, 70);
  assert.equal(full.stability.status, 'timeout');
});

test('scenario model presenter forwards one copy, retains action evidence and hides UI metadata', async () => {
  const f = await fixture();
  try {
    const inspection = await f.service.inspect(f.session_id);
    const compact = compactModelData(inspection);
    const node = compact.observation.nodes[0];
    assert.ok(node.actions.includes('tap_node'));
    const result = { ...jsonResult(inspection as any), _meta: { secret: 'not-for-model' } };
    const content = modelContent(result);
    assert.equal(content.length, 1);
    const text = (content[0] as any).text;
    assert.equal(text.split('[continue]').length - 1, 1);
    assert.ok(text.includes('actions'));
    assert.ok(!JSON.stringify(content).includes('not-for-model'));
    assert.ok(!JSON.stringify(content).includes('structuredContent'));
    const fallback = modelContent({ content: [], structuredContent: result.structuredContent });
    assert.equal(
      (fallback[0] as any).text,
      text,
      'structured-only fallback preserves compact fields',
    );
  } finally {
    await f.close();
  }
});

test('waiting yields the device queue between samples, preview and manual pause stay available', async () => {
  const f = await fixture();
  try {
    await f.service.preview(f.session_id);
    const waiting = assert.rejects(
      f.service.waitFor(f.session_id, {
        condition: { kind: 'target', selector: { names: ['Never'] } },
        timeout_ms: 1000,
        interval_ms: 100,
      }),
      (error: any) => error.code === 'SESSION_PAUSED',
    );
    await nextTurn();
    assert.equal(
      f.service.state(f.session_id).busy,
      false,
      'the quiet interval does not hold the device queue',
    );
    const preview = await f.service.preview(f.session_id);
    assert.ok(preview?.frame.bytes.length);
    await f.service.pause(f.session_id, true);
    await waiting;
    assert.equal(f.page.actions, 0);
  } finally {
    await f.close();
  }
});

test('OCR/native dedup keeps repeated text at other positions and model action/state/context evidence', () => {
  const data = compactModelData({
    observation: {
      id: 'test',
      display: { width: 100, height: 100 },
      warnings: ['opaque elsewhere'],
      nodes: [
        {
          id: 'native',
          enabled: false,
          focused: false,
          selected: false,
          checked: false,
          checkable: true,
          scrollable: true,
          text: 'Continue',
          bounds: { x: 0, y: 0, width: 30, height: 20 },
          semantic: {
            role: 'tab',
            name: 'Continue',
            name_truncated: false,
            actions: ['tap_node'],
            context: { name: 'Account', name_truncated: true },
            target_node_id: 'native',
          },
        },
      ],
      ocr: {
        items: [
          { text: 'Continue', bounds: { x: 1, y: 1, width: 20, height: 10 } },
          { text: 'Continue', bounds: { x: 60, y: 60, width: 20, height: 10 } },
        ],
      },
    },
  });
  const node = data.observation.nodes[0];
  assert.equal(node.disabled, true);
  assert.equal(node.checked, false);
  assert.equal(node.selected, false);
  assert.equal(node.scrollable, true);
  assert.equal(node.context, 'Account');
  assert.equal(node.tap_target, 'native');
  assert.equal(node.context_truncated, true);
  assert.equal(data.observation.ocr.items.length, 1);
  assert.equal(data.observation.ocr.items[0].bounds.x, 60);
  assert.deepEqual(data.observation.warnings, ['opaque elsewhere']);
});
