import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrcpyParser, EncodedVideo } from '../src/transport/encoded-video.js';
import { touchPacket, scrcpyAction } from '../src/transport/scrcpy-control.js';
import type { Socket } from 'node:net';

const session = (w = 1080, h = 2400) => {
  const b = Buffer.alloc(12);
  b[0] = 0x80;
  b.writeUInt32BE(w, 4);
  b.writeUInt32BE(h, 8);
  return b;
};
const packet = (bytes: Buffer, config = false, key = false, pts = 12345) => {
  const b = Buffer.alloc(12);
  b.writeBigUInt64BE(BigInt(pts) | (config ? 1n << 62n : 0n) | (key ? 1n << 61n : 0n), 0);
  b.writeUInt32BE(bytes.length, 8);
  return Buffer.concat([b, bytes]);
};
const config = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x32, 0, 0, 0, 1, 0x68, 0]);

test('native packet parser handles fragmented headers, timestamps and rotation sessions', () => {
  const parser = new ScrcpyParser(),
    sizes: number[][] = [],
    frames: any[] = [];
  const bytes = Buffer.concat([
    Buffer.from('h264'),
    session(),
    packet(config, true),
    packet(Buffer.from([1, 2, 3]), false, true, 90001),
    session(2400, 1080),
  ]);
  for (const byte of bytes)
    parser.push(
      Buffer.from([byte]),
      (w, h) => sizes.push([w, h]),
      (b, pts, config, key) => frames.push({ bytes: [...b], pts, config, key }),
    );
  assert.deepEqual(sizes, [
    [1080, 2400],
    [2400, 1080],
  ]);
  assert.equal(frames[0].config, true);
  assert.deepEqual(frames[1], { bytes: [1, 2, 3], pts: 90001, config: false, key: true });
  assert.throws(
    () =>
      new ScrcpyParser().push(
        Buffer.from('hevc'),
        () => {},
        () => {},
      ),
    /Expected H.264/,
  );
  const invalid = Buffer.alloc(12);
  invalid.writeUInt32BE(5 * 1024 * 1024, 8);
  assert.throws(
    () =>
      new ScrcpyParser().push(
        Buffer.concat([Buffer.from('h264'), invalid]),
        () => {},
        () => {},
      ),
    /packet length/,
  );
});

test('native consumers restart at a keyframe, keep dependencies and stop at lease expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let receive!: (bytes: Uint8Array) => void,
    aborted = false;
  const video = new EncodedVideo(async (signal, send) => {
    receive = send;
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
  });
  try {
    assert.equal(video.read(), undefined);
    receive(
      Buffer.concat([
        Buffer.from('h264'),
        session(),
        packet(config, true),
        packet(Buffer.from([0x65]), false, true),
        packet(Buffer.from([0x41])),
      ]),
    );
    const first = video.read()!;
    assert.equal(first.codec, 'avc1.42c032');
    assert.equal(first.reset, true);
    assert.equal(first.packets.length, 2);
    assert.deepEqual(first.packets[0]!.bytes, Buffer.concat([config, Buffer.from([0x65])]));
    assert.equal(
      video.read(first.packets[1]!.sequence)!.packets.length,
      0,
      'static content keeps the connection without replaying pixels',
    );
    const old = first.packets[0]!.sequence;
    receive(packet(Buffer.from([0x65]), false, true));
    assert.equal(video.read(old)!.reset, true);
    // Overflow discards the entire dependency chain, then waits for a new IDR.
    for (let i = 0; i < 181; i++) receive(packet(Buffer.from([0x41])));
    assert.equal(video.read(), undefined);
    receive(packet(Buffer.from([0x65]), false, true));
    assert.equal(video.read()!.packets[0]!.key, true);
    receive(session(2400, 1080));
    assert.equal(video.read(), undefined);
    receive(Buffer.concat([packet(config, true), packet(Buffer.from([0x65]), false, true)]));
    assert.equal(video.read()!.width, 2400);
    t.mock.timers.tick(5001);
    assert.equal(aborted, true);
  } finally {
    video.stop();
  }
});

test('native touches use driver pixels and partial writes are uncertain, never replayed', async () => {
  const touch = touchPacket(0, 100, 200, 1080, 2400);
  assert.equal(touch.length, 32);
  assert.equal(touch[0], 2);
  assert.equal(touch.readBigInt64BE(2), -2n);
  assert.equal(touch.readUInt32BE(10), 100);
  assert.equal(touch.readUInt16BE(20), 2400);
  assert.equal(touch.readUInt16BE(22), 65535);
  const frames: Buffer[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write(bytes: Buffer, callback: (error?: Error) => void) {
      frames.push(bytes);
      callback();
    },
  } as unknown as Socket;
  assert.equal(await scrcpyAction(socket, { kind: 'tap', x: 100, y: 200 }, 1080, 2400), true);
  assert.deepEqual(
    frames.map((b) => b[1]),
    [0, 1],
  );
  const broken = {
    ...socket,
    write(_bytes: Buffer, callback: (error?: Error) => void) {
      callback(new Error('connection lost'));
    },
  } as unknown as Socket;
  await assert.rejects(scrcpyAction(broken, { kind: 'tap', x: 1, y: 1 }, 1080, 2400), {
    code: 'ACTION_UNCERTAIN',
    uncertain: true,
  });
});
