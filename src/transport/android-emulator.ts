import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { DriverAction } from '../core/types.js';
import { PhoneError } from '../core/errors.js';
import { feedRawFrames, fmp4Process, rawEncoderArgs } from './host-video.js';
import type { VideoProducer } from './video.js';

export interface AndroidEmulatorOptions {
  sdkRoot: string;
  discoveryDirectory?: string;
  ffmpeg: string;
}
export interface EmulatorEndpoint {
  port: number;
  token: string;
  pid: number;
  avd: string;
}
/** Match the ADB console port, not a random running emulator or the first discovery file. */
export async function discoverEmulator(
  serial: string,
  directory: string,
): Promise<EmulatorEndpoint | undefined> {
  const port = serial.match(/^emulator-(\d+)$/)?.[1];
  if (!port) return;
  for (const name of await readdir(directory).catch(() => [])) {
    const match = name.match(/^pid_(\d+)\.ini$/);
    if (!match) continue;
    const text = await readFile(join(directory, name), 'utf8').catch(() => '');
    if (text.length > 65536) continue;
    const values = Object.fromEntries(
      text.split(/\r?\n/).flatMap((line) => {
        const n = line.indexOf('=');
        return n > 0 ? [[line.slice(0, n).trim(), line.slice(n + 1).trim()]] : [];
      }),
    );
    const rpcPort = Number(values['grpc.port']),
      token = values['grpc.token'],
      pid = Number(match[1]);
    if (
      values['port.serial'] !== port ||
      !token ||
      token.length > 16384 ||
      !Number.isInteger(rpcPort) ||
      rpcPort < 1 ||
      rpcPort > 65535
    )
      continue;
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }
    return { port: rpcPort, token, pid, avd: values['avd.id'] ?? '' };
  }
}
type RpcClient = grpc.Client & Record<string, any>;
export interface EmulatorLink {
  call(name: string, value: unknown): Promise<any>;
  frames(signal: AbortSignal): AsyncGenerator<any>;
  close(): void;
}
export async function connectEmulator(
  endpoint: EmulatorEndpoint,
  proto: string,
): Promise<EmulatorLink> {
  const definition = grpc.loadPackageDefinition(
    loadSync(proto, { longs: Number, defaults: true }),
  ) as any;
  const client: RpcClient = new definition.android.emulation.control.EmulatorController(
    `127.0.0.1:${endpoint.port}`,
    grpc.credentials.createInsecure(),
    { 'grpc.max_receive_message_length': 128 * 1024 * 1024 },
  );
  const metadata = new grpc.Metadata();
  metadata.set('authorization', `Bearer ${endpoint.token}`);
  const call = (name: string, value: unknown) =>
    new Promise<any>((resolve, reject) =>
      client[name](
        value,
        metadata,
        { deadline: Date.now() + 2500 },
        (error: Error | null, value: any) => (error ? reject(error) : resolve(value)),
      ),
    );
  try {
    await call('getStatus', {});
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    call,
    close: () => client.close(),
    async *frames(signal) {
      signal.throwIfAborted();
      const stream: grpc.ClientReadableStream<any> = client.streamScreenshot(
        { format: 2 },
        metadata,
      );
      let latest: any,
        failure: Error | undefined,
        ended = false,
        wake: (() => void) | undefined;
      stream.on('data', (value) => {
        latest = value;
        wake?.();
      });
      stream.on('error', (error) => {
        failure = error;
        ended = true;
        wake?.();
      });
      stream.on('end', () => {
        ended = true;
        wake?.();
      });
      const abort = () => {
        stream.cancel();
        ended = true;
        wake?.();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      try {
        while (!signal.aborted) {
          if (latest) {
            const value = latest;
            latest = undefined;
            yield value;
          } else if (ended) {
            if (failure) throw failure;
            throw new Error('Emulator video ended');
          } else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        signal.removeEventListener('abort', abort);
        stream.cancel();
      }
    },
  };
}
class RotationChanged extends Error {}
export class AndroidEmulator {
  get pointerReady() {
    return !!this.link;
  }
  imageGeometry?: { width: number; height: number; rotation: number; at: number };
  private link?: EmulatorLink;
  private pointerLink?: EmulatorLink;
  private pending?: Promise<EmulatorLink | undefined>;
  private retryAfter = 0;
  private generation = 0;
  constructor(
    private readonly serial: string,
    private readonly options: AndroidEmulatorOptions,
  ) {}
  async connection(): Promise<EmulatorLink | undefined> {
    if (this.link) return this.link;
    if (this.pending) return this.pending;
    if (Date.now() < this.retryAfter || !/^emulator-\d+$/.test(this.serial)) return;
    const generation = this.generation;
    this.pending = (async () => {
      try {
        const directory =
          this.options.discoveryDirectory ??
          (process.platform === 'darwin'
            ? join(homedir(), 'Library/Caches/TemporaryItems/avd/running')
            : undefined);
        if (!directory) return;
        const endpoint = await discoverEmulator(this.serial, directory);
        if (!endpoint) return;
        const link = await connectEmulator(
          endpoint,
          join(this.options.sdkRoot, 'emulator/lib/emulator_controller.proto'),
        );
        if (generation !== this.generation) {
          link.close();
          return;
        }
        this.link = link;
        return link;
      } catch {
        return;
      } finally {
        this.pending = undefined;
        if (!this.link) this.retryAfter = Date.now() + 30000;
      }
    })();
    return this.pending;
  }
  private disconnect() {
    this.generation++;
    this.link?.close();
    this.link = undefined;
    this.imageGeometry = undefined;
    this.retryAfter = Date.now() + 5000;
  }
  readonly video: VideoProducer = async (signal, receive) => {
    const link = await this.connection();
    if (!link) throw new Error('Authenticated emulator gRPC is unavailable');
    let headerSent = false;
    const forward = (bytes: Uint8Array) => {
      if (bytes.byteLength === 4 && Buffer.from(bytes).toString() === 'h264') {
        if (headerSent) return;
        headerSent = true;
      }
      receive(bytes);
    };
    try {
      while (!signal.aborted) {
        let width = 0,
          height = 0;
        // Start the stream once, keep only its newest complete frame while the encoder is busy.
        const frameLifetime = new AbortController();
        const frames = link.frames(AbortSignal.any([signal, frameLifetime.signal]));
        const firstTimeout = setTimeout(() => frameLifetime.abort(), 10000);
        const validate = (frame: any) => {
          const w = Number(frame.format?.width),
            h = Number(frame.format?.height);
          if (
            !Number.isInteger(w) ||
            !Number.isInteger(h) ||
            w < 64 ||
            h < 64 ||
            w * h > 40_000_000 ||
            !Buffer.isBuffer(frame.image) ||
            frame.image.length !== w * h * 3 ||
            frame.format.format !== 2
          )
            throw new Error('Invalid emulator RGB frame');
          if (width && (width !== w || height !== h))
            throw new RotationChanged('Emulator display changed');
          width = w;
          height = h;
          this.imageGeometry = {
            width: w,
            height: h,
            rotation: Number(frame.format.rotation?.rotation ?? -1) * 90,
            at: Date.now(),
          };
        };
        try {
          const first = await frames.next().finally(() => clearTimeout(firstTimeout));
          if (first.done) throw new Error('Emulator returned no image');
          validate(first.value);
          let submitted = 0,
            target = -1,
            published = -1;
          await fmp4Process(
            this.options.ffmpeg,
            rawEncoderArgs(width, height),
            signal,
            (bytes) => {
              if (bytes.byteLength > 12 && !(bytes[0]! & 0xc0)) {
                const pts = Number(Buffer.from(bytes).readBigUInt64BE() & ((1n << 61n) - 1n));
                published = Math.round((pts * 60) / 1_000_000);
              }
              forward(bytes);
            },
            async (input, active) => {
              const write = async (frame: any, repeat: boolean) => {
                validate(frame);
                if (active.aborted) return;
                if (!repeat) target = submitted;
                submitted++;
                await new Promise<void>((resolve, reject) =>
                  input.write(frame.image, (error) => (error ? reject(error) : resolve())),
                );
              };
              // Terminating the encoder must also unblock the gRPC iterator.
              const cancel = () => {
                frameLifetime.abort();
              };
              active.addEventListener('abort', cancel, { once: true });
              try {
                await feedRawFrames(first.value, frames, write, () => published >= target, active);
              } finally {
                active.removeEventListener('abort', cancel);
              }
            },
          );
        } catch (error) {
          if (error instanceof RotationChanged && !signal.aborted) continue;
          throw error;
        } finally {
          clearTimeout(firstTimeout);
          frameLifetime.abort();
          await frames.return(undefined);
        }
      }
    } catch (error) {
      if (!signal.aborted) this.disconnect();
      throw error;
    }
  };
  async execute(action: DriverAction): Promise<boolean> {
    if (
      !['tap', 'swipe', 'key', 'pointer'].includes(action.kind) ||
      (action.kind === 'key' && !['home', 'back', 'enter'].includes(action.key))
    )
      return false;
    const pointer = action.kind === 'pointer';
    const link = pointer && action.phase !== 'down' ? this.pointerLink : await this.connection();
    if (!link || (pointer && action.phase === 'move' && link !== this.link)) return false;
    if (pointer && action.phase === 'down') this.pointerLink = link;
    try {
      await emulatorAction(link, action);
      return true;
    } catch {
      this.disconnect();
      throw new PhoneError(
        'EMULATOR_INPUT_UNCERTAIN',
        'Simulator input may have been applied. Inspect before retrying; no alternate backend was used.',
        true,
      );
    } finally {
      if (pointer && (action.phase === 'up' || action.phase === 'cancel'))
        this.pointerLink = undefined;
    }
  }
  close() {
    this.pointerLink = undefined;
    this.disconnect();
  }
}

export async function emulatorAction(link: Pick<EmulatorLink, 'call'>, action: DriverAction) {
  if (action.kind === 'pointer') {
    await link.call('sendTouch', {
      touches: [
        {
          x: Math.round(action.x),
          y: Math.round(action.y),
          identifier: 27,
          pressure: action.phase === 'up' || action.phase === 'cancel' ? 0 : 1024,
        },
      ],
      display: 0,
    });
    return;
  }
  if (action.kind === 'key') {
    await link.call('sendKey', {
      key: { home: 'GoHome', back: 'GoBack', enter: 'Enter' }[action.key],
      eventType: 2,
    });
    return;
  }
  if (action.kind !== 'tap' && action.kind !== 'swipe')
    throw new Error('Unsupported emulator input');
  const touch = (x: number, y: number, pressure: number) =>
    link.call('sendTouch', {
      touches: [{ x: Math.round(x), y: Math.round(y), identifier: 27, pressure }],
      display: 0,
    });
  let down = false,
    x = action.x,
    y = action.y;
  try {
    down = true;
    await touch(x, y, 1024);
    if (action.kind === 'swipe') {
      const steps = Math.max(1, Math.ceil(action.durationMs / 16)),
        start = Date.now();
      for (let i = 1; i <= steps; i++) {
        await delay(Math.max(0, start + (action.durationMs * i) / steps - Date.now()));
        x = action.x + ((action.toX - action.x) * i) / steps;
        y = action.y + ((action.toY - action.y) * i) / steps;
        await touch(x, y, 1024);
      }
    }
    await touch(x, y, 0);
    down = false;
  } finally {
    if (down) await touch(x, y, 0).catch(() => {});
  }
}
