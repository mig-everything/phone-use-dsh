import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ProcessRunner, shellQuote } from './process.js';
import type { VideoProducer } from './video.js';

function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1500);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}
const decodeArgs = (inputArgs: string[]) => [
  '-hide_banner',
  '-loglevel',
  'error',
  '-flags',
  'low_delay',
  '-probesize',
  '32',
  '-analyzeduration',
  '0',
  '-threads',
  '1',
  ...inputArgs,
  '-i',
  'pipe:0',
  '-fps_mode',
  'passthrough',
  '-threads',
  '1',
  '-f',
  'mpjpeg',
  '-pix_fmt',
  'yuvj420p',
  '-q:v',
  '3',
  'pipe:1',
];
async function executablePath(binary: string): Promise<string> {
  for (const candidate of binary.includes('/') || binary.includes('\\')
    ? [resolve(binary)]
    : (process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, binary))) {
    try {
      return await realpath(candidate);
    } catch {}
  }
  throw new Error('scrcpy executable not found');
}

async function connectVideo(port: number, signal: AbortSignal): Promise<Socket> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const socket = connect({ port, host: '127.0.0.1' });
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => finish(new Error('Video connection aborted'));
        const timer = setTimeout(() => finish(new Error('Video connection timed out')), 2000);
        const finish = (error?: Error, first?: Buffer) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          socket.removeListener('error', onError);
          socket.removeListener('end', onEnd);
          socket.removeListener('data', onData);
          if (error) {
            socket.destroy();
            reject(error);
          } else {
            socket.pause();
            socket.unshift(first!);
            resolve();
          }
        };
        const onError = (error: Error) => finish(error);
        const onEnd = () => finish(new Error('Video server not ready'));
        const onData = (chunk: Buffer) => finish(undefined, chunk);
        socket.once('error', onError);
        socket.once('end', onEnd);
        socket.once('data', onData);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      return socket;
    } catch {
      socket.destroy();
      await delay(100, undefined, { signal });
    }
  }
  throw new Error('scrcpy video server did not start');
}

/** Official standalone server raw_stream mode; client and server versions must match. */
export function scrcpyVideo(
  scrcpy: string,
  adb: string,
  ffmpeg: string,
  serial: string,
  control?: (socket: Socket) => void,
): VideoProducer {
  return scrcpyStream(
    scrcpy,
    adb,
    serial,
    false,
    async (socket, active, receive) => {
      await decodeH264(socket, ffmpeg, active, receive);
    },
    control,
  );
}

/** Framed scrcpy 4.x video retains native MediaCodec packets, including rotation boundaries. */
export function scrcpyEncoded(
  scrcpy: string,
  adb: string,
  serial: string,
  control?: (socket: Socket) => void,
): VideoProducer {
  return scrcpyStream(
    scrcpy,
    adb,
    serial,
    true,
    async (socket, active, receive) => {
      const abort = () => socket.destroy();
      active.addEventListener('abort', abort, { once: true });
      try {
        for await (const chunk of socket) receive(chunk);
      } finally {
        active.removeEventListener('abort', abort);
      }
    },
    control,
  );
}

function scrcpyStream(
  scrcpy: string,
  adb: string,
  serial: string,
  framed: boolean,
  consume: (
    socket: Socket,
    signal: AbortSignal,
    receive: (chunk: Uint8Array) => void,
  ) => Promise<void>,
  onControl?: (socket: Socket) => void,
): VideoProducer {
  return async (signal, receive) => {
    const runner = new ProcessRunner();
    let version: string, server: string;
    if (scrcpy === 'bundled') {
      version = '4.0';
      server = fileURLToPath(
        new URL('../../../native/android-server/scrcpy-server-v4.0', import.meta.url),
      );
      const digest = createHash('sha256')
        .update(await readFile(server))
        .digest('hex');
      if (digest !== '84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a')
        throw new Error('Bundled Android server failed its integrity check. Reinstall Phone Use.');
    } else {
      const binary = await executablePath(scrcpy);
      const reported = (await runner.run(binary, ['--version'], 5000)).stdout
        .toString()
        .match(/^scrcpy (\d+\.\d+(?:\.\d+)?)/m)?.[1];
      if (!reported) throw new Error('Cannot determine scrcpy version');
      version = reported;
      server =
        process.env.SCRCPY_SERVER_PATH ??
        join(dirname(binary), '..', 'share', 'scrcpy', 'scrcpy-server');
    }
    if (framed && !/^4\./.test(version))
      throw new Error('Native video requires the bundled Android server or scrcpy 4.x');
    await access(server);
    const id = (randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0');
    const remote = `/data/local/tmp/phone-use-scrcpy-${id}.jar`;
    const adbRun = (args: string[]) => runner.run(adb, ['-s', serial, ...args], 5000);
    let port: number | undefined,
      source: ChildProcess | undefined,
      socket: Socket | undefined,
      control: Socket | undefined;
    const lifetime = new AbortController();
    const active = AbortSignal.any([signal, lifetime.signal]);
    try {
      active.throwIfAborted();
      await adbRun(['push', server, remote]);
      active.throwIfAborted();
      port = Number(
        (await adbRun(['forward', 'tcp:0', `localabstract:scrcpy_${id}`])).stdout.toString().trim(),
      );
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid ADB video forwarding port');
      active.throwIfAborted();
      const command =
        `CLASSPATH=${shellQuote(remote)} ` +
        [
          'app_process',
          '/',
          'com.genymobile.scrcpy.Server',
          version,
          `scid=${id}`,
          'tunnel_forward=true',
          'audio=false',
          `control=${Boolean(onControl)}`,
          'clipboard_autosync=false',
          'cleanup=false',
          ...(framed
            ? [
                'send_device_meta=false',
                `send_dummy_byte=${Boolean(onControl)}`,
                'send_frame_meta=true',
                'send_stream_meta=true',
              ]
            : ['raw_stream=true', `send_dummy_byte=${Boolean(onControl)}`]),
          `max_size=${framed ? 0 : 2400}`,
          `max_fps=${framed ? 60 : 30}`,
          `video_bit_rate=${framed ? 16000000 : 8000000}`,
          'video_codec=h264',
          'video_codec_options=i-frame-interval=1',
        ]
          .map(shellQuote)
          .join(' ');
      source = spawn(adb, ['-s', serial, 'shell', command], { stdio: 'ignore' });
      source.once('error', () => lifetime.abort());
      source.once('close', () => lifetime.abort());
      socket = await connectVideo(port, active);
      if (onControl) {
        if (socket.read(1)?.[0] !== 0) throw new Error('Invalid scrcpy connection');
        control = connect({ port, host: '127.0.0.1' });
        control.setNoDelay(true);
        control.on('error', () => {});
        control.on('data', () => {}); // Clipboard synchronization is disabled.
        const connected = control;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Control connection timed out')), 3000);
          connected.once('connect', () => {
            clearTimeout(timeout);
            resolve();
          });
          connected.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        active.throwIfAborted();
        onControl(control);
      }
      await consume(socket, active, receive);
    } finally {
      socket?.destroy();
      control?.destroy();
      if (source) stop(source);
      if (port && Number.isInteger(port) && port <= 65535)
        await adbRun(['forward', '--remove', `tcp:${port}`]).catch(() => {});
      await adbRun(['shell', ['rm', '-f', remote].map(shellQuote).join(' ')]).catch(() => {});
    }
  };
}

async function decodeH264(
  input: Readable,
  ffmpeg: string,
  signal: AbortSignal,
  receive: (chunk: Uint8Array) => void,
  inputArgs = ['-f', 'h264'],
) {
  const decoder = spawn(ffmpeg, decodeArgs(inputArgs), { stdio: ['pipe', 'pipe', 'pipe'] });
  let detail = '';
  decoder.stderr.on('data', (chunk: Buffer) => {
    detail = (detail + chunk.toString()).slice(-1024);
  });
  const exit = new Promise<void>((resolve, reject) => {
    decoder.once('error', reject);
    decoder.once('close', (code) =>
      code === 0 || signal.aborted
        ? resolve()
        : reject(new Error(`Video decoder stopped: ${detail}`)),
    );
  });
  const abort = () => {
    input.destroy();
    stop(decoder);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    await Promise.all([
      pipeline(input, decoder.stdin, { signal }),
      (async () => {
        for await (const chunk of decoder.stdout) receive(chunk);
      })(),
      exit,
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
    input.destroy();
    stop(decoder);
  }
}
/** Native H.264, or bounded RGBA fallback when the emulator has no video encoder. */
export function harmonyVideo(url: string, token: string, ffmpeg: string): VideoProducer {
  return async (signal, receive) => {
    const response = await fetch(url, {
      signal,
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Harmony video endpoint unavailable');
    }
    let inputArgs = ['-f', 'h264'];
    try {
      if (response.headers.get('content-type') === 'application/x-phone-use-rgba') {
        const width = Number(response.headers.get('x-frame-width'));
        const height = Number(response.headers.get('x-frame-height'));
        if (
          ![width, height].every((n) => Number.isInteger(n) && n >= 64 && n <= 2560 && n % 2 === 0)
        )
          throw new Error('Invalid native frame dimensions');
        inputArgs = [
          '-f',
          'rawvideo',
          '-pixel_format',
          'rgba',
          '-video_size',
          `${width}x${height}`,
          '-framerate',
          '10',
        ];
      } else if (!response.headers.get('content-type')?.startsWith('video/h264')) {
        throw new Error('Unsupported Harmony video format');
      }
      await decodeH264(Readable.fromWeb(response.body as any), ffmpeg, signal, receive, inputArgs);
    } finally {
      await response.body.cancel().catch(() => {});
    }
  };
}

/** Companion v0.4 packet framing retains timestamps/keyframes for browser decoding. */
export function harmonyEncoded(url: string, token: string): VideoProducer {
  return async (signal, receive) => {
    const endpoint = new URL(url);
    endpoint.pathname = endpoint.pathname.replace(/\/stream\/?$/, '/stream-framed');
    if (!endpoint.pathname.endsWith('/stream-framed'))
      throw new Error('Unsupported companion path');
    const response = await fetch(endpoint, {
      signal,
      redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (
      !response.ok ||
      !response.body ||
      response.headers.get('content-type') !== 'application/x-phone-use-h264'
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Native framed video unavailable');
    }
    const reader = response.body.getReader();
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        receive(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
}
