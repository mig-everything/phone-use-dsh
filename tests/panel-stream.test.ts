import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { PhoneService } from '../src/core/service.js';
import { panelStream } from '../src/transport/panel-stream.js';
import { Fleet } from './fleet.js';
import type { Device } from '../src/core/types.js';
import { previewCertificate } from './tls.js';

test('negotiated frame windows remove per-frame round trips while retaining a hard bound', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-frame-window-'));
  class VideoFleet extends Fleet {
    sequence = 0;
    encodedVideo() {
      const sequence = ++this.sequence;
      return {
        codec: 'avc1.42c01e',
        width: 360,
        height: 720,
        epoch: 1,
        capturedAt: new Date().toISOString(),
        reset: false,
        packets: [{ sequence, timestamp: sequence * 16667, key: true, bytes: Buffer.from([1]) }],
      };
    }
  }
  const service = new PhoneService([new VideoFleet(1)], dir);
  let ws: WebSocket | undefined;
  try {
    const { session_id } = await service.open('demo:phone-1');
    const ticket = await panelStream(service).ticket(service.panel());
    ws = new WebSocket(ticket.url);
    const frames: any[] = [];
    ws.on('message', (raw, binary) => {
      if (binary) {
        const bytes = raw as Buffer;
        frames.push(JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString()));
      }
    });
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', token: ticket.token }));
    await ready;
    const send = (value: unknown) => ws!.send(JSON.stringify(value));
    send({ type: 'view', sessions: [session_id], quality: 'focus', video: true, frame_window: 4 });
    const until = async (count: number) => {
      const deadline = Date.now() + 3000;
      while (frames.length < count && Date.now() < deadline) await delay(10);
      assert.equal(frames.length, count);
    };
    await until(4);
    await delay(150);
    assert.equal(frames.length, 4, 'an unresponsive consumer cannot grow a frame backlog');
    send({
      type: 'ack',
      session_id,
      observation_id: ticket.token.slice(0, 8) + '-0000-4000-8000-000000000000',
    });
    await delay(80);
    assert.equal(frames.length, 4, 'unknown acknowledgements do not grant credit');
    send({ type: 'ack', session_id, observation_id: frames[2].observation.id });
    await until(5);
    send({ type: 'ack', session_id, observation_id: frames[2].observation.id });
    await delay(80);
    assert.equal(frames.length, 5, 'duplicate acknowledgements do not grant credit');
    send({ type: 'ack', session_id, observation_id: frames[0].observation.id });
    await until(6);
  } finally {
    ws?.terminate();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('encrypted preview validates TLS and retains single-use authentication and loopback host checks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-stream-tls-'));
  const tls = await previewCertificate(dir);
  const service = new PhoneService([new Fleet()], dir, undefined, undefined, undefined, { tls });
  const stream = panelStream(service);
  let ws: WebSocket | undefined;
  try {
    const ticket = await stream.ticket(service.panel());
    assert.match(ticket.url, /^wss:\/\/127\.0\.0\.1:\d+\/phone-use$/);
    const untrusted = new WebSocket(ticket.url);
    const error = await new Promise<Error>((resolve) => untrusted.once('error', resolve));
    assert.match(error.message, /self.signed|certificate/i);
    ws = new WebSocket(ticket.url, { ca: tls.ca });
    const ready = once(ws, 'message');
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', token: ticket.token }));
    assert.equal(JSON.parse(String((await ready)[0])).type, 'ready');
    const reused = new WebSocket(ticket.url, { ca: tls.ca });
    const closed = once(reused, 'close');
    await once(reused, 'open');
    reused.send(JSON.stringify({ type: 'hello', token: ticket.token }));
    assert.equal((await closed)[0], 1008);
    const wrongHost = new WebSocket(ticket.url, { ca: tls.ca, headers: { host: 'example.com' } });
    const rejected = await new Promise<Error>((resolve) => wrongHost.once('error', resolve));
    assert.match(rejected.message, /403/);
  } finally {
    ws?.terminate();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid TLS configuration never silently exposes a plaintext listener', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-stream-invalid-tls-'));
  const service = new PhoneService([new Fleet()], dir, undefined, undefined, undefined, {
    tls: { certificate: join(dir, 'missing.pem'), key: join(dir, 'missing-key.pem') },
  });
  try {
    await assert.rejects(panelStream(service).ticket(service.panel()), { code: 'CONFIG_ERROR' });
  } finally {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'static native video renews idle preview input and external actions without extending agent observations',
  { timeout: 10000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'phone-use-static-video-'));
    class NativeFleet extends Fleet {
      async inputDisplay(device: Device) {
        return (await this.capture(device)).display;
      }
      encodedVideo(_device: Device, after: number) {
        return {
          codec: 'avc1.42c01e',
          width: 360,
          height: 720,
          epoch: 1,
          capturedAt: new Date().toISOString(),
          reset: !after,
          packets: after ? [] : [{ sequence: 1, timestamp: 0, key: true, bytes: Buffer.from([1]) }],
        };
      }
    }
    const fleet = new NativeFleet(1),
      service = new PhoneService([fleet], dir, () => Date.now()),
      stream = panelStream(service);
    let ws: WebSocket | undefined;
    try {
      const { session_id: id } = await service.open('demo:phone-1');
      const ticket = await stream.ticket(service.panel());
      ws = new WebSocket(ticket.url);
      const frames: any[] = [];
      const until = async (check: () => boolean) => {
        const end = performance.now() + 5000;
        while (!check()) {
          if (performance.now() > end) throw new Error('Native refresh timed out');
          await delay(10);
        }
      };
      ws.on('message', (raw, binary) => {
        if (binary) {
          const bytes = raw as Buffer,
            m = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString());
          frames.push(m);
          ws!.send(
            JSON.stringify({ type: 'ack', session_id: id, observation_id: m.observation.id }),
          );
        } else if (JSON.parse(raw.toString()).type === 'ready')
          ws!.send(JSON.stringify({ type: 'view', sessions: [id], quality: 'focus', video: true }));
      });
      await once(ws, 'open');
      ws.send(JSON.stringify({ type: 'hello', token: ticket.token }));
      await until(() => frames.length === 1);
      const old = frames[0].observation.id;
      const agent = await service.observe(id, false, 0, 0, 'off');
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.setTime(Date.now() + 35_000);
      ws.send(JSON.stringify({ type: 'view', sessions: [id], quality: 'focus', video: true }));
      await until(() => frames.length === 2);
      assert.notEqual(frames[1].observation.id, old);
      await assert.rejects(
        service.act(
          id,
          {
            kind: 'tap',
            x: 1,
            y: 1,
            observation_id: agent.observation.id,
          },
          false,
        ),
        { code: 'STALE_OBSERVATION' },
      );
      await service.act(
        id,
        {
          kind: 'tap',
          x: 1,
          y: 1,
          observation_id: frames[1].observation.id,
        },
        false,
      );
      await until(() => frames.length === 3);
      await service.act(id, { kind: 'key', key: 'home' }, false);
      await until(() => frames.length === 4);
      assert.notEqual(frames[3].observation.id, old);
      assert.equal(frames[3].observation.input_ready, true);
      await service.act(
        id,
        { kind: 'tap', x: 1, y: 1, observation_id: frames[3].observation.id },
        false,
      );
      assert.equal(fleet.calls.length, 3);
    } finally {
      ws?.terminate();
      await service.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'direct channel scopes tickets, bounds frames, isolates device closure and never replays actions',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phone-use-direct-'));
    const fleet = new Fleet(3),
      service = new PhoneService([fleet], dir),
      stream = panelStream(service);
    const wsList: WebSocket[] = [];
    try {
      const first = await service.open('demo:phone-1', 'A'),
        second = await service.open('demo:phone-2', 'A');
      const other = await service.open('demo:phone-3', 'B');
      const ticket = await stream.ticket(service.panel('A'));
      const ws = new WebSocket(ticket.url);
      wsList.push(ws);
      const frames: any[] = [],
        messages: any[] = [];
      ws.on('message', (data, binary) => {
        if (binary) {
          const b = data as Buffer;
          frames.push(JSON.parse(b.subarray(4, 4 + b.readUInt32BE(0)).toString()));
        } else messages.push(JSON.parse(data.toString()));
      });
      const until = async (check: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!check()) {
          if (Date.now() > deadline) throw new Error('direct-channel timeout');
          await delay(10);
        }
      };
      const send = (data: unknown) => ws.send(JSON.stringify(data));
      await once(ws, 'open');
      send({ type: 'hello', token: ticket.token });
      await until(() => messages.some((m) => m.type === 'ready'));
      const view = (sessions: string[]) => send({ type: 'view', sessions, quality: 'focus' });
      view([first.session_id, second.session_id, other.session_id]);
      await until(() => frames.length === 2);
      await delay(350);
      assert.equal(frames.length, 2, 'unacknowledged consumer gets only one frame per device');
      assert.ok(frames.every((frame) => frame.session_id !== other.session_id));
      assert.ok(
        messages.some((m) => m.type === 'frame-error' && m.session_id === other.session_id),
      );
      assert.equal(
        ws.readyState,
        WebSocket.OPEN,
        'an inaccessible device does not disconnect other boards',
      );
      const selected = frames.find((frame) => frame.session_id === first.session_id);
      send({
        type: 'act',
        id: 1,
        session_id: first.session_id,
        action: {
          kind: 'tap',
          x: 0.5,
          y: 0.5,
          space: 'normalized',
          observation_id: selected.observation.id,
        },
      });
      await until(() => messages.some((m) => m.type === 'result' && m.id === 1));
      assert.equal(fleet.calls.length, 1);
      assert.equal(
        messages.find((m) => m.type === 'result').result.structuredContent.applied,
        true,
      );
      await service.close(first.session_id);
      const secondFrame = frames.find((frame) => frame.session_id === second.session_id);
      send({
        type: 'ack',
        session_id: second.session_id,
        observation_id: secondFrame.observation.id,
      });
      view([first.session_id, second.session_id]);
      await until(() => frames.filter((f) => f.session_id === second.session_id).length >= 2);
      assert.equal(ws.readyState, WebSocket.OPEN);
      const duplicateClosed = once(ws, 'close');
      send({
        type: 'act',
        id: 1,
        session_id: second.session_id,
        action: { kind: 'key', key: 'home' },
      });
      await duplicateClosed;
      assert.equal(fleet.calls.length, 1);
      const reuse = new WebSocket(ticket.url);
      wsList.push(reuse);
      await once(reuse, 'open');
      const rejected = once(reuse, 'close');
      reuse.send(JSON.stringify({ type: 'hello', token: ticket.token }));
      assert.equal((await rejected)[0], 1008, 'bootstrap tickets are single-use');
    } finally {
      for (const ws of wsList) ws.terminate();
      await service.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
