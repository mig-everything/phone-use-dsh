import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IOSNativeInput,
  nativeIOSPacket,
  nativeIOSViewport,
} from '../src/transport/ios-native-input.js';
import type { Display } from '../src/core/types.js';

const display: Display = {
  id: 'default',
  width: 1206,
  height: 2622,
  inputWidth: 402,
  inputHeight: 874,
  rotation: 0,
  posture: 'unknown',
};
test('native iOS coordinates use logical points and retain the origin edge across a continuous gesture', () => {
  assert.deepEqual(nativeIOSPacket({ kind: 'tap', x: 401, y: 873 }, display), {
    phase: 'tap',
    x: 1,
    y: 1,
  });
  for (const [x, y, edge] of [
    [201, 1, 1],
    [1, 437, 2],
    [201, 873, 3],
    [401, 437, 4],
    [201, 437, 0],
  ]) {
    const packet = nativeIOSPacket({ kind: 'pointer', phase: 'down', x: x!, y: y! }, display)!;
    assert.equal(packet.edge, edge);
    assert(typeof packet.x === 'number' && packet.x >= 0 && packet.x <= 1);
    const moved = nativeIOSPacket({ kind: 'pointer', phase: 'move', x: 201, y: 437 }, display)!;
    assert(!('edge' in moved), 'moving inward must not overwrite the origin edge');
  }
  assert.deepEqual(
    nativeIOSPacket({ kind: 'swipe', x: 0, y: 873, toX: 401, toY: 0, durationMs: 220 }, display),
    {
      phase: 'swipe',
      x: 0,
      y: 1,
      toX: 1,
      toY: 0,
      edge: 2,
      durationMs: 220,
    },
  );
  for (const x of [-1, 402, Infinity, NaN])
    assert.throws(
      () => nativeIOSPacket({ kind: 'tap', x, y: 20 }, display),
      (e: any) => e.code === 'OUT_OF_BOUNDS',
    );
  assert.deepEqual(nativeIOSPacket({ kind: 'pointer', phase: 'cancel', x: NaN, y: NaN }, display), {
    phase: 'cancel',
  });
});
test('native iOS requires a verified portrait main viewport and rejects rotated, resized or unknown geometry', () => {
  const geometry = { width: 402, height: 874 };
  assert(nativeIOSViewport(display, geometry));
  for (const rotation of [90, 180, 270, null])
    assert(!nativeIOSViewport({ ...display, rotation }, geometry));
  assert(!nativeIOSViewport({ ...display, inputWidth: 874, inputHeight: 402 }, geometry));
  assert(!nativeIOSViewport(display, { width: 430, height: 932 }));
  assert(!nativeIOSViewport(undefined, geometry));
  assert(!nativeIOSViewport(display, undefined));
});

// A disposable child speaks the public pipe protocol. It never loads CoreSimulator
// or attaches to a phone; exercise failure/reconnection independently of hardware.
test(
  'native input pipe handles split replies, disconnects without replay and releases the owned process',
  {
    skip: process.platform !== 'darwin',
    timeout: 25_000,
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phone-use-ios-input-'));
    const binary = join(dir, 'bridge');
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {createInterface}=require('node:readline');
const dir=process.argv[3];
const mode=fs.readFileSync(path.join(dir,'mode'),'utf8');
fs.appendFileSync(path.join(dir,'pids'),process.pid+'\\n');
const emit=value=>{const line=JSON.stringify(value)+'\\n';process.stdout.write(line.slice(0,7));setImmediate(()=>process.stdout.write(line.slice(7)));};
emit({ready:true,protocol:1,backend:'dtuhid',udid:mode==='wrong-device'?'WRONG':process.argv[4],width:402,height:874});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(path.join(dir,'events'),line+'\\n');
 if(mode==='disconnect' && m.phase==='move') process.exit(9);
 else if(mode==='reject') emit({id:m.id,error:'INVALID_INPUT',uncertain:false});
 else if(mode==='wrong-id') emit({id:m.id+1,submitted:true});
 else emit({id:m.id,submitted:true});
}).on('close',()=>process.exit(0));
`,
      { mode: 0o755 },
    );
    const mode = (value: string) => writeFile(join(dir, 'mode'), value);
    const events = async () =>
      (await readFile(join(dir, 'events'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const control = new IOSNativeInput({
      udid: 'TEST-DEVICE',
      deviceSetPath: dir,
      simVideo: '/unused',
      inputBridge: binary,
      nativeInput: true,
    });
    control.remember(display);
    try {
      await mode('disconnect');
      await Promise.all(Array.from({ length: 20 }, () => control.warmup()));
      assert(control.pointerReady);
      assert.equal(
        (await readFile(join(dir, 'pids'), 'utf8')).trim().split('\n').length,
        1,
        'warmups share one process',
      );
      await control.execute({ kind: 'pointer', phase: 'down', x: 201, y: 873 });
      await assert.rejects(
        control.execute({ kind: 'pointer', phase: 'down', x: 201, y: 873 }),
        (e: any) => e.code === 'DEVICE_BUSY',
      );
      await assert.rejects(
        control.execute({ kind: 'pointer', phase: 'move', x: 201, y: 500 }),
        (e: any) => e.uncertain === true,
      );
      assert.equal(control.pointerReady, false);
      assert.deepEqual(
        (await events()).map((e) => e.phase),
        ['down', 'move'],
      );
      await mode('normal');
      await control.warmup();
      assert(control.pointerReady);
      await assert.rejects(
        control.execute({ kind: 'pointer', phase: 'up', x: 201, y: 500 }),
        (e: any) => e.uncertain === true,
      );
      assert.equal(
        (await events()).length,
        2,
        'a reconnected process never receives the old finger',
      );
      await control.execute({ kind: 'pointer', phase: 'cancel', x: 0, y: 0 });
      await control.execute({ kind: 'pointer', phase: 'down', x: 201, y: 800 });
      control.remember({ ...display, rotation: 90 });
      assert.equal(control.pointerReady, false);
      assert.equal(
        await control.execute({ kind: 'pointer', phase: 'move', x: 201, y: 500 }),
        false,
      );
      await control.execute({ kind: 'pointer', phase: 'cancel', x: 0, y: 0 });
      assert.equal(
        (await events()).at(-1).phase,
        'cancel',
        'cancellation survives a geometry change',
      );
      await control.close();
      control.remember(display);
      for (const selected of ['reject', 'wrong-id']) {
        await mode(selected);
        await control.warmup();
        const count = (await events()).length;
        await assert.rejects(control.execute({ kind: 'tap', x: 201, y: 437 }), (e: any) =>
          selected === 'reject'
            ? e.code === 'NATIVE_INPUT_REJECTED' && !e.uncertain
            : e.uncertain === true,
        );
        assert.equal(
          (await events()).length,
          count + 1,
          'no repeated submission after a rejected or uncertain request',
        );
      }
      await mode('wrong-device');
      await control.warmup();
      assert.equal(control.pointerReady, false);
      assert.equal(
        await control.execute({ kind: 'tap', x: 201, y: 437 }),
        false,
        'invalid handshake fails before touch',
      );
    } finally {
      await control.close();
      // Child close is awaited, so no process retains the input pipe after disposal.
      const pids = (await readFile(join(dir, 'pids'), 'utf8')).trim().split('\n').map(Number);
      for (const pid of pids)
        assert.throws(
          () => process.kill(pid, 0),
          (e: any) => e.code === 'ESRCH',
        );
      await rm(dir, { recursive: true, force: true });
    }
  },
);
