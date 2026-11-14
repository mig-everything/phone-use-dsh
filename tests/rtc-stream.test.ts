import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import {
  RtcPreviewServer,
  RtcSocket,
  RTC_FRAGMENT_MAGIC,
  RTC_FRAGMENT_BYTES,
  RTC_MAX_FRAME,
  type PreviewSocket,
} from '../src/transport/rtc-stream.js';
import { panelStream } from '../src/transport/panel-stream.js';
import { PhoneService } from '../src/core/service.js';
import { Fleet } from './fleet.js';

class BufferedChannel extends EventEmitter {
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly packets: (string | Buffer)[] = [];
  send(data: string | Buffer) {
    this.packets.push(data);
    this.bufferedAmount += Buffer.byteLength(data);
  }
  drain() {
    this.bufferedAmount = 0;
    this.emit('bufferedamountlow');
  }
}

test('RTC bounds pending sends, resumes on drain and preserves control/frame order', async () => {
  const channel = new BufferedChannel();
  const socket = new RtcSocket(channel as unknown as RTCDataChannel, () => {});
  const first = Buffer.alloc(1024 * 1024 + 31, 0x51);
  const expected = Buffer.from(first);
  const second = Buffer.alloc(RTC_FRAGMENT_BYTES + 13, 0x72);
  try {
    socket.send('before');
    socket.send(first);
    socket.send('between');
    socket.send(second);
    socket.send('after');
    first.fill(0); // Sending retains its own frame while the caller reuses its buffer.
    assert.ok(socket.bufferedAmount > 1024 * 1024, 'producer sees queued data, not only SCTP');
    await tick();
    assert.ok(channel.packets.length > 0);
    assert.ok(channel.bufferedAmount <= 64 * 1024);
    const pausedAt = channel.packets.length;
    await tick();
    assert.equal(channel.packets.length, pausedAt, 'do not keep pushing into a blocked channel');
    let drains = 0;
    while (socket.bufferedAmount) {
      assert.ok(drains++ < 100, 'all queued messages must resume');
      assert.ok(channel.bufferedAmount <= 64 * 1024);
      channel.drain();
      await tick();
    }
    assert.deepEqual(
      channel.packets.filter((packet) => typeof packet === 'string'),
      ['before', 'between', 'after'],
    );
    const groups: Buffer[][] = [[], []];
    let group = -1;
    for (const packet of channel.packets) {
      if (typeof packet === 'string') {
        group++;
        continue;
      }
      assert.equal(packet.readUInt32BE(0), RTC_FRAGMENT_MAGIC);
      assert.equal(packet.readUInt32BE(4), group === 0 ? expected.length : second.length);
      assert.equal(packet.readUInt32BE(8), groups[group]!.length * RTC_FRAGMENT_BYTES);
      groups[group]!.push(packet.subarray(12));
    }
    assert.deepEqual(Buffer.concat(groups[0]!), expected);
    assert.deepEqual(Buffer.concat(groups[1]!), second);
  } finally {
    socket.close();
  }
});

test('RTC cancels queued work on close, rejects overflow and closes after send errors', async () => {
  const cases = ['close', 'queued-limit', 'frame-limit', 'message-limit', 'send-error'] as const;
  for (const mode of cases) {
    const channel = new BufferedChannel();
    let disposed = 0;
    const socket = new RtcSocket(channel as unknown as RTCDataChannel, () => disposed++);
    try {
      if (mode === 'close') {
        socket.send(Buffer.alloc(1024 * 1024));
        socket.close();
      } else if (mode === 'queued-limit') {
        socket.send(Buffer.alloc(RTC_MAX_FRAME));
        socket.send(Buffer.alloc(RTC_MAX_FRAME));
      } else if (mode === 'frame-limit') {
        socket.send(Buffer.alloc(RTC_MAX_FRAME + 1));
      } else if (mode === 'message-limit') {
        for (let i = 0; i < 1025; i++) socket.send('');
      } else {
        channel.send = () => {
          throw new Error('Channel closed during send');
        };
        socket.send(Buffer.alloc(1024 * 1024));
      }
      await tick();
      channel.drain();
      socket.send('ignored');
      await tick();
      assert.equal(socket.readyState, 3, mode);
      assert.equal(socket.bufferedAmount, 0, mode);
      assert.equal(channel.packets.length, 0, mode);
      assert.equal(channel.listenerCount('bufferedamountlow'), 0, mode);
      socket.close();
      assert.equal(disposed, 1, mode);
    } finally {
      socket.close();
    }
  }
});

async function until(
  check: () => boolean,
  {
    phase = 'RTC condition',
    timeoutMs = 7000,
    progress,
    diagnostics,
  }: {
    phase?: string;
    timeoutMs?: number;
    progress?: () => number;
    diagnostics?: () => Record<string, unknown>;
  } = {},
) {
  const started = Date.now();
  let changedAt = started,
    previous = progress?.();
  while (!check()) {
    const now = Date.now(),
      current = progress?.();
    if (current !== previous) {
      previous = current;
      changedAt = now;
    }
    const elapsedMs = now - started,
      idleMs = now - changedAt;
    const reason =
      idleMs >= 7000
        ? 'stalled for 7000 ms'
        : elapsedMs >= timeoutMs
          ? 'total deadline'
          : undefined;
    if (reason)
      throw new Error(
        `${phase}: ${reason}; ${JSON.stringify({ elapsedMs, idleMs, ...diagnostics?.() })}`,
      );
    await delay(10);
  }
}

test('RTC transfer wait allows progress but still bounds stalls and total duration', async (t) => {
  for (const mode of ['progress', 'stall', 'deadline']) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    try {
      let bytes = 0,
        complete = false;
      const result = until(() => complete, {
        phase: 'media transfer',
        timeoutMs: 20000,
        progress: () => bytes,
        diagnostics: () => ({ bytes }),
      }).then(
        () => 'complete',
        (error: Error) => error.message,
      );
      if (mode === 'stall') {
        t.mock.timers.tick(7000);
        await tick();
        assert.match(await result, /media transfer: stalled for 7000 ms.*"bytes":0/);
      } else {
        for (let i = 0; i < (mode === 'progress' ? 3 : 4); i++) {
          bytes++;
          t.mock.timers.tick(6000);
          await tick();
        }
        if (mode === 'progress') {
          complete = true;
          t.mock.timers.tick(10);
          await tick();
          assert.equal(await result, 'complete', 'ongoing progress may exceed seven seconds');
        } else {
          assert.match(await result, /media transfer: total deadline.*"elapsedMs":24000/);
        }
      }
    } finally {
      t.mock.timers.reset();
    }
  }
});
function peer() {
  return new RTCPeerConnection({
    // Test offerer is full ICE; explicitly replace werift's default STUN fallback
    // with a loopback discard port. Production browser uses iceServers: [].
    iceServers: [{ urls: 'stun:127.0.0.1:9' }],
    iceStunGatherTimeout: 0.001,
    iceUseIpv4: false,
    iceUseIpv6: false,
    iceUseTcp: false,
    iceAdditionalHostAddresses: ['127.0.0.1'],
    iceInterfaceAddresses: { udp4: '127.0.0.1' },
  });
}

test(
  'local RTC authenticates, scopes devices, fragments media and releases sockets without TLS configuration',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phone-use-rtc-'));
    const service = new PhoneService([new Fleet(2)], dir);
    const stream = panelStream(service),
      pc = peer();
    const channel = pc.createDataChannel('phone-use', { ordered: true });
    const messages: any[] = [],
      frames: Buffer[] = [];
    let frame: Buffer | undefined,
      received = 0;
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') return void messages.push(JSON.parse(data));
      assert.equal(data.readUInt32BE(0), RTC_FRAGMENT_MAGIC);
      assert.ok(data.length <= RTC_FRAGMENT_BYTES + 12);
      const total = data.readUInt32BE(4),
        offset = data.readUInt32BE(8);
      assert.equal(offset, received);
      frame ??= Buffer.alloc(total);
      data.copy(frame, offset, 12);
      received += data.length - 12;
      if (received === total) {
        frames.push(frame);
        frame = undefined;
        received = 0;
      }
    };
    try {
      const own = await service.open('demo:phone-1', 'A');
      const other = await service.open('demo:phone-2', 'B');
      await pc.setLocalDescription(await pc.createOffer());
      const config = await stream.rtcAnswer(service.panel('A'), pc.localDescription!.sdp);
      assert.equal('url' in config, false);
      assert.equal(config.transport, 'webrtc');
      const candidates = config.answer.sdp
        .split('\r\n')
        .filter((l) => l.startsWith('a=candidate:'));
      assert.equal(candidates.length, 1);
      assert.match(candidates[0]!, / udp \d+ 127\.0\.0\.1 \d+ typ host/);
      await pc.setRemoteDescription(config.answer);
      await until(() => channel.readyState === 'open', { phase: 'open preview channel' });
      channel.send(JSON.stringify({ type: 'hello', token: config.token }));
      await until(() => messages.some((m) => m.type === 'ready'), {
        phase: 'authenticate preview',
      });
      channel.send(
        JSON.stringify({
          type: 'view',
          quality: 'grid',
          sessions: [own.session_id, other.session_id],
        }),
      );
      await until(() => frames.length === 1 && messages.some((m) => m.type === 'frame-error'), {
        phase: 'scoped preview frame',
        diagnostics: () => ({ frames: frames.length, received, messages: messages.length }),
      });
      assert.equal(
        JSON.parse(frames[0]!.subarray(4, 4 + frames[0]!.readUInt32BE(0)).toString()).session_id,
        own.session_id,
      );
      await delay(150);
      assert.equal(frames.length, 1, 'one outstanding batch; no frame backlog');
      // A used capability cannot authenticate another connection.
      const replay = peer();
      try {
        const replayChannel = replay.createDataChannel('phone-use', { ordered: true });
        await replay.setLocalDescription(await replay.createOffer());
        const second = await stream.rtcAnswer(service.panel('A'), replay.localDescription!.sdp);
        await replay.setRemoteDescription(second.answer);
        await until(() => replayChannel.readyState === 'open', { phase: 'open replay channel' });
        replayChannel.send(JSON.stringify({ type: 'hello', token: config.token }));
        await until(
          () =>
            replayChannel.readyState === 'closed' ||
            replay.connectionState === 'closed' ||
            replay.connectionState === 'failed',
          { phase: 'reject reused ticket' },
        );
      } finally {
        await replay.close();
      }
    } finally {
      await pc.close();
      await service.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'RTC transports large media with small ordered chunks, rejects binary input, and ignores remote candidates',
  { timeout: 35000 },
  async (t) => {
    const server = new RtcPreviewServer(),
      pc = peer();
    const channel = pc.createDataChannel('phone-use', { ordered: true });
    let socket: PreviewSocket | undefined;
    const data = Buffer.alloc(2 * 1024 * 1024 + 27);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const received = Buffer.alloc(data.length);
    let offset = 0,
      chunks = 0;
    channel.onmessage = ({ data: packet }) => {
      assert.ok(Buffer.isBuffer(packet));
      assert.equal(packet.readUInt32BE(0), RTC_FRAGMENT_MAGIC);
      assert.equal(packet.readUInt32BE(4), data.length);
      assert.equal(packet.readUInt32BE(8), offset);
      assert.ok(packet.length <= RTC_FRAGMENT_BYTES + 12);
      packet.copy(received, offset, 12);
      offset += packet.length - 12;
      chunks++;
    };
    try {
      await assert.rejects(
        server.answer('m=audio 9 UDP/TLS/RTP/SAVPF 111', () => {}),
        { code: 'INVALID_ARGUMENT' },
      );
      assert.equal(server.size, 0);
      await pc.setLocalDescription(await pc.createOffer());
      const offer = pc.localDescription!.sdp.replace(
        'a=end-of-candidates',
        'a=candidate:999 1 udp 1 untrusted.invalid 12345 typ host\r\na=end-of-candidates',
      );
      const answer = await server.answer(offer, (s) => {
        socket = s;
      });
      await pc.setRemoteDescription(answer);
      await until(() => Boolean(socket), { phase: 'accept media channel' });
      const started = performance.now();
      socket!.send(data);
      // This is a correctness test, not a seven-second throughput benchmark on
      // a shared runner. Keep the same no-progress limit and a hard total cap.
      await until(() => offset === data.length, {
        phase: 'large media transfer',
        timeoutMs: 20000,
        progress: () => offset,
        diagnostics: () => ({
          received: offset,
          expected: data.length,
          chunks,
          pending: socket!.bufferedAmount,
          socket: socket!.readyState,
          channel: channel.readyState,
          connection: pc.connectionState,
        }),
      });
      t.diagnostic(
        `RTC media: ${offset} bytes, ${chunks} fragments, ${Math.round(performance.now() - started)} ms`,
      );
      assert.ok(chunks > 100);
      assert.equal(
        createHash('sha256').update(received).digest('hex'),
        createHash('sha256').update(data).digest('hex'),
      );
      channel.send(Buffer.from([1]));
      await until(() => server.size === 0, { phase: 'reject binary input' });
    } finally {
      await pc.close();
      await server.close();
    }
  },
);

test(
  'RTC validates peer certificate fingerprints before accepting data',
  { timeout: 20000 },
  async () => {
    const server = new RtcPreviewServer(),
      pc = peer();
    pc.createDataChannel('phone-use', { ordered: true });
    let accepted = false;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      const offer = pc.localDescription!.sdp.replace(
        /a=fingerprint:sha-256 .+/,
        `a=fingerprint:sha-256 ${Array(32).fill('00').join(':')}`,
      );
      const answer = await server.answer(offer, () => {
        accepted = true;
      });
      await pc.setRemoteDescription(answer);
      await until(() => server.size === 0, { phase: 'reject mismatched certificate' });
      assert.equal(accepted, false);
    } finally {
      await pc.close();
      await server.close();
    }
  },
);
