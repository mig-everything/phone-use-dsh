import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoAdapter } from '../src/adapters/demo.js';
import { PhoneService } from '../src/core/service.js';
import type { Device, DriverAction, UINode } from '../src/core/types.js';
import { emulatorAction } from '../src/transport/android-emulator.js';
import { idbEvents } from '../src/transport/ios-simulator.js';
import { AndroidAdapter } from '../src/adapters/android.js';
import { IOSAdapter } from '../src/adapters/ios.js';
import { PhoneError } from '../src/core/errors.js';

class Native extends DemoAdapter {
  inset = 0;
  captures = 0;
  rotation = 0;
  commands: DriverAction[] = [];
  moving = false;
  pointerReady() {
    return true;
  }
  pointerInset() {
    return this.inset;
  }
  async inputDisplay() {
    return {
      id: 'demo',
      width: 120,
      height: 240,
      inputWidth: 120,
      inputHeight: 240,
      rotation: this.rotation,
      posture: this.posture,
    };
  }
  override async capture() {
    this.captures++;
    const f = await super.capture();
    return {
      ...f,
      display: { ...f.display, inputWidth: 120, inputHeight: 240, rotation: this.rotation },
    };
  }
  override async tree(): Promise<UINode[]> {
    return [
      {
        ...(await super.tree())[0]!,
        type: 'ScrollView',
        id: 'scroll',
        text: '',
        bounds: { x: this.moving ? 3 : 0, y: 30, width: 120, height: 190 },
        scrollable: true,
        clickable: false,
      },
    ];
  }
  override async execute(_d: Device, action: DriverAction) {
    this.commands.push(action);
  }
}
async function fixture(clock?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), 'native-input-')),
    adapter = new Native();
  const service = new PhoneService([adapter], directory, clock);
  const { session_id: id } = await service.open('demo:foldable');
  return {
    adapter,
    service,
    id,
    close: async () => {
      await service.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test('a restricted native edge is rejected before any touch; the caller can select a complete gesture', async () => {
  const f = await fixture();
  try {
    f.adapter.inset = 12;
    const frame = await f.service.observe(f.id, false);
    assert.equal(f.service.state(f.id).manual_input_inset, 12);
    await assert.rejects(
      f.service.pointer(f.id, 'edge-view', {
        phase: 'down',
        x: 0.5,
        y: 1,
        observation_id: frame.observation.id,
      }),
      (e: any) => e.code === 'UNSUPPORTED' && !e.uncertain,
    );
    assert.equal(f.adapter.commands.length, 0);
    assert.equal(f.service.state(f.id).busy, false);
    await f.service.act(
      f.id,
      {
        kind: 'swipe',
        x: 0.5,
        y: 1,
        to_x: 0.5,
        to_y: 0.5,
        duration_ms: 200,
        space: 'normalized',
        observation_id: frame.observation.id,
      },
      false,
    );
    assert.equal(f.adapter.commands.length, 1);
    assert.equal(f.adapter.commands[0]!.kind, 'swipe');
  } finally {
    await f.close();
  }
});
test('agent screenshot input uses authoritative geometry without recapture and retains Retina mapping and rotation rejection', async () => {
  const f = await fixture();
  try {
    const obs = await f.service.observe(f.id, false);
    await f.service.act(
      f.id,
      { kind: 'tap', observation_id: obs.observation.id, x: 359, y: 719 },
      false,
    );
    assert.deepEqual(f.adapter.commands[0], { kind: 'tap', x: 119, y: 239 });
    assert.equal(f.adapter.captures, 1);
    const second = await f.service.observe(f.id, false);
    f.adapter.rotation = 180;
    await assert.rejects(
      f.service.act(
        f.id,
        { kind: 'tap', observation_id: second.observation.id, x: 20, y: 30 },
        false,
      ),
      (e: any) => e.code === 'DISPLAY_CHANGED',
    );
    assert.equal(f.adapter.captures, 2);
    assert.equal(f.adapter.commands.length, 1);
  } finally {
    await f.close();
  }
});
test('scroll_node uses native visible bounds without screenshots and rejects moving or arbitrary targets', async () => {
  const f = await fixture();
  try {
    const tree = await f.service.inspect(f.id);
    assert(tree.observation.nodes[0]!.semantic?.actions.includes('scroll_node'));
    await f.service.act(
      f.id,
      {
        kind: 'scroll_node',
        node_id: 'scroll',
        observation_id: tree.observation.id,
        direction: 'down',
      },
      false,
    );
    const action = f.adapter.commands[0]!;
    assert.equal(action.kind, 'swipe');
    if (action.kind === 'swipe') {
      assert(action.y > action.toY);
      assert(action.y < 220 && action.toY > 30);
    }
    assert.equal(f.adapter.captures, 0);
    const next = await f.service.inspect(f.id);
    f.adapter.moving = true;
    await assert.rejects(
      f.service.act(
        f.id,
        {
          kind: 'scroll_node',
          node_id: 'scroll',
          observation_id: next.observation.id,
          direction: 'up',
        },
        false,
      ),
      (e: any) => e.code === 'STALE_NODE',
    );
    assert.equal(f.adapter.commands.length, 1);
  } finally {
    await f.close();
  }
});
test('manual native finger excludes model input, isolates views and releases on cancellation/pause', async () => {
  const f = await fixture();
  try {
    const frame = await f.service.observe(f.id, false);
    await f.service.pointer(f.id, 'view-a', {
      phase: 'down',
      x: 0.5,
      y: 0.5,
      observation_id: frame.observation.id,
    });
    assert.equal(f.service.state(f.id).busy, true);
    await assert.rejects(
      f.service.act(f.id, { kind: 'key', key: 'home' }, false),
      (e: any) => e.code === 'DEVICE_BUSY',
    );
    await assert.rejects(
      f.service.pointer(f.id, 'view-b', { phase: 'move', x: 0.3, y: 0.4 }),
      (e: any) => e.code === 'DEVICE_BUSY',
    );
    await f.service.pointer(f.id, 'view-a', { phase: 'move', x: 0.8, y: 0.7 });
    await f.service.pointer(f.id, 'view-a', { phase: 'up', x: 0.8, y: 0.7 });
    assert.deepEqual(
      f.adapter.commands.map((a) => a.kind === 'pointer' && a.phase),
      ['down', 'move', 'up'],
    );
    assert.equal(f.adapter.captures, 1, 'continuous input performs no per-move screenshots');
    assert.equal(f.service.state(f.id).busy, false);
    const next = await f.service.observe(f.id, false);
    await f.service.pointer(f.id, 'view-a', {
      phase: 'down',
      x: 0.5,
      y: 0.5,
      observation_id: next.observation.id,
    });
    await f.service.pause(f.id, true);
    assert.equal((f.adapter.commands.at(-1) as any).phase, 'cancel');
    assert.equal(f.service.state(f.id).paused, true);
  } finally {
    await f.close();
  }
});
test('Android and iOS translate the same continuous pointer into their native event types', async () => {
  const calls: any[] = [],
    link = {
      call: async (name: string, value: unknown) => {
        calls.push({ name, value });
      },
    };
  for (const phase of ['down', 'move', 'up', 'cancel'] as const) {
    const action = { kind: 'pointer' as const, phase, x: 100, y: 200 };
    await emulatorAction(link, action);
    const event = idbEvents(action)![0] as any;
    assert.equal(event.press.direction, phase === 'up' || phase === 'cancel' ? 1 : 0);
    assert.deepEqual(event.press.action.touch.point, { x: 100, y: 200 });
  }
  assert.deepEqual(
    calls.map((c) => c.value.touches[0].pressure),
    [1024, 1024, 0, 0],
  );
});

test('fold posture changes during a held finger cancel it and require a new observation', async () => {
  let now = 1000;
  const f = await fixture(() => now);
  try {
    const frame = await f.service.observe(f.id, false);
    await f.service.pointer(f.id, 'fold-view', {
      phase: 'down',
      x: 0.5,
      y: 0.8,
      observation_id: frame.observation.id,
    });
    f.adapter.posture = 'half-folded';
    now += 600;
    await assert.rejects(f.service.pointer(f.id, 'fold-view', { phase: 'move', x: 0.5, y: 0.3 }), {
      code: 'DISPLAY_CHANGED',
    });
    assert.deepEqual(
      f.adapter.commands.map((a) => a.kind === 'pointer' && a.phase),
      ['down', 'cancel'],
    );
    assert.equal(f.service.state(f.id).busy, false);
    await assert.rejects(
      f.service.pointer(f.id, 'fold-view', {
        phase: 'down',
        x: 0.5,
        y: 0.5,
        observation_id: frame.observation.id,
      }),
      { code: 'STALE_OBSERVATION' },
    );
    const next = await f.service.observe(f.id, false);
    await f.service.pointer(f.id, 'fold-view', {
      phase: 'down',
      x: 0.5,
      y: 0.5,
      observation_id: next.observation.id,
    });
    await f.service.cancelPointer(f.id, 'fold-view');
    assert.equal(f.adapter.captures, 2);
  } finally {
    await f.close();
  }
});

test('a rejected native down does not report an uncertain applied action', async () => {
  const f = await fixture();
  try {
    const frame = await f.service.observe(f.id, false);
    f.adapter.execute = async (_device, action) => {
      f.adapter.commands.push(action);
      if (action.kind === 'pointer' && action.phase === 'down')
        throw new PhoneError('UNSUPPORTED', 'Native viewport is not ready; no touch submitted.');
    };
    await assert.rejects(
      f.service.pointer(f.id, 'view', {
        phase: 'down',
        x: 0.5,
        y: 0.5,
        observation_id: frame.observation.id,
      }),
      { code: 'UNSUPPORTED', uncertain: false },
    );
    assert.equal(f.service.state(f.id).activity?.status, 'failed');
    assert.equal(f.service.state(f.id).busy, false);
  } finally {
    await f.close();
  }
});

function androidPointerFixture(width = 1080, height = 2340, rotation = 0) {
  const commands: string[] = [];
  const adapter = new AndroidAdapter('adb', {
    async run(_binary, args) {
      const command = args.at(-1)!;
      commands.push(command);
      const marker = command.match(/__PHONE_USE_EXIT_[a-f\d]+__/)![0];
      return {
        stdout: Buffer.from(
          `Viewport displayId=0 isActive=[1] logicalFrame=[0, 0, ${width}, ${height}] orientation=${rotation}\n${marker}:0\n`,
        ),
        stderr: Buffer.alloc(0),
      };
    },
  });
  const device: Device = {
    id: 'android:fixture',
    platform: 'android',
    name: 'test',
    transport: 'adb',
  };
  const packets: Buffer[] = [];
  const socket = {
    destroyed: false,
    writable: true,
    write(bytes: Buffer, done: (error?: Error) => void) {
      packets.push(Buffer.from(bytes));
      done();
    },
  };
  const state = adapter as any;
  state.nativeControls.set(device.id, socket);
  return { adapter, device, packets, socket, state, commands };
}

test('Android native pointers, taps and swipes use encoded coordinates at different codec scales', async () => {
  for (const [width, height, videoWidth, videoHeight, rotation] of [
    [1080, 2340, 944, 2048, 0],
    [1080, 2340, 1080, 2336, 0],
    [2340, 1080, 2048, 944, 1],
    [1440, 3120, 1104, 2400, 2],
  ]) {
    const f = androidPointerFixture(width, height, rotation);
    const size = { width: videoWidth!, height: videoHeight! };
    f.state.nativeGeometry.set(f.device.id, size);
    assert.equal(
      f.adapter.pointerReady(f.device),
      false,
      'a socket alone is not a verified input channel',
    );
    await f.adapter.inputDisplay(f.device);
    assert.equal(f.adapter.pointerReady(f.device), true);
    for (const phase of ['down', 'move', 'up'] as const)
      await f.adapter.execute(f.device, { kind: 'pointer', phase, x: width! / 2, y: height! / 2 });
    assert.deepEqual(
      f.packets.map((b) => b[1]),
      [0, 2, 1],
    );
    for (const packet of f.packets) {
      assert.equal(packet.readUInt32BE(10), videoWidth! / 2);
      assert.equal(packet.readUInt32BE(14), videoHeight! / 2);
      assert.equal(packet.readUInt16BE(18), videoWidth);
      assert.equal(packet.readUInt16BE(20), videoHeight);
    }
    f.packets.length = 0;
    await f.adapter.execute(f.device, { kind: 'tap', x: 0, y: 0 });
    await f.adapter.execute(f.device, {
      kind: 'swipe',
      x: 0,
      y: 0,
      toX: width! - 1,
      toY: height! - 1,
      durationMs: 1,
    });
    const end = f.packets.at(-1)!;
    assert.equal(end[1], 1);
    assert.equal(end.readUInt32BE(10), videoWidth! - 1);
    assert.equal(end.readUInt32BE(14), videoHeight! - 1);
    assert.equal(
      f.commands.filter((c) => /'input' '(tap|swipe)'/.test(c)).length,
      0,
      'no slow ADB gesture fallback',
    );
  }
});

test('Android readiness rejects missing, disconnected and incompatible geometry; a usable JPEG channel is not shadowed', async () => {
  const f = androidPointerFixture();
  await f.adapter.inputDisplay(f.device);
  f.state.simulators.set(f.device.id, { pointerReady: true });
  for (const size of [undefined, { width: 2048, height: 944 }, { width: 1080, height: 1080 }]) {
    f.state.nativeGeometry.set(f.device.id, size);
    assert.equal(f.adapter.pointerReady(f.device), false);
    await assert.rejects(
      f.adapter.execute(f.device, { kind: 'pointer', phase: 'down', x: 540, y: 1170 }),
      { code: 'UNSUPPORTED', uncertain: false },
    );
  }
  assert.equal(f.packets.length, 0);
  f.state.nativeGeometry.set(f.device.id, { width: 944, height: 2048 });
  f.socket.destroyed = true;
  assert.equal(f.adapter.pointerReady(f.device), false);
  const jpegPackets: Buffer[] = [];
  f.socket.destroyed = false;
  f.state.nativeGeometry.set(f.device.id, { width: 2048, height: 944 });
  f.state.previewControls.set(f.device.id, {
    writable: true,
    destroyed: false,
    write(bytes: Buffer, done: () => void) {
      jpegPackets.push(bytes);
      done();
    },
  });
  f.state.previewGeometry.set(f.device.id, { width: 944, height: 2048 });
  assert.equal(f.adapter.pointerReady(f.device), true);
  await f.adapter.execute(f.device, { kind: 'pointer', phase: 'down', x: 540, y: 1170 });
  await f.adapter.execute(f.device, { kind: 'pointer', phase: 'up', x: 540, y: 1170 });
  assert.deepEqual(
    jpegPackets.map((b) => [b[1], b.readUInt32BE(10), b.readUInt32BE(14)]),
    [
      [0, 472, 1024],
      [1, 472, 1024],
    ],
  );
  assert.equal(f.packets.length, 0);
});

test('Android cannot migrate a held pointer to a reconnected socket', async () => {
  const f = androidPointerFixture();
  f.state.nativeGeometry.set(f.device.id, { width: 944, height: 2048 });
  await f.adapter.execute(f.device, { kind: 'pointer', phase: 'down', x: 540, y: 1170 });
  const replacement: Buffer[] = [];
  f.state.nativeControls.set(f.device.id, {
    writable: true,
    destroyed: false,
    write(bytes: Buffer, done: () => void) {
      replacement.push(bytes);
      done();
    },
  });
  f.state.nativeGeometry.set(f.device.id, { width: 1080, height: 2336 });
  await assert.rejects(
    f.adapter.execute(f.device, { kind: 'pointer', phase: 'move', x: 540, y: 800 }),
    { code: 'DISPLAY_CHANGED' },
  );
  await f.adapter.execute(f.device, { kind: 'pointer', phase: 'cancel', x: 540, y: 1170 });
  assert.equal(replacement.length, 0);
  assert.deepEqual(
    f.packets.map((b) => [b[1], b.readUInt16BE(18), b.readUInt16BE(20)]),
    [
      [0, 944, 2048],
      [1, 944, 2048],
    ],
  );
});

test('Android keeps a held finger on its original socket across backend changes and releases after resize', async () => {
  let shellCalls = 0;
  const adapter = new AndroidAdapter('adb', {
    run: async () => {
      shellCalls++;
      throw new Error('No ADB fallback allowed');
    },
  });
  const device: Device = {
    id: 'android:test',
    name: 'fixture',
    platform: 'android',
    transport: 'adb',
  };
  adapter.inputDisplay = async () => ({
    id: 'default',
    width: 100,
    height: 200,
    inputWidth: 100,
    inputHeight: 200,
    rotation: 0,
    posture: 'unknown',
  });
  const packets: Buffer[] = [],
    newer: Buffer[] = [];
  const socket = (sent: Buffer[]) => ({
    writable: true,
    destroyed: false,
    write(bytes: Buffer, callback: () => void) {
      sent.push(Buffer.from(bytes));
      callback();
    },
  });
  const original = socket(packets),
    replacement = socket(newer),
    state = adapter as any;
  state.previewControls.set(device.id, original);
  state.previewGeometry.set(device.id, { width: 100, height: 200 });
  await adapter.execute(device, { kind: 'pointer', phase: 'down', x: 50, y: 160 });
  state.nativeControls.set(device.id, replacement);
  state.nativeGeometry.set(device.id, { width: 100, height: 200 });
  await adapter.execute(device, { kind: 'pointer', phase: 'move', x: 50, y: 100 });
  state.previewGeometry.set(device.id, { width: 200, height: 100 });
  await assert.rejects(adapter.execute(device, { kind: 'pointer', phase: 'move', x: 50, y: 50 }), {
    code: 'DISPLAY_CHANGED',
  });
  await adapter.execute(device, { kind: 'pointer', phase: 'cancel', x: 50, y: 100 });
  assert.deepEqual(
    packets.map((b) => b[1]),
    [0, 2, 1],
  );
  assert.equal(packets.at(-1)!.readUInt16BE(18), 200, 'release uses the resized viewport');
  assert.equal(newer.length, 0, 'a partial gesture never switches to another native backend');
  assert.equal(shellCalls, 0);
});

test('iOS native video configuration keeps coordinate input on WDA until HID is explicitly enabled', async () => {
  const calls: { url: string; body: any }[] = [];
  const adapter = new IOSAdapter(
    [
      {
        name: 'test',
        url: 'http://127.0.0.1:8100',
        simulator: {
          udid: '00000000-0000-4000-8000-000000000001',
          deviceSetPath: '/fixture',
          simVideo: '/fixture/sim-video',
          companion: '/must-not-start',
        },
      },
    ],
    async (url, init) => {
      const path = String(url),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      return Response.json(
        path.endsWith('/session')
          ? { sessionId: 'fixture', value: { sessionId: 'fixture' } }
          : { value: null },
      );
    },
  );
  const device: Device = { id: 'ios:test', name: 'test', platform: 'ios', transport: 'wda' };
  try {
    assert.equal(adapter.pointerReady(device), false);
    await adapter.execute(device, { kind: 'tap', x: 201, y: 639 });
    assert.deepEqual(calls.find((c) => c.url.endsWith('/wda/tap'))?.body, { x: 201, y: 639 });
    await assert.rejects(
      adapter.execute(device, { kind: 'pointer', phase: 'down', x: 100, y: 200 }),
      { code: 'UNSUPPORTED' },
    );
    assert.equal(calls.filter((c) => c.url.endsWith('/wda/tap')).length, 1);
  } finally {
    await adapter.close(device);
  }
});
