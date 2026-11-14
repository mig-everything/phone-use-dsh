import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { FetchPreviewSocket } from '../src/hosts/dsh/fetch-socket.js';
import { mountDsh } from '../src/hosts/dsh/index.js';
import { PhoneService } from '../src/core/service.js';
import { DemoAdapter } from '../src/adapters/demo.js';
import { HarmonyBridge, HarmonyBridgeDecoder, jpegSize } from '../src/transport/harmony-bridge.js';
import { DeviceShell } from '../src/transport/process.js';

test('DSH and phone tools remain usable when the optional WebRTC module cannot import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-dsh-rtc-failure-'));
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { register } from 'node:module';
      register('data:text/javascript,' + encodeURIComponent(
        "export function resolve(name, context, next) { if (name === 'werift') throw new TypeError('debug is not a function'); return next(name, context); }"
      ), import.meta.url);
      const host = await import(${moduleUrl('../src/hosts/dsh/index.js')});
      assert.equal(typeof host.mountDsh, 'function');
      const { createService } = await import(${moduleUrl('../src/config.js')});
      const { createPhoneTools } = await import(${moduleUrl('../src/tools.js')});
      const { RtcPreviewServer } = await import(${moduleUrl('../src/transport/rtc-stream.js')});
      const service = await createService(true);
      const rtc = new RtcPreviewServer();
      try {
        const catalog = createPhoneTools(service);
        const devices = await catalog.tools.get('phone_devices').execute({}, {scope:'test',signal:new AbortController().signal});
        assert(!devices.isError);
        assert(devices.content.some(c => c.type === 'text' && c.text.includes('demo:foldable')));
        const offer = 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\\r\\na=fingerprint:sha-256 ' + Array(32).fill('AB').join(':');
        await assert.rejects(rtc.answer(offer, () => {}), {code:'RTC_UNAVAILABLE'});
      } finally { await rtc.close(); await service.shutdown(); }
    `,
      ],
      {
        env: { ...process.env, PHONE_USE_STATE_DIR: dir },
        timeout: 15000,
        stdio: 'pipe',
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host Fetch framing is binary, ordered, bounded and abortable', async () => {
  const abort = new AbortController(),
    socket = new FetchPreviewSocket(abort.signal);
  const messages: string[] = [];
  socket.on('message', (b) => messages.push(b.toString()));
  socket.receive(1, 'hello');
  assert.throws(() => socket.receive(1, 'replay'));
  assert.throws(() => socket.receive(3, 'gap'));
  socket.receive(2, 'next');
  assert.deepEqual(messages, ['hello', 'next']);
  socket.send('hello');
  socket.send(Buffer.from([0, 255, 4]));
  assert.equal(socket.bufferedAmount, 18);
  const reader = socket.body.getReader();
  const text = Buffer.from((await reader.read()).value!);
  assert.equal(text[0], 1);
  assert.equal(text.readUInt32BE(1), 5);
  const binary = Buffer.from((await reader.read()).value!);
  assert.equal(binary[0], 2);
  assert.deepEqual([...binary.subarray(5)], [0, 255, 4]);
  assert.equal(socket.bufferedAmount, 0);
  abort.abort();
  assert.equal(socket.readyState, 3);
  assert.equal((await reader.read()).done, true);
  const bounded = new FetchPreviewSocket(new AbortController().signal);
  bounded.send(Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal(bounded.readyState, 3);
});

test('DSH tools and sidebar share one service, isolate conversations, and preserve applied image results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-dsh-')),
    service = new PhoneService([new DemoAdapter()], dir);
  const tools = new Map<string, any>(),
    routes = new Map<string, any>(),
    effects: (() => void)[] = [];
  let readOnly = false;
  const sessions = new Map(
    ['a', 'b'].map((id) => [
      id,
      {
        header: { id },
        requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }),
      },
    ]),
  );
  const ctx: any = {
    tools: { register: (tool: any) => tools.set(tool.name, tool) },
    skills: { registerProvider: () => {} },
    sessions: { get: (id: string) => sessions.get(id) },
    get: (name: string) =>
      name === 'sandboxPolicy'
        ? { resolve: () => ({ mode: readOnly ? 'read-only' : 'workspace-write' }) }
        : name === 'llm'
          ? {
              resolveModelInfo: async () => {
                throw new Error('capability service offline');
              },
            }
          : undefined,
    effect: (fn: () => () => void) => effects.push(fn()),
    on: () => {},
    inject: (_: unknown, cb: (ctx: any) => void) =>
      cb({
        connection: { fetch: { register: (route: any) => routes.set(route.path, route.fetch) } },
      }),
  };
  const call = (name: string, args: any, id = 'a') =>
    tools.get(name).execute(args, {
      agent: { session: sessions.get(id) },
      signal: new AbortController().signal,
    });
  const route = (path: string, body: any, session = 'a') =>
    routes.get(`/api/phone-use/${path}`)(
      new Request(`http://fixture/api/phone-use/${path}?session=${session}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  try {
    mountDsh(ctx, service);
    assert(!tools.has('phone_frame') && !tools.has('phone_connect'));
    await call('phone_open', { device_id: 'demo:foldable' });
    const id = service.listSessions('dsh:a')[0]!.session_id;
    await assert.rejects(call('phone_inspect', { session_id: id }, 'b'));
    readOnly = true;
    await assert.rejects(
      call('phone_act', { session_id: id, action: { kind: 'key', key: 'home' }, observe: false }),
      (e: any) => e.code === 'READ_ONLY',
    );
    readOnly = false;
    const result = await call('phone_act', {
      session_id: id,
      action: { kind: 'key', key: 'home' },
      observe: { mode: 'image' },
    });
    assert(
      JSON.stringify(result).includes('"applied\\":true') ||
        JSON.stringify(result).includes('applied'),
    );
    assert(!JSON.stringify(result).includes('base64'));
    assert(result.content.some((c: any) => c.text?.includes('does not declare image')));
    const panel = service.panel('dsh:a');
    const forbidden = await route(
      'tools',
      { name: 'phone_panel', arguments: { panel_id: panel } },
      'b',
    );
    assert.equal(forbidden.status, 400);
    const connected = await route('tools', {
      name: 'phone_connect',
      arguments: { panel_id: panel },
    });
    const ticket = await connected.json();
    assert.equal(ticket._meta.stream.transport, 'host');
    const carrier = await route('stream', {});
    assert.equal(carrier.status, 200);
    const channel = carrier.headers.get('x-phone-use-channel');
    assert(channel);
    const reader = carrier.body.getReader();
    const readMessage = async () => {
      const { value } = await reader.read();
      const bytes = Buffer.from(value);
      assert.equal(bytes[0], 1);
      return JSON.parse(bytes.subarray(5).toString());
    };
    assert.equal((await readMessage()).type, 'carrier-ready', 'headers can flush before hello');
    const hello = {
      channel,
      sequence: 1,
      message: JSON.stringify({ type: 'hello', token: ticket._meta.stream.token }),
    };
    assert.equal(
      (await route('input', hello, 'b')).status,
      400,
      'another conversation cannot use this carrier',
    );
    assert.equal((await route('input', hello)).status, 200);
    assert.equal((await readMessage()).type, 'ready');
    assert.equal((await route('input', hello)).status, 400, 'an input sequence must not replay');
    await reader.cancel();
    const modelInput = await route('tools', {
      name: 'phone_act',
      arguments: { session_id: id, action: { kind: 'key', key: 'home' } },
    });
    assert.equal(modelInput.status, 400, 'the UI route cannot bypass native model tool policy');
    const unknown = await route('stream', {}, 'missing');
    assert.equal(unknown.status, 400);
  } finally {
    effects.forEach((fn) => fn());
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

const packet = (kind: number, value: Buffer) => {
  const h = Buffer.alloc(5);
  h[0] = kind;
  h.writeUInt32BE(value.length, 1);
  return Buffer.concat([h, value]);
};
test('Harmony static frames update posture while native readiness verifies geometry and connection', async () => {
  const display = {
    id: '0',
    width: 100,
    height: 200,
    inputWidth: 100,
    inputHeight: 200,
    rotation: 0,
    posture: 'folded' as const,
  };
  const bridge = new HarmonyBridge(
    new DeviceShell(
      {
        run: async () => {
          throw new Error('No device access');
        },
      },
      'hdc',
    ),
    display,
  );
  const internal = bridge as any;
  internal.socket = { writable: true, destroyed: false };
  internal.geometry = { id: '0', width: 100, height: 200, rotation: 0, epoch: 1 };
  internal.frameValue = { bytes: Buffer.from([1, 2]), display };
  assert.equal(bridge.pointerReady, true);
  bridge.remember({ ...display, posture: 'half-folded' });
  assert.equal(bridge.pointerReady, true);
  assert.equal(internal.frameValue.display.posture, 'half-folded');
  const same = internal.frameValue;
  bridge.remember({ ...display, posture: 'expanded', inputWidth: 200 });
  assert.equal(internal.frameValue, same, 'a new display needs its own image');
  assert.equal(bridge.connected, true);
  assert.equal(bridge.pointerReady, false, 'a live socket does not authorize changed geometry');
  await assert.rejects(bridge.execute({ kind: 'pointer', phase: 'down', x: 40, y: 80 }), {
    code: 'DISPLAY_CHANGED',
    uncertain: false,
  });
  bridge.remember({ ...display, rotation: 180 });
  assert.equal(bridge.pointerReady, false, 'rotation can change without a size change');
  bridge.remember(display);
  internal.socket.destroyed = true;
  assert.equal(bridge.pointerReady, false);
});
test('Harmony stream validates fragmented frames, display epochs, acknowledgments and invalid packets', async () => {
  const jpeg = await sharp({
    create: { width: 320, height: 640, channels: 3, background: 'white' },
  })
    .jpeg()
    .toBuffer();
  assert.deepEqual(jpegSize(jpeg), { width: 320, height: 640 });
  const images: any[] = [],
    acks: any[] = [],
    decoder = new HarmonyBridgeDecoder(
      (bytes, g) => images.push({ bytes, ...g }),
      (ack) => acks.push(ack),
    );
  const metadata = { width: 1080, height: 2160, rotation: 180, id: '0', epoch: 2 };
  const wire = Buffer.concat([
    packet(1, Buffer.from(JSON.stringify(metadata))),
    packet(2, jpeg),
    packet(3, Buffer.from('{"action":1,"status":"applied","reason":"ok"}')),
  ]);
  for (let i = 0; i < wire.length; i += 7) decoder.push(wire.subarray(i, i + 7));
  assert.equal(images.length, 1);
  assert.equal(images[0].rotation, 180);
  assert.equal(acks.length, 1);
  assert.throws(() =>
    new HarmonyBridgeDecoder(
      () => {},
      () => {},
    ).push(packet(2, jpeg)),
  );
  const oversized = Buffer.alloc(5);
  oversized[0] = 2;
  oversized.writeUInt32BE(9 * 1024 * 1024, 1);
  assert.throws(() => decoder.push(oversized));
});
