import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OcrEngine } from '../src/core/ocr.js';
import { DemoAdapter } from '../src/adapters/demo.js';
import { PhoneService } from '../src/core/service.js';
import type { UINode } from '../src/core/types.js';

test('OCR validates pixel boxes and caches only exact images and image geometry', async () => {
  const frame = await new DemoAdapter().capture();
  let calls = 0;
  const engine = new OcrEngine({
    id: 'test-local',
    async recognize() {
      calls++;
      return [
        { text: 'Continue', confidence: 1.2, bounds: { x: -10, y: 20, width: 50, height: 30 } },
        { text: 'invalid', confidence: NaN, bounds: { x: 0, y: 0, width: 1, height: 1 } },
        { text: 'offscreen', confidence: 0.5, bounds: { x: 1e6, y: 0, width: 20, height: 20 } },
      ];
    },
  });
  const a = await engine.recognize(frame);
  assert.equal(a.status, 'ok');
  assert.deepEqual(a.items, [
    {
      id: 'ocr:0',
      text: 'Continue',
      confidence: 1,
      bounds: { x: 0, y: 20, width: 40, height: 30 },
    },
  ]);
  a.items[0]!.text = 'Changed by caller';
  const b = await engine.recognize(frame);
  assert.equal(b.cached, true);
  assert.equal(b.items[0]!.text, 'Continue');
  assert.equal(calls, 1);
  await engine.recognize({
    ...frame,
    display: { ...frame.display, width: frame.display.width / 2 },
  });
  assert.equal(calls, 2);
  engine.clear();
  await engine.recognize(frame);
  assert.equal(calls, 3);
});

test('OCR has bounded cancellation and explicit unavailable/error outcomes', async () => {
  const frame = await new DemoAdapter().capture();
  let signal: AbortSignal | undefined;
  const slow = new OcrEngine(
    {
      id: 'slow',
      recognize(_frame, options) {
        signal = options.signal;
        return new Promise(() => {});
      },
    },
    20,
  );
  assert.equal((await slow.recognize(frame)).status, 'timeout');
  assert.equal(signal!.aborted, true);
  assert.equal((await new OcrEngine().recognize(frame)).status, 'unavailable');
  const failed = new OcrEngine({
    id: 'broken',
    async recognize() {
      throw new Error('secret image data');
    },
  });
  const result = await failed.recognize(frame);
  assert.equal(result.status, 'error');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('OCR is on demand, bound to the screenshot, never creates native node actions or runs in previews', async () => {
  class Page extends DemoAdapter {
    empty = false;
    override async tree(): Promise<UINode[]> {
      return this.empty ? [] : super.tree();
    }
  }
  const adapter = new Page(),
    dir = await mkdtemp(join(tmpdir(), 'phone-use-ocr-'));
  adapter.text = 'Search';
  let calls = 0;
  const service = new PhoneService([adapter], dir, undefined, undefined, undefined, undefined, {
    ocr: {
      id: 'test-local',
      async recognize(frame) {
        calls++;
        assert.ok(frame.bytes.length);
        return [
          { text: 'Continue', confidence: 0.8, bounds: { x: 50, y: 50, width: 100, height: 40 } },
        ];
      },
    },
  });
  try {
    const { session_id } = await service.open('demo:foldable');
    await service.inspect(session_id);
    await service.preview(session_id);
    assert.equal(calls, 0);
    await service.observe(session_id, true, 200, 0, 'auto');
    assert.equal(calls, 0, 'a complete labeled tree does not need OCR');
    adapter.empty = true;
    const capture = await service.observe(session_id, true, 200, 0, 'auto');
    assert.equal(calls, 1);
    assert.equal(capture.observation.ocr!.status, 'ok');
    assert.deepEqual(capture.observation.nodes, []);
    await assert.rejects(
      service.act(
        session_id,
        { kind: 'tap_node', node_id: 'ocr:0', observation_id: capture.observation.id },
        false,
      ),
      (error: any) => error.code === 'NODE_NOT_FOUND',
    );
    await service.observe(session_id, true, 200, 0, 'off');
    assert.equal(calls, 1);
  } finally {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
