import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { LatestVideo, MjpegParser, VideoPreview, httpMjpeg } from '../src/transport/video.js';
import { IOSAdapter } from '../src/adapters/ios.js';
import { HarmonyAdapter } from '../src/adapters/harmony.js';
import type { Frame } from '../src/core/types.js';

const part = (bytes: Buffer) =>
  Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`),
    bytes,
    Buffer.from('\r\n'),
  ]);
const jpeg = async (width = 180, height = 360) =>
  sharp({ create: { width, height, channels: 3, background: '#abc' } })
    .jpeg()
    .toBuffer();

test('MJPEG parses arbitrary chunk boundaries and rejects corrupt or oversized frames', async () => {
  const a = await jpeg(),
    b = await jpeg(90, 180);
  const wire = Buffer.concat([part(a), Buffer.from('\r\n'), part(b)]),
    parsed: Buffer[] = [],
    parser = new MjpegParser();
  for (let i = 0; i < wire.length; i += 7)
    parser.push(wire.subarray(i, i + 7), (b) => parsed.push(b));
  assert.deepEqual(parsed, [a, b]);
  assert.throws(() => new MjpegParser(10).push(part(a), () => {}), /length/);
  assert.throws(() => new MjpegParser().push(Buffer.alloc(16_385), () => {}), /headers/);
  assert.throws(() => new MjpegParser().push(part(Buffer.from('not jpeg')), () => {}), /JPEG/);
});

test('a video reader coalesces consumers, keeps one latest frame, and aborts on lease expiry', async () => {
  let starts = 0,
    stopped = false,
    send: ((chunk: Uint8Array) => void) | undefined;
  const video = new LatestVideo(async (signal, receive) => {
    starts++;
    send = receive;
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          stopped = true;
          resolve();
        },
        { once: true },
      ),
    );
  }, 40);
  const a = await jpeg(),
    b = await jpeg(90, 180);
  try {
    assert.equal(video.latest(), undefined);
    send!(part(a));
    const first = video.latest();
    send!(part(b));
    assert.deepEqual(video.latest()?.bytes, b);
    assert.notEqual(video.latest(), first);
    assert.equal(starts, 1);
    await delay(80);
    assert.equal(stopped, true);
    // A late callback from the previous producer must not repopulate the cache.
    send!(part(a));
    assert.equal(video.latest(), undefined);
  } finally {
    video.stop();
  }
});

test('video geometry preserves native input units and falls back when the aspect changes', async () => {
  let send: ((chunk: Uint8Array) => void) | undefined;
  const video = new LatestVideo(async (signal, receive) => {
    send = receive;
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  const preview = new VideoPreview(video, 'wda-mjpeg');
  let captures = 0;
  const native: Frame = {
    bytes: Buffer.alloc(0),
    mimeType: 'image/png',
    display: {
      id: '0',
      width: 1170,
      height: 2340,
      inputWidth: 390,
      inputHeight: 780,
      rotation: 0,
      posture: 'unknown',
    },
  };
  const capture = async () => {
    captures++;
    return native;
  };
  try {
    preview.remember(native.display);
    assert.equal(await preview.frame(capture), undefined);
    send!(part(await jpeg()));
    const frame = await preview.frame(capture);
    assert.equal(captures, 0);
    assert.equal(frame?.display.width, 180);
    assert.equal(frame?.display.inputWidth, 390);
    assert.equal(frame?.transport, 'wda-mjpeg');
    assert.equal(await preview.frame(capture), frame);
    send!(part(await jpeg(360, 180)));
    assert.equal(await preview.frame(capture), undefined);
  } finally {
    preview.stop();
  }
});

test('a frame received before a viewport change cannot be relabeled with the new orientation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let send!: (chunk: Uint8Array) => void;
  const video = new LatestVideo(async (signal, receive) => {
    send = receive;
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  const preview = new VideoPreview(video, 'scrcpy');
  const display = {
    id: '0',
    width: 360,
    height: 720,
    inputWidth: 360,
    inputHeight: 720,
    rotation: 0,
    posture: 'unknown' as const,
  };
  const capture = async () => {
    throw new Error('geometry is already known');
  };
  try {
    preview.remember(display);
    await preview.frame(capture);
    const bytes = await jpeg();
    send(part(bytes));
    assert.equal((await preview.frame(capture))?.display.rotation, 0);
    t.mock.timers.tick(10);
    preview.remember({ ...display, rotation: 180 });
    assert.equal(await preview.frame(capture), undefined);
    send(part(bytes));
    assert.equal((await preview.frame(capture))?.display.rotation, 180);
  } finally {
    preview.stop();
  }
});

test('HTTP MJPEG cancels its body when parsing fails and never follows redirects', async () => {
  let cancelled = false;
  const request = (async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(Buffer.from('bad'));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  }) as typeof fetch;
  await assert.rejects(
    httpMjpeg('http://localhost:9100', request)(new AbortController().signal, () => {
      throw new Error('bad frame');
    }),
    /bad frame/,
  );
  assert.equal(cancelled, true);
});

test('network video and WDA endpoints require explicit opt-in and reject URL credentials', () => {
  assert.throws(
    () =>
      new IOSAdapter([
        { name: 'phone', url: 'http://127.0.0.1:8100', mjpegUrl: 'http://192.168.1.10:9100' },
      ]),
    { code: 'CONFIG_ERROR' },
  );
  assert.doesNotThrow(
    () => new IOSAdapter([{ name: 'phone', url: 'http://192.168.1.10:8100', allowRemote: true }]),
  );
  assert.throws(
    () =>
      new IOSAdapter([{ name: 'phone', url: 'http://user:pass@192.168.1.10', allowRemote: true }]),
    { code: 'CONFIG_ERROR' },
  );
  const devices = [
    { deviceId: 'harmonyos:usb', url: 'http://192.168.1.10:27183/stream', token: 'a'.repeat(32) },
  ];
  assert.throws(() => new HarmonyAdapter({ video: { ffmpeg: 'ffmpeg', devices } }), {
    code: 'CONFIG_ERROR',
  });
  assert.doesNotThrow(
    () =>
      new HarmonyAdapter({
        video: { ffmpeg: 'ffmpeg', devices: devices.map((d) => ({ ...d, allowRemote: true })) },
      }),
  );
});
