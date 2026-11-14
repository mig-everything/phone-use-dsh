import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { OcrEngine } from '../src/core/ocr.js';
import { PortableOcr } from '../src/adapters/ocr-portable.js';
import { DemoAdapter } from '../src/adapters/demo.js';
import { createService } from '../src/config.js';
import type { Frame } from '../src/core/types.js';

async function fixture(scale = 1): Promise<Frame> {
  const original = await readFile('tests/fixtures/ocr-bilingual.png');
  const width = Math.round(1000 * scale),
    height = Math.round(600 * scale);
  return {
    bytes: await sharp(original).resize(width, height).png().toBuffer(),
    mimeType: 'image/png',
    display: {
      id: `test-${scale}`,
      width,
      height,
      inputWidth: width / 2,
      inputHeight: height / 2,
      rotation: 0,
      posture: 'unknown',
    },
  };
}

test('bundled bilingual OCR recognizes three images concurrently and maps resized pixels', async () => {
  const engine = new OcrEngine(new PortableOcr(), 10_000);
  const frames = await Promise.all([1, 2, 3].map(fixture));
  assert.equal(engine.capabilities().available, null, 'constructed is not verified healthy');
  try {
    const results = await Promise.all(frames.map((frame) => engine.recognize(frame)));
    for (const [i, result] of results.entries()) {
      assert.equal(result.status, 'ok', JSON.stringify(result));
      const text = result.items
        .map((item) => item.text)
        .join(' ')
        .replace(/\s/g, '');
      assert.match(text, /Continue/);
      assert.match(text, /继续/);
      for (const item of result.items) {
        assert.ok(item.bounds.x >= 0 && item.bounds.y >= 0);
        assert.ok(item.bounds.x + item.bounds.width <= frames[i]!.display.width);
        assert.ok(item.bounds.y + item.bounds.height <= frames[i]!.display.height);
      }
      const english = result.items.find((item) => item.text.includes('Continue'))!;
      assert.ok(
        english.bounds.width < frames[i]!.display.width * 0.3,
        'localize the word, not a whole row of unrelated controls',
      );
      assert.ok(
        english.bounds.y > frames[i]!.display.height * 0.4,
        'full image pixels, not driver units',
      );
    }
    assert.equal(engine.capabilities().available, true);
    assert.equal(engine.capabilities().max_concurrency, 3);
    assert.equal((await engine.recognize(frames[0]!)).cached, true);
  } finally {
    await engine.dispose();
  }
});

test('OCR pool bounds concurrency, deduplicates identical in-flight images and isolates one failure', async () => {
  const frame = await new DemoAdapter().capture();
  let active = 0,
    peak = 0,
    calls = 0;
  const engine = new OcrEngine(
    {
      id: 'parallel-test',
      maxConcurrency: 3,
      async recognize(f) {
        calls++;
        active++;
        peak = Math.max(active, peak);
        await delay(30);
        active--;
        if (f.display.width === 362) throw new Error('test failure');
        return [
          {
            text: String(f.display.width),
            confidence: 1,
            bounds: { x: 1, y: 1, width: 20, height: 10 },
          },
        ];
      },
    },
    1000,
  );
  const results = await Promise.all(
    [360, 360, 361, 362, 363, 364].map((width) =>
      engine.recognize({ ...frame, display: { ...frame.display, width } }),
    ),
  );
  assert.equal(peak, 3);
  assert.equal(calls, 5, 'duplicate image shares inference');
  assert.equal(results[3]!.status, 'error');
  for (const index of [0, 1, 2, 4, 5]) assert.equal(results[index]!.status, 'ok');
  results[0]!.items[0]!.text = 'changed';
  assert.equal(results[1]!.items[0]!.text, '360', 'no mutable cross-device result sharing');
  await engine.dispose();
});

test('queue time shares the deadline, failure cooldown is immediate, cancellation does not poison health', async () => {
  const frame = await new DemoAdapter().capture();
  let calls = 0;
  const engine = new OcrEngine(
    {
      id: 'hung',
      recognize: async () => {
        calls++;
        return new Promise(() => {});
      },
    },
    30,
  );
  const a = engine.recognize(frame);
  const b = engine.recognize({ ...frame, display: { ...frame.display, width: 999 } });
  assert.equal((await a).status, 'timeout');
  assert.ok(['timeout', 'unavailable'].includes((await b).status));
  assert.equal(calls, 1, 'expired queued work does not start');
  const skipped = await engine.recognize(frame);
  assert.equal(skipped.reason, 'cooldown');
  assert.equal(engine.capabilities().available, false);
  await engine.dispose();
  const cancelled = new OcrEngine(
    { id: 'cancel', recognize: async () => new Promise(() => {}) },
    1000,
  );
  const controller = new AbortController();
  const pending = cancelled.recognize(frame, { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).reason, 'cancelled');
  assert.equal(cancelled.capabilities().health, 'not_checked');
  await cancelled.dispose();
});

test('missing or corrupted local models fail closed without downloads; bundled provider is the platform-independent default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phone-ocr-models-'));
  const frame = await fixture();
  try {
    const missing = new OcrEngine(new PortableOcr(['eng'], 1, directory));
    assert.equal((await missing.recognize(frame)).status, 'error');
    await missing.dispose();
    await writeFile(join(directory, 'eng.traineddata'), 'invalid');
    const corrupted = new OcrEngine(new PortableOcr(['eng'], 1, directory));
    assert.equal((await corrupted.recognize(frame)).status, 'error');
    await corrupted.dispose();
    assert.throws(() => new PortableOcr(['unknown']), /supports/);
    const config = join(directory, 'config.json');
    await writeFile(config, JSON.stringify({ stateDirectory: directory }));
    const service = await createService(true, config);
    assert.equal(service.perceptionCapabilities().ocr.provider, 'tesseract-fast');
    await service.shutdown();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborting during portable startup stops the process and a later recognition recovers', async () => {
  const provider = new PortableOcr(['eng'], 1),
    frame = await fixture();
  const controller = new AbortController();
  const pending = provider.recognize(frame, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(pending);
    const result = await provider.recognize(frame, { signal: AbortSignal.timeout(10_000) });
    assert.ok(result.some((item) => item.text.includes('Continue')));
  } finally {
    await provider.dispose();
  }
});
