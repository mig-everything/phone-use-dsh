import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DemoAdapter } from '../src/adapters/demo.js';
import { PhoneService } from '../src/core/service.js';
import { PhoneError } from '../src/core/errors.js';
import { toDriverPoint, sameDisplay } from '../src/core/geometry.js';
import { actionSchema } from '../src/core/schema.js';
import type { Device, DriverAction, Frame } from '../src/core/types.js';

async function fixture(clock?: () => number, adapter = new DemoAdapter()) {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-test-'));
  const service = new PhoneService([adapter], dir, clock);
  const { session_id } = await service.open('demo:foldable');
  return {
    service,
    adapter,
    session_id,
    dir,
    async close() {
      await service.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const code = (value: string) => (e: unknown) => e instanceof PhoneError && e.code === value;

test('normalized and screenshot pixels map to iPhone points, including far edge', () => {
  const d = {
    id: '0',
    width: 1170,
    height: 2532,
    inputWidth: 390,
    inputHeight: 844,
    rotation: 0,
    posture: 'unknown' as const,
  };
  assert.deepEqual(toDriverPoint(1169, 2531, 'pixels', d), { x: 389, y: 843 });
  assert.deepEqual(toDriverPoint(1, 1, 'normalized', d), { x: 389, y: 843 });
  assert.throws(() => toDriverPoint(1170, 10, 'pixels', d), code('OUT_OF_BOUNDS'));
  assert.equal(sameDisplay(d, { ...d, rotation: 180 }), false);
});
test('action schema rejects unknown operations, extra shell input, nonfinite and missing context', () => {
  for (const input of [
    { kind: 'shell', command: 'id' },
    { kind: 'tap', x: 2, y: 2 },
    { kind: 'key', key: 'home', command: 'reboot' },
    { kind: 'text', text: 'a\0b', observation_id: crypto.randomUUID() },
    { kind: 'tap', x: Infinity, y: 2, observation_id: crypto.randomUUID() },
  ]) {
    assert.equal(actionSchema.safeParse(input).success, false);
  }
});
test('folding rejects old coordinates before any tap is submitted', async () => {
  const f = await fixture();
  try {
    const capture = await f.service.observe(f.session_id);
    f.adapter.posture = 'expanded';
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'tap',
        x: 100,
        y: 300,
        observation_id: capture.observation.id,
      }),
      code('DISPLAY_CHANGED'),
    );
    assert.equal(f.adapter.active, false);
    const next = await f.service.observe(f.session_id);
    assert.equal(next.observation.display.width, 720);
  } finally {
    await f.close();
  }
});
test('expired observations reject mutation and sessions cannot borrow observations', async () => {
  let now = 1000;
  const f = await fixture(() => now);
  try {
    const capture = await f.service.observe(f.session_id);
    now += 30001;
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'tap',
        x: 10,
        y: 20,
        observation_id: capture.observation.id,
      }),
      code('STALE_OBSERVATION'),
    );
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'tap',
        x: 10,
        y: 20,
        observation_id: crypto.randomUUID(),
      }),
      code('STALE_OBSERVATION'),
    );
    assert.equal(f.adapter.active, false);
  } finally {
    await f.close();
  }
});

test('static live preview renews visible input without recapturing or renewing agent observations', async () => {
  class StaticPreview extends DemoAdapter {
    frame?: Frame;
    captures = 0;
    override async capture() {
      this.captures++;
      return super.capture();
    }
    async preview() {
      return (this.frame ??= {
        ...(await this.capture()),
        transport: 'harmony-uitest' as const,
        capturedAt: '2026-01-01T00:00:00Z',
      });
    }
    async inputDisplay() {
      return (await this.preview()).display;
    }
  }
  let now = 1000;
  const adapter = new StaticPreview(),
    f = await fixture(() => now, adapter);
  try {
    const agent = await f.service.observe(f.session_id, false);
    now += 121;
    const first = (await f.service.preview(f.session_id))!;
    now += 5000;
    assert.equal((await f.service.preview(f.session_id))!.observation.id, first.observation.id);
    now += 30_001;
    const renewed = (await f.service.preview(f.session_id))!;
    assert.notEqual(renewed.observation.id, first.observation.id);
    assert.equal(renewed.frame, first.frame);
    assert.equal(renewed.observation.capturedAt, first.observation.capturedAt);
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'tap', x: 10, y: 20, observation_id: agent.observation.id },
        false,
      ),
      code('STALE_OBSERVATION'),
    );
    await f.service.act(
      f.session_id,
      { kind: 'tap', x: 10, y: 20, observation_id: renewed.observation.id },
      false,
    );
    const afterAction = (await f.service.preview(f.session_id))!;
    assert.notEqual(afterAction.observation.id, renewed.observation.id);
    assert.equal(
      adapter.captures,
      2,
      'one agent capture and one live frame; renewals do not capture',
    );
  } finally {
    await f.close();
  }
});
test('successful action consumes its old observation; input requires verified focus', async () => {
  const f = await fixture();
  try {
    const capture = await f.service.observe(f.session_id);
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'text',
        text: 'hello',
        observation_id: capture.observation.id,
      }),
      code('FOCUS_REQUIRED'),
    );
    const tap = await f.service.act(f.session_id, {
      kind: 'tap_node',
      node_id: 'input',
      observation_id: capture.observation.id,
    });
    assert.ok('inspection' in tap && tap.inspection);
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'tap',
        x: 2,
        y: 2,
        observation_id: capture.observation.id,
      }),
      code('STALE_OBSERVATION'),
    );
    await f.service.act(f.session_id, {
      kind: 'text',
      text: '鸿蒙 🐼',
      observation_id: tap.inspection.observation.id,
    });
    assert.equal(f.adapter.text, '鸿蒙 🐼');
  } finally {
    await f.close();
  }
});
test('focus change rejects text without typing into another field', async () => {
  const f = await fixture();
  try {
    f.adapter.active = true;
    const capture = await f.service.observe(f.session_id);
    f.adapter.active = false;
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'text',
        text: 'secret',
        observation_id: capture.observation.id,
      }),
      code('FOCUS_CHANGED'),
    );
    assert.equal(f.adapter.text, '');
  } finally {
    await f.close();
  }
});
test('device lease excludes a second service, and close releases it', async () => {
  const f = await fixture(),
    second = new PhoneService([new DemoAdapter()], f.dir);
  try {
    await assert.rejects(second.open('demo:foldable'), code('DEVICE_BUSY'));
    await f.service.close(f.session_id);
    const session = await second.open('demo:foldable');
    assert.ok(session.session_id);
  } finally {
    await second.shutdown();
    await f.close();
  }
});
test('device cleanup failure still reports the released local session and permits another owner', async () => {
  class OfflineAtClose extends DemoAdapter {
    async close() {
      throw new PhoneError('WDA_UNREACHABLE', 'Test device disconnected.');
    }
  }
  const f = await fixture(undefined, new OfflineAtClose());
  const other = new PhoneService([new DemoAdapter()], f.dir);
  try {
    const result = await f.service.close(f.session_id);
    assert.equal(result.closed, true);
    assert.equal(result.cleanup_warnings?.[0]?.code, 'WDA_UNREACHABLE');
    assert.deepEqual(f.service.listSessions(), []);
    const next = await other.open('demo:foldable');
    assert(next.session_id);
  } finally {
    await other.shutdown();
    await f.close();
  }
});
test('paused sessions block both screenshots and actions; resume invalidates old context', async () => {
  const f = await fixture();
  try {
    const capture = await f.service.observe(f.session_id);
    await f.service.pause(f.session_id, true);
    await assert.rejects(f.service.observe(f.session_id), code('SESSION_PAUSED'));
    await assert.rejects(
      f.service.act(f.session_id, { kind: 'key', key: 'home' }),
      code('SESSION_PAUSED'),
    );
    await f.service.pause(f.session_id, false);
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'tap',
        x: 1,
        y: 1,
        observation_id: capture.observation.id,
      }),
      code('STALE_OBSERVATION'),
    );
  } finally {
    await f.close();
  }
});
test('uncertain action executes only once and invalidates observations', async () => {
  class TimeoutAdapter extends DemoAdapter {
    calls = 0;
    override async execute(_d: Device, _a: DriverAction) {
      this.calls++;
      throw new PhoneError('COMMAND_TIMEOUT', 'timeout', true);
    }
  }
  const adapter = new TimeoutAdapter(),
    f = await fixture(undefined, adapter);
  try {
    const capture = await f.service.observe(f.session_id);
    const action = { kind: 'tap', x: 1, y: 1, observation_id: capture.observation.id };
    await assert.rejects(f.service.act(f.session_id, action), code('COMMAND_TIMEOUT'));
    await assert.rejects(f.service.act(f.session_id, action), code('STALE_OBSERVATION'));
    assert.equal(adapter.calls, 1);
  } finally {
    await f.close();
  }
});
test('post-action capture failure reports applied without encouraging a retry', async () => {
  class BadCapture extends DemoAdapter {
    broken = false;
    override async execute(d: Device, a: DriverAction) {
      await super.execute(d, a);
      this.broken = true;
    }
    override async capture() {
      if (this.broken) throw new PhoneError('DEVICE_UNREACHABLE', 'gone');
      return super.capture();
    }
  }
  const f = await fixture(undefined, new BadCapture());
  try {
    const result = await f.service.act(f.session_id, { kind: 'key', key: 'home' }, true);
    assert.equal(result.applied, true);
    assert.ok('observation_error' in result);
  } finally {
    await f.close();
  }
});
test('an unexpected driver exception after submission remains uncertain', async () => {
  class BrokenResponse extends DemoAdapter {
    override async execute(d: Device, a: DriverAction) {
      await super.execute(d, a);
      throw new SyntaxError('truncated response');
    }
  }
  const f = await fixture(undefined, new BrokenResponse());
  try {
    const observation = await f.service.observe(f.session_id);
    await assert.rejects(
      f.service.act(f.session_id, {
        kind: 'tap',
        x: 1,
        y: 1,
        observation_id: observation.observation.id,
      }),
      { code: 'ACTION_UNCERTAIN', uncertain: true },
    );
    assert.equal(f.adapter.active, true);
  } finally {
    await f.close();
  }
});
test('commands serialize within a session', async () => {
  class Serial extends DemoAdapter {
    activeCount = 0;
    peak = 0;
    override async execute() {
      this.activeCount++;
      this.peak = Math.max(this.peak, this.activeCount);
      await new Promise((r) => setTimeout(r, 10));
      this.activeCount--;
    }
  }
  const adapter = new Serial(),
    f = await fixture(undefined, adapter);
  try {
    await Promise.all([
      f.service.act(f.session_id, { kind: 'key', key: 'home' }, false),
      f.service.act(f.session_id, { kind: 'key', key: 'back' }, false),
    ]);
    assert.equal(adapter.peak, 1);
  } finally {
    await f.close();
  }
});

test('same-scope concurrent opens reuse one session; a different scope cannot borrow it', async () => {
  const f = await fixture();
  try {
    const sessions = await Promise.all([
      f.service.open('demo:foldable'),
      f.service.open('demo:foldable'),
    ]);
    assert.ok(sessions.every((s) => s.session_id === f.session_id && s.reused));
    assert.equal(f.service.listSessions().length, 1);
    assert.equal(f.service.listSessions('thread:other').length, 0);
    assert.throws(
      () => f.service.requireScope(f.session_id, 'thread:other'),
      code('SESSION_CLOSED'),
    );
    await assert.rejects(f.service.open('demo:foldable', 'thread:other'), code('DEVICE_BUSY'));
    await f.service.close(f.session_id);
    const fresh = await Promise.all([
      f.service.open('demo:foldable'),
      f.service.open('demo:foldable'),
    ]);
    assert.equal(fresh[0]!.session_id, fresh[1]!.session_id);
  } finally {
    await f.close();
  }
});

test('preview polling does not evict an agent observation or create unbounded work', async () => {
  let now = 1000;
  const f = await fixture(() => now);
  try {
    const observed = await f.service.observe(f.session_id);
    for (let i = 0; i < 20; i++) {
      now += 1100;
      await f.service.preview(f.session_id);
    }
    await f.service.act(
      f.session_id,
      { kind: 'tap', x: 100, y: 200, observation_id: observed.observation.id },
      false,
    );
    assert.equal(f.adapter.active, true);
    assert.equal(f.service.state(f.session_id).activity?.status, 'applied');
  } finally {
    await f.close();
  }
});

test('resized video clicks use the observed pixels and still reject changed native geometry', async () => {
  class VideoAdapter extends DemoAdapter {
    lastAction?: DriverAction;
    async preview() {
      const frame = await this.capture();
      return {
        ...frame,
        display: {
          ...frame.display,
          width: frame.display.width / 2,
          height: frame.display.height / 2,
        },
        transport: 'scrcpy' as const,
      };
    }
    override async execute(device: Device, action: DriverAction) {
      this.lastAction = action;
      await super.execute(device, action);
    }
  }
  const adapter = new VideoAdapter(),
    f = await fixture(undefined, adapter);
  try {
    const preview = (await f.service.preview(f.session_id))!;
    await f.service.act(
      f.session_id,
      { kind: 'tap', x: 50, y: 100, observation_id: preview.observation.id },
      false,
    );
    assert.deepEqual(adapter.lastAction, { kind: 'tap', x: 100, y: 200 });
    const next = (await f.service.preview(f.session_id))!;
    adapter.posture = 'expanded';
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'tap', x: 50, y: 100, observation_id: next.observation.id },
        false,
      ),
      code('DISPLAY_CHANGED'),
    );
  } finally {
    await f.close();
  }
});

test('pause discards an in-flight capture and stops publication immediately', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  class SlowCapture extends DemoAdapter {
    override async capture() {
      started();
      await gate;
      return super.capture();
    }
  }
  const f = await fixture(undefined, new SlowCapture());
  try {
    const rejected = assert.rejects(f.service.preview(f.session_id), code('SESSION_PAUSED'));
    await ready;
    const pause = f.service.pause(f.session_id, true);
    assert.equal(f.service.state(f.session_id).paused, true);
    release();
    await rejected;
    await pause;
    await assert.rejects(f.service.preview(f.session_id), code('SESSION_PAUSED'));
  } finally {
    release();
    await f.close();
  }
});

test('preview returns promptly while a control is running and never queues behind it', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  class SlowAction extends DemoAdapter {
    override async execute() {
      started();
      await gate;
    }
  }
  const f = await fixture(undefined, new SlowAction());
  try {
    const action = f.service.act(f.session_id, { kind: 'key', key: 'home' }, false);
    await ready;
    assert.equal(await f.service.preview(f.session_id), undefined);
    assert.equal(f.service.state(f.session_id).busy, true);
    release();
    await action;
    assert.equal(f.service.state(f.session_id).busy, false);
  } finally {
    release();
    await f.close();
  }
});

test('video stays visible during a control but those frames cannot authorize another action', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => (started = r)),
    gate = new Promise<void>((r) => (release = r));
  class LiveAction extends DemoAdapter {
    async liveFrame() {
      return this.capture();
    }
    override async execute() {
      started();
      await gate;
    }
  }
  const f = await fixture(undefined, new LiveAction());
  try {
    const action = f.service.act(f.session_id, { kind: 'key', key: 'home' }, false);
    await ready;
    const video = await f.service.preview(f.session_id);
    assert.ok(video?.frame.bytes.length);
    assert.equal(video.observation.input_ready, false);
    release();
    await action;
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'tap', x: 1, y: 1, observation_id: video.observation.id },
        false,
      ),
      code('STALE_OBSERVATION'),
    );
    assert.equal(f.service.state(f.session_id).busy, false);
  } finally {
    release();
    await f.close();
  }
});

test('30 fps native previews publish each newest frame instead of reusing a 35 ms cache', async () => {
  let now = 1000;
  class NativePreview extends DemoAdapter {
    async preview() {
      return { ...(await super.capture()), transport: 'scrcpy' as const };
    }
    override async capture(): ReturnType<DemoAdapter['capture']> {
      throw new Error('Native preview must not take a screenshot');
    }
  }
  const f = await fixture(() => now, new NativePreview());
  try {
    let previous: string | undefined;
    for (let i = 0; i < 10; i++) {
      const frame = (await f.service.preview(f.session_id))!;
      assert.notEqual(frame.observation.id, previous);
      previous = frame.observation.id;
      now += 33;
    }
  } finally {
    await f.close();
  }
});

test('preview never reports device busy; pointer preparation probes geometry without another capture', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    started = r;
  });
  class FastAdapter extends DemoAdapter {
    captures = 0;
    override async capture() {
      this.captures++;
      return super.capture();
    }
    async preview() {
      started();
      await gate;
      return this.capture();
    }
    async inputDisplay() {
      return (await super.capture()).display;
    }
  }
  const adapter = new FastAdapter(),
    f = await fixture(undefined, adapter);
  try {
    const pending = f.service.preview(f.session_id);
    await ready;
    assert.equal(f.service.state(f.session_id).busy, false);
    release();
    const preview = (await pending)!;
    await f.service.act(
      f.session_id,
      { kind: 'tap', x: 100, y: 200, observation_id: preview.observation.id },
      false,
    );
    assert.equal(adapter.captures, 1);
    const next = (await f.service.preview(f.session_id))!;
    adapter.posture = 'expanded';
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'tap', x: 100, y: 200, observation_id: next.observation.id },
        false,
      ),
      code('DISPLAY_CHANGED'),
    );
  } finally {
    release();
    await f.close();
  }
});

test('pause during action preparation cancels input before submission', async () => {
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  class Preparing extends DemoAdapter {
    slow = false;
    override async inputDisplay() {
      if (this.slow) {
        started();
        await gate;
      }
      return super.inputDisplay();
    }
  }
  const adapter = new Preparing(),
    f = await fixture(undefined, adapter);
  try {
    const observed = await f.service.observe(f.session_id);
    adapter.slow = true;
    const rejected = assert.rejects(
      f.service.act(f.session_id, {
        kind: 'tap',
        x: 1,
        y: 1,
        observation_id: observed.observation.id,
      }),
      code('SESSION_PAUSED'),
    );
    await ready;
    const pause = f.service.pause(f.session_id, true);
    release();
    await rejected;
    await pause;
    assert.equal(adapter.active, false);
  } finally {
    release();
    await f.close();
  }
});

test('tree-first tap and focused typing never capture screenshots and reject coordinate input', async () => {
  class NoCapture extends DemoAdapter {
    override async capture(): ReturnType<DemoAdapter['capture']> {
      throw new Error('Screenshot must not be requested');
    }
  }
  const f = await fixture(undefined, new NoCapture());
  try {
    const tree = await f.service.inspect(f.session_id);
    assert.equal(tree.observation.kind, 'tree');
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'tap', x: 10, y: 20, observation_id: tree.observation.id },
        false,
      ),
      code('SCREEN_OBSERVATION_REQUIRED'),
    );
    const tap = await f.service.act(
      f.session_id,
      { kind: 'tap_node', node_id: 'input', observation_id: tree.observation.id },
      'tree',
    );
    assert.ok('inspection' in tap && tap.inspection);
    assert.equal(f.adapter.active, true);
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'tap_node', node_id: 'input', observation_id: tree.observation.id },
        false,
      ),
      code('STALE_OBSERVATION'),
    );
    await f.service.act(
      f.session_id,
      { kind: 'text', text: '鸿蒙 tree', observation_id: tap.inspection.observation.id },
      'tree',
    );
    assert.equal(f.adapter.text, '鸿蒙 tree');
  } finally {
    await f.close();
  }
});

test('tree-first controls reject changed bounds and lost focus before input', async () => {
  const f = await fixture();
  try {
    let tree = await f.service.inspect(f.session_id);
    f.adapter.posture = 'expanded';
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'tap_node', node_id: 'input', observation_id: tree.observation.id },
        false,
      ),
      code('STALE_NODE'),
    );
    assert.equal(f.adapter.active, false);
    f.adapter.active = true;
    tree = await f.service.inspect(f.session_id);
    f.adapter.active = false;
    await assert.rejects(
      f.service.act(
        f.session_id,
        { kind: 'text', text: 'no', observation_id: tree.observation.id },
        false,
      ),
      code('FOCUS_CHANGED'),
    );
    assert.equal(f.adapter.text, '');
  } finally {
    await f.close();
  }
});

test('tree and screenshot node actions use only visible bounds and reject offscreen controls', async () => {
  class Clipped extends DemoAdapter {
    bounds = { x: 340, y: 20, width: 100, height: 40 };
    calls: DriverAction[] = [];
    override async tree() {
      return (await super.tree()).map((node) => ({ ...node, bounds: this.bounds }));
    }
    override async execute(_device: Device, action: DriverAction) {
      this.calls.push(action);
    }
  }
  const adapter = new Clipped(),
    f = await fixture(undefined, adapter);
  try {
    for (const kind of ['tree', 'image']) {
      adapter.bounds = { x: 340, y: 20, width: 100, height: 40 };
      const inspect = () =>
        kind === 'tree' ? f.service.inspect(f.session_id) : f.service.observe(f.session_id);
      const observed = await inspect();
      await f.service.act(
        f.session_id,
        { kind: 'tap_node', node_id: 'input', observation_id: observed.observation.id },
        false,
      );
      assert.deepEqual(adapter.calls.at(-1), { kind: 'tap', x: 350, y: 40 });
      for (const bounds of [
        { x: 370, y: 20, width: 100, height: 40 },
        { x: -100, y: 20, width: 80, height: 40 },
        { x: 20, y: 730, width: 100, height: 40 },
      ]) {
        adapter.bounds = bounds;
        const old = await inspect(),
          before = adapter.calls.length;
        await assert.rejects(
          f.service.act(
            f.session_id,
            { kind: 'tap_node', node_id: 'input', observation_id: old.observation.id },
            false,
          ),
          (error: unknown) =>
            error instanceof PhoneError &&
            ['NODE_NOT_VISIBLE', 'NODE_NOT_FOUND'].includes(error.code),
        );
        assert.equal(
          adapter.calls.length,
          before,
          'offscreen coordinates must never be clamped into a different target',
        );
      }
    }
  } finally {
    await f.close();
  }
});

test('pause interrupts visual settling before another screenshot is requested', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  class Settling extends DemoAdapter {
    captures = 0;
    override async capture() {
      this.captures++;
      started();
      return super.capture();
    }
  }
  const adapter = new Settling(),
    f = await fixture(undefined, adapter);
  try {
    const capture = assert.rejects(
      f.service.observe(f.session_id, false, 0, 2000),
      code('SESSION_PAUSED'),
    );
    await ready;
    const pause = f.service.pause(f.session_id, true);
    await capture;
    await pause;
    assert.equal(adapter.captures, 1);
  } finally {
    await f.close();
  }
});
