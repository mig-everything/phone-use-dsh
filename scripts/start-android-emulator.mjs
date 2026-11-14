#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DeviceLease } from '../dist/src/core/lease.js';
import { discoverEmulator } from '../dist/src/transport/android-emulator.js';

const { values } = parseArgs({
  options: {
    avd: { type: 'string' },
    sdk: { type: 'string' },
    port: { type: 'string', default: '5582' },
    discovery: { type: 'string' },
    headless: { type: 'boolean', default: false },
  },
});
if (!values.avd || !/^[\w .-]+$/.test(values.avd))
  throw new Error('Provide --avd with an existing Android AVD name.');
const port = Number(values.port);
if (!Number.isInteger(port) || port % 2 || port < 5554 || port > 5682)
  throw new Error('--port must be an even console port from 5554 to 5682.');
const sdk = resolve(
  values.sdk ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library/Android/sdk'),
);
const discovery =
  values.discovery ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/TemporaryItems/avd/running')
    : undefined);
if (!discovery)
  throw new Error('Set --discovery to the emulator discovery directory on this host.');
const state = process.env.PHONE_USE_STATE_DIR ?? join(homedir(), '.local/state/phone-use');
const lease = await DeviceLease.acquire(join(state, 'locks'), `android:emulator-${port}`);
let child,
  launched = false;
try {
  // Never stop an existing emulator or expose an unauthenticated controller.
  for (const number of [port, port + 1]) {
    const check = createServer();
    await new Promise((yes, no) => {
      check.once('error', () =>
        no(
          new Error(
            `Port ${number} is in use; choose another --port or close that emulator yourself.`,
          ),
        ),
      );
      check.listen(number, '127.0.0.1', yes);
    });
    await new Promise((r) => check.close(r));
  }
  const reserve = createServer();
  await new Promise((r) => reserve.listen(0, '127.0.0.1', r));
  const grpcPort = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const directory = join(state, 'emulators');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const logPath = join(directory, `start-${Date.now()}.log`),
    log = await open(logPath, 'wx', 0o600);
  try {
    child = spawn(
      join(sdk, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator'),
      [
        '-avd',
        values.avd,
        '-port',
        String(port),
        '-gpu',
        'host',
        '-no-snapshot',
        '-no-audio',
        '-grpc',
        String(grpcPort),
        '-grpc-use-token',
        ...(values.headless ? ['-no-window'] : []),
      ],
      { detached: true, stdio: ['ignore', log.fd, log.fd] },
    );
  } finally {
    await log.close();
  }
  let failure;
  child.on('error', (e) => {
    failure = e;
  });
  child.unref();
  for (let i = 0; i < 150; i++) {
    if (failure || child.exitCode !== null || child.signalCode !== null)
      throw failure ?? new Error(`Emulator exited; see ${logPath}`);
    const endpoint = await discoverEmulator(`emulator-${port}`, discovery);
    if (endpoint?.port === grpcPort) {
      launched = true;
      console.log(
        JSON.stringify(
          {
            deviceId: `android:emulator-${port}`,
            avd: values.avd,
            authenticated: true,
            log: logPath,
            configuration: {
              android: {
                emulator: { sdkRoot: sdk, discoveryDirectory: discovery, ffmpeg: 'ffmpeg' },
              },
            },
          },
          null,
          2,
        ),
      );
      break;
    }
    await delay(100);
  }
  if (!launched) throw new Error(`Authenticated gRPC did not start; see ${logPath}`);
} finally {
  if (child && !launched) child.kill('SIGTERM');
  await lease.release();
}
