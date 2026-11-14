import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { Fmp4Video } from '../src/transport/fmp4-video.js';
import { ScrcpyParser, EncodedVideo, VideoChoice } from '../src/transport/encoded-video.js';
import {
  AndroidEmulator,
  discoverEmulator,
  emulatorAction,
} from '../src/transport/android-emulator.js';
import { IOSSimulatorControl, idbEvents } from '../src/transport/ios-simulator.js';
import { PhoneError } from '../src/core/errors.js';
import { feedRawFrames } from '../src/transport/host-video.js';
import { setTimeout as delay } from 'node:timers/promises';
import { noReorderSps } from '../src/transport/h264-latency.js';

const fixture = (name: string) => readFile(resolve('tests/fixtures', name));
test('an invalid first emulator frame closes its stream before any encoder starts', async () => {
  let returned = false,
    closed = false;
  const emulator = new AndroidEmulator('emulator-5582', {
    sdkRoot: '/missing',
    ffmpeg: '/missing',
  });
  emulator.connection = async () => ({
    call: async () => ({}),
    close: () => {
      closed = true;
    },
    async *frames() {
      try {
        yield { format: { width: 1080, height: 2400, format: 2 }, image: Buffer.alloc(1) };
      } finally {
        returned = true;
      }
    },
  });
  await assert.rejects(
    () => emulator.video(new AbortController().signal, () => {}),
    /Invalid emulator RGB frame/,
  );
  assert.equal(returned, true);
  // The mocked connection has no cached client; producer cleanup must still close the iterator.
  assert.equal(closed, false);
});
test('a VideoToolbox frame decodes in Chrome without future frames or decoder.flush', async (t) => {
  const executable =
    process.env.PHONE_USE_CHROME ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');
  try {
    await access(executable);
  } catch {
    t.skip('Set PHONE_USE_CHROME to run the decoder test.');
    return;
  }
  const source = await fixture('green-videotoolbox.mp4');
  const avc = source.indexOf('avcC'),
    length = source.readUInt16BE(avc + 10);
  const sps = source.subarray(avc + 12, avc + 12 + length),
    rewritten = noReorderSps(sps);
  assert.notDeepEqual(sps, rewritten, 'fixture must reproduce omitted reorder constraints');
  assert.deepEqual(noReorderSps(rewritten), rewritten);
  assert.throws(() => noReorderSps(sps.subarray(0, 5)));
  assert.throws(() => noReorderSps(Buffer.from([8, 0, 0, 0, 0])));
  const video = new EncodedVideo(async (signal, receive) => {
    const parser = new Fmp4Video(receive, true);
    parser.push(source);
    parser.finish();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  video.read();
  const batch = video.read(0)!;
  video.stop();
  assert.ok(batch.packets[0]?.key);
  const host = createServer((_req, res) => res.end('<!doctype html><canvas></canvas>'));
  await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: executable, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(host.address() as any).port}`);
    const pixel = await page.evaluate(
      ({ codec, bytes }) =>
        new Promise<number[]>((resolve, reject) => {
          const timer = setTimeout(() => {
            decoder.close();
            reject(new Error('A static host frame stayed buffered'));
          }, 2000);
          const decoder = new VideoDecoder({
            error: (e) => {
              clearTimeout(timer);
              reject(e);
            },
            output: (frame) => {
              clearTimeout(timer);
              const canvas = document.querySelector('canvas')!;
              canvas.width = frame.displayWidth;
              canvas.height = frame.displayHeight;
              const context = canvas.getContext('2d')!;
              context.drawImage(frame, 0, 0);
              frame.close();
              decoder.close();
              resolve(Array.from(context.getImageData(20, 20, 1, 1).data));
            },
          });
          decoder.configure({
            codec,
            optimizeForLatency: true,
            hardwareAcceleration: 'no-preference',
          });
          decoder.decode(
            new EncodedVideoChunk({ type: 'key', timestamp: 0, data: new Uint8Array(bytes) }),
          );
        }),
      { codec: batch.codec, bytes: [...batch.packets[0]!.bytes] },
    );
    assert.ok(pixel[1]! > 100 && pixel[0]! < 10 && pixel[2]! < 10, `Expected green, got ${pixel}`);
  } finally {
    await browser.close();
    await new Promise<void>((r) => host.close(() => r()));
  }
});
test('a static emulator image drains a delayed encoder and then stops repeating input', async () => {
  const writes: number[] = [],
    controller = new AbortController();
  let next!: (result: IteratorResult<number>) => void;
  const feed = feedRawFrames(
    1,
    {
      next: () =>
        new Promise((resolve) => {
          next = resolve;
        }),
    },
    async (frame) => {
      writes.push(frame);
    },
    () => writes.filter((n) => n === writes.at(-1)).length >= 4,
    controller.signal,
    5,
  );
  await delay(40);
  assert.deepEqual(writes, [1, 1, 1, 1]);
  next({ value: 2, done: false });
  await delay(40);
  assert.deepEqual(writes, [1, 1, 1, 1, 2, 2, 2, 2]);
  controller.abort();
  next({ value: undefined, done: true });
  await feed;
});
function decode(bytes: Buffer, chunkSize = 31) {
  const parser = new ScrcpyParser(),
    sizes: number[][] = [],
    frames: Array<{ pts: number; key: boolean; config: boolean; bytes: Buffer }> = [];
  const demux = new Fmp4Video((chunk) =>
    parser.push(
      chunk,
      (w, h) => sizes.push([w, h]),
      (bytes, pts, config, key) => frames.push({ bytes, pts, config, key }),
    ),
  );
  for (let i = 0; i < bytes.length; i += chunkSize) demux.push(bytes.subarray(i, i + chunkSize));
  demux.finish();
  return { sizes, frames };
}
test('real fragmented H.264 samples preserve keyframes, PTS and repeated initialization after rotation', async () => {
  const portrait = await fixture('green-fragmented.mp4'),
    landscape = await fixture('green-landscape.mp4');
  const { sizes, frames } = decode(Buffer.concat([portrait, landscape]), 7);
  assert.deepEqual(sizes, [
    [360, 720],
    [720, 360],
  ]);
  const video = frames.filter((f) => !f.config);
  assert.deepEqual(
    video.map((f) => f.pts),
    [0, 16667, 33333, 0, 16667, 33333],
  );
  assert.deepEqual(
    video.map((f) => f.key),
    [true, false, true, true, false, true],
  );
  assert.equal(frames.filter((f) => f.config).length, 2);
  assert.ok(frames.every((f) => f.bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))));
});
test('fragmented video rejects malicious lengths, invalid sample offsets and incomplete frames', async () => {
  const bytes = await fixture('green-fragmented.mp4');
  const invalid = Buffer.from(bytes);
  invalid.writeUInt32BE(0x7fffffff, 0);
  assert.throws(() => decode(invalid), /oversized/);
  const badOffset = Buffer.from(bytes),
    trun = badOffset.indexOf('trun');
  assert.ok(trun > 0);
  badOffset.writeInt32BE(1, trun + 12);
  assert.throws(() => decode(badOffset), /out of bounds/);
  const mdat = bytes.indexOf('mdat');
  assert.ok(mdat > 0);
  assert.throws(() => decode(bytes.subarray(0, mdat + 10)), /Truncated/);
});
test('source switching resets a high old cursor and decoder epoch', async () => {
  const streams = [0, 1].map(() => {
    let feed!: (bytes: Uint8Array) => void;
    const video = new EncodedVideo(async (signal, receive) => {
      feed = receive;
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    });
    video.read();
    return { video, feed: (bytes: Uint8Array) => feed(bytes) };
  });
  try {
    const bytes = await fixture('green-fragmented.mp4');
    for (const stream of streams) {
      const parser = new Fmp4Video(stream.feed);
      parser.push(bytes);
      parser.finish();
    }
    const choice = new VideoChoice();
    const fallback = choice.read([{ name: 'scrcpy', video: streams[0]!.video }], 10000)!;
    assert.equal(fallback.reset, true);
    assert.ok(fallback.packets.length);
    const native = choice.read([{ name: 'android-emulator', video: streams[1]!.video }], 10000)!;
    assert.equal(native.reset, true);
    assert.ok(native.packets.length);
    assert.ok(native.epoch > fallback.epoch);
  } finally {
    for (const s of streams) s.video.stop();
  }
});
test('emulator discovery binds exact console port and refuses endpoints without credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pu-grpc-test-'));
  try {
    const file = join(directory, `pid_${process.pid}.ini`);
    await writeFile(file, 'port.serial=5582\ngrpc.port=8558\navd.id=Owned\n');
    assert.equal(await discoverEmulator('emulator-5582', directory), undefined);
    await writeFile(
      file,
      'port.serial=5582\ngrpc.port=8558\navd.id=Owned\ngrpc.token=private-test-value\n',
    );
    assert.equal(await discoverEmulator('emulator-5554', directory), undefined);
    assert.equal(await discoverEmulator('192.168.1.8:5555', directory), undefined);
    assert.equal((await discoverEmulator('emulator-5582', directory))?.avd, 'Owned');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('emulator touch failure releases the finger without replaying down or falling back', async () => {
  const calls: any[] = [];
  const link = {
    call: async (name: string, value: any) => {
      calls.push({ name, value });
      if (calls.length === 2) throw new Error('link failed');
    },
    close() {},
  };
  const emulator = new AndroidEmulator('emulator-5582', {
    sdkRoot: '/missing',
    ffmpeg: '/missing',
  });
  emulator.connection = async () => link as any;
  await assert.rejects(
    () => emulator.execute({ kind: 'swipe', x: 10, y: 20, toX: 20, toY: 40, durationMs: 1 }),
    (e: any) => e instanceof PhoneError && e.uncertain,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[0].value.touches[0].pressure, 1024);
  assert.equal(calls[2].value.touches[0].pressure, 0);
  const keys: any[] = [];
  await emulatorAction(
    { call: async (_name, value) => keys.push(value) },
    { kind: 'key', key: 'home' },
  );
  assert.deepEqual(keys, [{ key: 'GoHome', eventType: 2 }]);
});
test('iOS preview keeps its idle input companion warm without a request per frame or during a gesture', async () => {
  const control = new IOSSimulatorControl({
    udid: '00000000-0000-4000-8000-000000000001',
    deviceSetPath: '/fixture',
    simVideo: '/fixture/sim-video',
  });
  let requests = 0;
  let complete!: (error?: Error) => void;
  const link = {
    child: { exitCode: null, signalCode: null },
    lastKeepAliveAt: Date.now() - 20_001,
    client: {
      describe(_request: unknown, options: { deadline: number }, callback: typeof complete) {
        requests++;
        assert.ok(options.deadline <= Date.now() + 3000, 'keep-alive must have a bounded deadline');
        complete = callback;
      },
    },
  };
  const internal = control as any;
  internal.link = link;
  assert.equal(control.pointerReady, true);
  internal.link.child.signalCode = 'SIGTERM';
  assert.equal(control.pointerReady, false, 'a signalled child cannot advertise native input');
  internal.link.child.signalCode = null;
  const frames = Array.from({ length: 100 }, () => control.warmup());
  await Promise.resolve();
  assert.equal(requests, 1, 'simultaneous preview frames share one keep-alive');
  complete();
  await Promise.all(frames);
  await control.warmup();
  assert.equal(requests, 1, 'normal video frames do not each send a request');
  link.lastKeepAliveAt = Date.now() - 20_001;
  internal.pointerStream = {};
  await control.warmup();
  assert.equal(requests, 1, 'an active HID stream already prevents idle shutdown');
  internal.pointerStream = undefined;
  const next = control.warmup();
  await Promise.resolve();
  assert.equal(requests, 2);
  complete(new Error('connection lost'));
  await next;
  await control.warmup();
  assert.equal(requests, 2, 'a failed keep-alive cannot cause a per-frame retry loop');
});
test('idb input preserves point coordinates and failed submission never becomes a WDA retry', async () => {
  const events = idbEvents({
    kind: 'swipe',
    x: 20,
    y: 200,
    toX: 20,
    toY: 60,
    durationMs: 220,
  })! as any[];
  assert.equal(events[0].swipe.duration, 0.22);
  assert.deepEqual(events[0].swipe.end, { x: 20, y: 60 });
  const control = new IOSSimulatorControl({
    udid: 'BE30D744-3D5F-4797-B946-3ED0F9F8E2CE',
    simVideo: '/missing',
    deviceSetPath: '/missing',
  });
  const submitted: any[] = [];
  (control as any).connection = async () => ({
    client: {
      hid(_options: any, callback: (e: Error) => void) {
        const stream = new EventEmitter() as any;
        stream.write = (event: any) => submitted.push(event);
        stream.end = () => callback(new Error('uncertain'));
        stream.cancel = () => {};
        return stream;
      },
    },
  });
  control.close = async () => {};
  await assert.rejects(
    () => control.execute({ kind: 'tap', x: 13, y: 29 }),
    (e: any) => e instanceof PhoneError && e.uncertain,
  );
  assert.equal(submitted.filter((e) => e.press?.direction === 0).length, 1);
  assert.equal(submitted.at(-1).press.direction, 1);
  assert.equal(await control.execute({ kind: 'text', text: 'hello' }), false);
});
