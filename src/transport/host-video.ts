import { spawn, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { Fmp4Video } from './fmp4-video.js';
import type { VideoProducer } from './video.js';

export function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1500);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

/** The asynchronous hardware encoder and fMP4 muxer need subsequent input to drain.
 * Emulator screenshots are change-driven: flush with duplicate input only until
 * the final real image has appeared at the output. Never encode idle video forever.
 */
export async function feedRawFrames<T>(
  first: T,
  frames: AsyncIterator<T>,
  write: (frame: T, repeat: boolean) => Promise<void>,
  delivered: () => boolean,
  signal: AbortSignal,
  idleMs = 40,
) {
  let current = first;
  while (!signal.aborted) {
    await write(current, false);
    if (signal.aborted) return;
    const pending = frames.next();
    let next: IteratorResult<T> | undefined;
    for (let attempts = 0; !next; attempts++) {
      if (delivered()) {
        next = await pending;
        break;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        next = await Promise.race([
          pending,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), idleMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (signal.aborted) return;
      if (!next && !delivered()) {
        if (attempts >= 25) throw new Error('Host encoder did not drain its latest image');
        await write(current, true);
      }
    }
    if (next.done) return;
    current = next.value;
  }
}

/** One owned process, bounded parser, no JPEG round-trip or inherited terminal output. */
export async function fmp4Process(
  binary: string,
  args: string[],
  signal: AbortSignal,
  receive: (chunk: Uint8Array) => void,
  feed?: (input: Writable, signal: AbortSignal) => Promise<void>,
) {
  signal.throwIfAborted();
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const lifetime = new AbortController(),
    active = AbortSignal.any([signal, lifetime.signal]);
  let failure: Error | undefined;
  const fail = (e: Error) => {
    failure ??= e;
    lifetime.abort();
  };
  const timer = setTimeout(() => fail(new Error('Host video did not produce a frame')), 10000);
  const parser = new Fmp4Video((bytes) => {
    if (bytes.byteLength > 12 && !(bytes[0]! & 0xc0)) clearTimeout(timer);
    receive(bytes);
  }, true);
  const exit = new Promise<void>((resolve) => {
    child.once('error', (e) => {
      fail(e);
      resolve();
    });
    child.once('close', (code) => {
      if (!active.aborted) fail(new Error(`Host video exited (${code})`));
      resolve();
    });
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', (e) => fail(e));
  const stop = () => stopChild(child);
  active.addEventListener('abort', stop, { once: true });
  if (active.aborted) stop();
  const input = feed?.(child.stdin, active).catch(fail);
  try {
    for await (const chunk of child.stdout) {
      if (active.aborted) break;
      parser.push(chunk);
    }
    if (!active.aborted) parser.finish();
    await exit;
    if (!signal.aborted) throw failure ?? new Error('Host video stopped');
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    stop();
    await input;
    await exit;
    active.removeEventListener('abort', stop);
  }
}

export interface IOSSimulatorOptions {
  udid: string;
  simVideo: string;
  deviceSetPath: string;
  companion?: string;
  /** Optional tiny macOS DTUHID helper; "bundled" uses the distributed artifact. */
  inputBridge?: string;
  /** Experimental: enable only after validating HID coordinates on this runtime. */
  nativeInput?: boolean;
}
export const iosSimulatorVideo =
  (options: IOSSimulatorOptions): VideoProducer =>
  async (signal, receive) => {
    await fmp4Process(
      options.simVideo,
      [
        'stream',
        '--set',
        options.deviceSetPath,
        '--udid',
        options.udid,
        '--fps',
        '60',
        '--avg-bitrate',
        '12000000',
        '--key-frame-rate',
        '1',
        '--encoding',
        'h264',
        '--transport',
        'fmp4',
        '-',
      ],
      signal,
      receive,
    );
  };

export function rawEncoderArgs(
  width: number,
  height: number,
  hardware = process.platform === 'darwin',
) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-probesize',
    '32',
    '-analyzeduration',
    '0',
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgb24',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    '60',
    '-i',
    'pipe:0',
    '-an',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    hardware ? 'h264_videotoolbox' : 'libx264',
    ...(hardware
      ? ['-realtime', '1', '-allow_sw', '0', '-max_ref_frames', '1']
      : ['-preset', 'ultrafast', '-tune', 'zerolatency']),
    '-bf',
    '0',
    '-g',
    '60',
    '-b:v',
    '12M',
    '-movflags',
    'frag_every_frame+empty_moov+default_base_moof',
    '-flush_packets',
    '1',
    '-f',
    'mp4',
    'pipe:1',
  ];
}
