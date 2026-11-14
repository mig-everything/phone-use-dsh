import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { settleFrame } from '../src/core/settle.js';
import { PreviewEncoder } from '../src/core/preview.js';
import type { Frame } from '../src/core/types.js';

async function frame(color: string, width = 360, height = 720): Promise<Frame> {
  return {
    bytes: await sharp({ create: { width, height, channels: 3, background: color } })
      .png()
      .toBuffer(),
    mimeType: 'image/png',
    display: {
      id: '0',
      width,
      height,
      inputWidth: width,
      inputHeight: height,
      rotation: 0,
      posture: 'unknown',
    },
  };
}

test('settling returns the final animation frame only after two matching intervals', async () => {
  const frames = await Promise.all(
    ['#000', '#888', '#fff', '#fff', '#fff'].map((color) => frame(color)),
  );
  let index = 0;
  const result = await settleFrame(
    async () => frames[Math.min(index++, frames.length - 1)]!,
    2000,
    1,
  );
  assert.equal(result.stability.status, 'stable');
  assert.equal(result.stability.samples, 5);
  assert.equal(result.frame, frames[4]);
});

test('continuous animation times out with the latest frame and bounded samples', async () => {
  const frames = await Promise.all(['#000', '#fff'].map((color) => frame(color)));
  let index = 0;
  const result = await settleFrame(async () => frames[index++ % 2]!, 2000, 1);
  assert.equal(result.stability.status, 'timeout');
  assert.equal(result.stability.samples, 12);
  assert.equal(result.frame, frames[1]);
});

test('rotation changes reset visual stability even with identical pixels', async () => {
  const base = await frame('#fff');
  let index = 0;
  const result = await settleFrame(
    async () => ({ ...base, display: { ...base.display, rotation: index++ < 2 ? 0 : 180 } }),
    2000,
    1,
  );
  assert.equal(result.stability.samples, 5);
  assert.equal(result.frame.display.rotation, 180);
});

test('preview encoding is bounded, cached and leaves the original screenshot intact', async () => {
  const source = await frame('#6495ed', 1440, 3120),
    original = Buffer.from(source.bytes);
  const encoder = new PreviewEncoder();
  const first = encoder.encode(source),
    second = encoder.encode(source);
  assert.equal(first, second);
  const encoded = await first;
  assert.equal(encoded.mimeType, 'image/jpeg');
  assert.ok(encoded.width <= 960 && encoded.height <= 1280);
  const metadata = await sharp(Buffer.from(encoded.data, 'base64')).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.height, encoded.height);
  assert.deepEqual(source.bytes, original);
  assert.equal(source.display.width, 1440);
  assert.equal(source.mimeType, 'image/png');
});
