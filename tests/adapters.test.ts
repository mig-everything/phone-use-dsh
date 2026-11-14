import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DeviceShell, ProcessRunner, shellQuote, type Runner } from '../src/transport/process.js';
import {
  parseHarmonyTree,
  parseAndroidTree,
  parseIOSTree,
  parseDisplayDump,
} from '../src/adapters/parsers.js';
import { HarmonyAdapter, isUITestFailure } from '../src/adapters/harmony.js';
import { AndroidAdapter } from '../src/adapters/android.js';
import { IOSAdapter } from '../src/adapters/ios.js';
import { demoPng } from '../src/adapters/demo.js';
import { pngSize } from '../src/core/images.js';
import type { Device } from '../src/core/types.js';
import type { Socket } from 'node:net';

test('Android JPEG fallback keeps native control and never replays a failed socket write via ADB', async () => {
  let adb = 0;
  const adapter = new AndroidAdapter('adb', {
    async run() {
      adb++;
      throw new Error('Unexpected ADB input');
    },
  });
  const device = {
    id: 'android:emulator-5582',
    platform: 'android',
    name: 'test',
    transport: 'adb',
  } as const;
  const packets: Buffer[] = [];
  let fail = false;
  const socket = {
    destroyed: false,
    writable: true,
    write(bytes: Buffer, callback: (error?: Error) => void) {
      packets.push(bytes);
      callback(fail ? new Error('Disconnected') : undefined);
    },
  } as unknown as Socket;
  const state = adapter as any;
  state.inputGeometry.set(device.id, {
    display: { inputWidth: 1080, inputHeight: 2400, rotation: 0 },
    at: Date.now(),
  });
  state.previewControls.set(device.id, socket);
  state.previewGeometry.set(device.id, { width: 1080, height: 2400 });
  await adapter.execute(device, { kind: 'tap', x: 500, y: 1000 });
  assert.deepEqual(
    packets.map((packet) => packet[1]),
    [0, 1],
  );
  fail = true;
  await assert.rejects(adapter.execute(device, { kind: 'tap', x: 500, y: 1000 }), {
    code: 'ACTION_UNCERTAIN',
    uncertain: true,
  });
  assert.equal(adb, 0);
});

test('remote shell quoting preserves Unicode, quotes, substitutions and newlines literally', () => {
  // The remote phone uses POSIX syntax on every host. Git for Windows supplies
  // the test interpreter; the production Windows bridge does not need a local shell.
  const shell =
    process.env.PHONE_USE_TEST_SHELL ??
    (process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'sh.exe')
      : '/bin/sh');
  const text = '中文 \' " ; $(echo injected) `id` $HOME\nnext';
  assert.equal(
    execFileSync(shell, ['-c', `printf %s ${shellQuote(text)}`], { encoding: 'utf8' }),
    text,
  );
});
test('remote exit code is checked even when hdc exits zero', async () => {
  const runner: Runner = {
    async run(_bin, args) {
      const marker = args.at(-1)!.match(/__PHONE_USE_EXIT_[a-f\d]+__/)![0];
      return { stdout: Buffer.from(`failed\n${marker}:7\n`), stderr: Buffer.alloc(0) };
    },
  };
  await assert.rejects(new DeviceShell(runner, 'hdc').shell(['false']), {
    code: 'DEVICE_COMMAND_FAILED',
  });
});
test('Android forced rotation uses device coordinates and excludes the host video/input route', async () => {
  const commands: string[] = [];
  const runner: Runner = {
    async run(_binary, args) {
      const command = args.at(-1)!;
      commands.push(command);
      const marker = command.match(/__PHONE_USE_EXIT_[a-f\d]+__/)![0];
      return {
        stdout: Buffer.from(
          `Viewport displayId=0 isActive=[1] logicalFrame=[0, 0, 2400, 1080] orientation=1\n${marker}:0\n`,
        ),
        stderr: Buffer.alloc(0),
      };
    },
  };
  const adapter = new AndroidAdapter('adb', runner),
    internal = adapter as any;
  const device = {
    id: 'android:emulator-5582',
    platform: 'android',
    name: 'owned',
    transport: 'adb',
  } as const;
  let nativeInput = 0,
    nativeVideo = 0;
  internal.simulators.set(device.id, {
    imageGeometry: { width: 1080, height: 2400, rotation: 0, at: Date.now() },
    execute: async () => {
      nativeInput++;
      return true;
    },
  });
  internal.simulatorVideo.set(device.id, {
    read: () => {
      nativeVideo++;
      return undefined;
    },
  });
  await adapter.inputDisplay(device);
  assert.equal(adapter.encodedVideo(device, 0), undefined);
  await adapter.execute(device, { kind: 'tap', x: 1700, y: 500 });
  assert.equal(nativeInput, 0);
  assert.equal(nativeVideo, 0);
  assert.ok(commands.some((command) => command.includes("'input' 'tap' '1700' '500'")));
});
test('missing executables and subprocess timeout become bounded typed errors', async () => {
  const runner = new ProcessRunner();
  await assert.rejects(runner.run('/no/such/phone-use-binary', []), { code: 'TOOL_MISSING' });
  await assert.rejects(runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 50), {
    code: 'COMMAND_TIMEOUT',
    uncertain: true,
  });
});
test('UITest success marker No Error is not an error', () => {
  assert.equal(isUITestFailure('No Error'), false);
  assert.equal(isUITestFailure('Error: Cannot connect to AAMS'), true);
  assert.equal(isUITestFailure('Missing parameter.\nUSAGE:'), true);
});
test('Harmony discovery handles empty output and selects exact serial in actions', async () => {
  let args: string[] = [];
  const runner: Runner = {
    async run(_b, a) {
      args = a;
      const marker = a.at(-1)!.match(/__PHONE_USE_EXIT_[a-f\d]+__/);
      return {
        stdout: Buffer.from(marker ? `No Error\n${marker[0]}:0\n` : '[Empty]\n'),
        stderr: Buffer.alloc(0),
      };
    },
  };
  const adapter = new HarmonyAdapter({ server: '127.0.0.1:8710' }, runner);
  assert.deepEqual(await adapter.discover(), []);
  await adapter.execute(
    { id: 'harmonyos:serial-two', platform: 'harmonyos', name: 'test', transport: 'usb' },
    { kind: 'swipe', x: 0, y: 0, toX: 300, toY: 400, durationMs: 1000 },
  );
  assert.deepEqual(args.slice(0, 5), ['-s', '127.0.0.1:8710', '-t', 'serial-two', 'shell']);
  assert.match(args[5]!, /'swipe' '0' '0' '300' '400' '500'/);
});
test('Harmony and Android trees normalize rectangles, boolean flags and escaped text', () => {
  const a = parseHarmonyTree({
    attributes: {
      text: '你好',
      type: 'TextInput',
      bounds: '[10,20][110,60]',
      enabled: 'true',
      focused: 'true',
    },
  })[0]!;
  assert.deepEqual(a.bounds, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(a.focused, true);
  const b = parseAndroidTree(
    '<hierarchy><node text="A &amp; B &#x4e2d;" class="EditText" bounds="[0,0][100,50]" enabled="false" /></hierarchy>',
  )[0]!;
  assert.equal(b.text, 'A & B 中');
  assert.equal(b.enabled, false);
});
test('older UITest inputText fallback uses the field checked by the service', async () => {
  let submitted = '';
  const runner: Runner = {
    async run(_b, args) {
      submitted = args.at(-1)!;
      const marker = submitted.match(/__PHONE_USE_EXIT_[a-f\d]+__/)![0];
      const output = submitted.includes("'help'")
        ? 'screenCap dumpLayout click swipe inputText keyEvent'
        : 'No Error';
      return { stdout: Buffer.from(`${output}\n${marker}:0\n`), stderr: Buffer.alloc(0) };
    },
  };
  const a = new HarmonyAdapter({}, runner),
    d: Device = { id: 'harmonyos:legacy', platform: 'harmonyos', name: 'legacy', transport: 'hdc' };
  assert.equal((await a.inspect(d)).capabilities.text, 'unicode');
  await assert.rejects(a.execute(d, { kind: 'text', text: '中文' }), { code: 'UNSUPPORTED' });
  await a.execute(d, { kind: 'text', text: '中文', target: { x: 40, y: 80 } });
  assert.match(submitted, /'inputText' '40' '80' '中文'/);
});
test('display parser ignores historical rotation and handles newer PhysicalFoldStatus', () => {
  const state = parseDisplayDump(
    '[old] screenRotation: 3\n---------------- Screen ID: 1 ----------------\nPhysicalFoldStatus: HALF_FOLD\nDisplayId: 7\nScreenRotation: 1\n',
  );
  assert.deepEqual(state, { id: '7', rotation: 90, posture: 'half-folded' });
  assert.equal(parseDisplayDump('permission denied').rotation, null);
});
test('WDA string flags preserve editable focus and exclude invisible elements', () => {
  const nodes = parseIOSTree({
    type: 'Application',
    children: [
      {
        type: 'TextField',
        label: 'Search',
        value: '中文',
        rawIdentifier: 'address',
        name: 'dynamic',
        rect: { x: 10, y: 20, width: 100, height: 40 },
        isFocused: '1',
        isEnabled: '1',
        isVisible: '1',
      },
      { type: 'Button', rect: { x: 0, y: 0, width: 20, height: 20 }, isVisible: '0' },
      {
        type: 'Button',
        rect: { x: 0, y: 0, width: 20, height: 20 },
        isEnabled: '0',
        isFocused: '0',
      },
    ],
  });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]!.focused, true);
  assert.equal(nodes[0]!.text, '中文');
  assert.equal(nodes[0]!.resourceId, 'address');
  assert.equal(nodes[1]!.enabled, false);
  assert.equal(nodes[1]!.focused, false);
});
test('WDA keeps explicitly visible children of hidden structural containers, without inventing visibility', () => {
  const rect = { x: 0, y: 0, width: 100, height: 200 };
  const nodes = parseIOSTree({
    type: 'Application',
    rect,
    isVisible: '1',
    children: [
      {
        type: 'Other',
        rect,
        isVisible: '0',
        children: [
          { type: 'Button', rect, label: 'Visible action', isVisible: '1' },
          { type: 'Button', rect, label: 'Hidden action', isVisible: '0' },
          { type: 'Button', rect, label: 'Unverified action' },
        ],
      },
    ],
  });
  assert.deepEqual(
    nodes.map((n) => n.text),
    ['', 'Visible action'],
  );
  assert.equal(nodes[1]!.parentId, '0');
  assert.equal(nodes[1]!.id, '0.0.0', 'stable IDs still reflect the raw tree path');
});
test('iOS verifies keyboard focus independently of WDA accessibility focus', async () => {
  const rect = { x: 10, y: 80, width: 200, height: 40 };
  let fields = [
    { type: 'TextField', label: 'Address', rawIdentifier: 'url', rect, isFocused: '0' },
    {
      type: 'TextField',
      label: 'Other',
      rawIdentifier: 'other',
      rect: { ...rect, y: 150 },
      isFocused: '1',
    },
  ];
  const focused = {
    ELEMENT: 'keyboard-target',
    type: 'XCUIElementTypeTextField',
    label: 'Address',
    'attribute/name': 'url',
    rect,
    enabled: true,
    displayed: true,
  };
  let active: any = focused;
  let activeReads = 0;
  const request = (async (input, options) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/appium/settings')) {
      const settings = JSON.parse(String(options?.body)).settings;
      assert.equal(settings.shouldUseCompactResponses, false);
      assert.match(settings.elementResponseAttributes, /attribute\/name/);
    }
    if (path.endsWith('/element/active')) {
      activeReads++;
      if (active === undefined)
        return Response.json({ value: { error: 'no such element' } }, { status: 404 });
    }
    const value =
      path === '/session'
        ? { sessionId: 'focus' }
        : path.endsWith('/source')
          ? { type: 'Application', children: fields }
          : path.endsWith('/element/active')
            ? active
            : null;
    return Response.json({ value });
  }) as typeof fetch;
  const adapter = new IOSAdapter([{ name: 'test', url: 'http://127.0.0.1:8100' }], request);
  const device: Device = { id: 'ios:test', name: 'test', platform: 'ios', transport: 'wda' };
  const focusedIds = async () =>
    (await adapter.tree(device)).filter((n) => n.focused).map((n) => n.id);
  assert.deepEqual(await focusedIds(), ['0.0'], 'keyboard focus wins over accessibility focus');
  for (const invalid of [
    undefined,
    { ELEMENT: 'compact-only' },
    { ...focused, rect: { ...rect, y: 81 } },
    { ...focused, label: 'Changed' },
    { ...focused, 'attribute/name': 'other' },
    { ...focused, type: 'XCUIElementTypeButton' },
    { ...focused, displayed: false },
    { ...focused, enabled: false },
  ]) {
    active = invalid;
    assert.deepEqual(
      await focusedIds(),
      [],
      'missing, stale, hidden or mismatched focus is rejected',
    );
  }
  active = focused;
  fields = [fields[0]!, fields[0]!];
  assert.deepEqual(await focusedIds(), [], 'ambiguous matching fields cannot authorize text');
  fields = [{ ...fields[0]!, label: '', rawIdentifier: '' }];
  active = { ...focused, label: null, 'attribute/name': null };
  assert.deepEqual(
    await focusedIds(),
    ['0.0'],
    'a unique unnamed input can still have verified focus',
  );
  fields = [];
  const before = activeReads;
  assert.deepEqual(await adapter.tree(device), []);
  assert.equal(activeReads, before, 'pages without inputs need no extra WDA round trip');
});
test('Android never advertises Unicode or silently mangles it', async () => {
  const a = new AndroidAdapter('adb', {
    async run() {
      throw new Error('should not execute');
    },
  });
  const d: Device = { id: 'android:test', platform: 'android', name: 'test', transport: 'adb' };
  for (const text of ['中文', 'literal%s'])
    await assert.rejects(a.execute(d, { kind: 'text', text }), { code: 'UNSUPPORTED' });
});
test('WDA uses a session and preserves screenshot pixel / logical point geometry', async () => {
  const routes: string[] = [];
  const fakeFetch = (async (input, options) => {
    const path = new URL(String(input)).pathname;
    routes.push(`${options?.method ?? 'GET'} ${path}`);
    const value =
      path === '/status'
        ? { os: { version: 'test' } }
        : path === '/session'
          ? { sessionId: 'session-one' }
          : path.endsWith('/window/size')
            ? { width: 100, height: 200 }
            : path.endsWith('/orientation')
              ? 'PORTRAIT'
              : path === '/screenshot'
                ? demoPng(300, 600).toString('base64')
                : null;
    return new Response(JSON.stringify({ value }), { status: 200 });
  }) as typeof fetch;
  const a = new IOSAdapter([{ name: 'test', url: 'http://127.0.0.1:8100' }], fakeFetch);
  const d = (await a.discover())[0]!;
  await a.inspect(d);
  const frame = await a.capture(d);
  assert.equal(frame.display.width, 300);
  assert.equal(frame.display.inputWidth, 100);
  await a.execute(d, { kind: 'tap', x: 30, y: 40 });
  assert.ok(routes.includes('POST /session/session-one/wda/tap'));
  await a.close(d);
  assert.ok(routes.includes('DELETE /session/session-one'));
  assert.throws(() => new IOSAdapter([{ name: 'bad', url: 'http://example.com:8100' }]), {
    code: 'CONFIG_ERROR',
  });
});
test('PNG header validation rejects non-images', () => {
  assert.deepEqual(pngSize(demoPng(40, 80)), { width: 40, height: 80 });
  assert.throws(() => pngSize(Buffer.from('permission denied')), { code: 'INVALID_FRAME' });
});
test('iOS swipes move for the requested duration without a stationary long press', async () => {
  const requests: { path: string; body: any }[] = [];
  let failure: 'http' | 'transport' | undefined;
  const request = (async (input, options) => {
    const path = new URL(String(input)).pathname;
    requests.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (path === '/session') return Response.json({ value: { sessionId: 'touch' } });
    if (path.endsWith('/actions') && failure === 'http')
      return Response.json({ value: { error: 'unknown error' } }, { status: 500 });
    if (path.endsWith('/actions') && failure === 'transport') throw new Error('connection lost');
    return Response.json({ value: null });
  }) as typeof fetch;
  const adapter = new IOSAdapter([{ name: 'test', url: 'http://127.0.0.1:8100' }], request);
  const device: Device = { id: 'ios:test', name: 'test', platform: 'ios', transport: 'wda' };
  for (const swipe of [
    { x: 201, y: 870, toX: 201, toY: 400, durationMs: 220 },
    { x: 320, y: 210, toX: 10, toY: 210, durationMs: 100 },
    { x: 0, y: 0, toX: 150, toY: 250, durationMs: 3000 },
    { x: 12, y: 34, toX: 12, toY: 34, durationMs: 500 },
  ]) {
    await adapter.execute(device, { kind: 'swipe', ...swipe });
    const submitted = requests.at(-1)!;
    assert.equal(submitted.path, '/session/touch/actions');
    assert.equal(submitted.body.actions.length, 1);
    const finger = submitted.body.actions[0];
    assert.equal(finger.type, 'pointer');
    assert.equal(finger.parameters.pointerType, 'touch');
    // Interpret the wire sequence as a touch timeline. The contact starts at
    // t=0, all elapsed time belongs to movement, and release is immediate.
    let elapsed = 0;
    let touching = false;
    const trace: unknown[] = [];
    for (const event of finger.actions) {
      if (event.type === 'pointerMove') {
        assert.equal(event.origin, 'viewport');
        elapsed += event.duration;
        trace.push([touching ? 'move' : 'position', elapsed, event.x, event.y]);
      } else if (event.type === 'pointerDown' || event.type === 'pointerUp') {
        assert.equal(event.button, 0);
        assert.equal(event.duration ?? 0, 0);
        touching = event.type === 'pointerDown';
        trace.push([touching ? 'down' : 'up', elapsed]);
      } else assert.fail(`Unexpected delay or gesture item: ${event.type}`);
    }
    assert.deepEqual(trace, [
      ['position', 0, swipe.x, swipe.y],
      ['down', 0],
      ['move', swipe.durationMs, swipe.toX, swipe.toY],
      ['up', swipe.durationMs],
    ]);
    assert.equal(touching, false);
  }
  for (failure of ['http', 'transport'] as const) {
    const before = requests.length;
    await assert.rejects(
      adapter.execute(device, { kind: 'swipe', x: 10, y: 80, toX: 10, toY: 20, durationMs: 200 }),
      { code: failure === 'http' ? 'WDA_ERROR' : 'WDA_UNREACHABLE', uncertain: true },
    );
    assert.equal(requests.length, before + 1, 'a possibly applied swipe is never replayed');
  }
  assert.ok(!requests.some(({ path }) => /source|screenshot|dragfromtoforduration/.test(path)));
  await adapter.close(device);
});
test('WDA rejects a screenshot taken across an orientation change', async () => {
  let orientationReads = 0;
  const request = (async (input) => {
    const path = new URL(String(input)).pathname;
    const value =
      path === '/session'
        ? { sessionId: 'test' }
        : path.endsWith('/window/size')
          ? { width: 100, height: 200 }
          : path.endsWith('/orientation')
            ? orientationReads++ === 0
              ? 'PORTRAIT'
              : 'LANDSCAPE'
            : path === '/screenshot'
              ? demoPng(100, 200).toString('base64')
              : null;
    return new Response(JSON.stringify({ value }), { status: 200 });
  }) as typeof fetch;
  const a = new IOSAdapter([{ name: 'test', url: 'http://127.0.0.1:8100' }], request);
  await assert.rejects(
    a.capture({ id: 'ios:test', name: 'test', platform: 'ios', transport: 'wda' }),
    { code: 'DISPLAY_CHANGED' },
  );
});
