import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import net, { type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DeviceShell } from './process.js';
import { PhoneError } from '../core/errors.js';
import type { Display, DriverAction, Frame } from '../core/types.js';

const directory = fileURLToPath(new URL('../../../native/harmony-bridge/bin/', import.meta.url));
const metaSchema = z
  .object({
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    id: z.string().regex(/^\d+$/),
    epoch: z.number().int().positive(),
  })
  .strict();
type Geometry = z.infer<typeof metaSchema>;
const ackSchema = z
  .object({
    action: z.number().int().positive(),
    status: z.enum(['applied', 'rejected', 'uncertain']),
    reason: z.string().max(80),
  })
  .strict();
type Ack = z.infer<typeof ackSchema>;

/** Strict, bounded framing shared by USB and TCP HDC forwards. */
export class HarmonyBridgeDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  geometry?: Geometry;
  constructor(
    private readonly image: (bytes: Buffer, geometry: Geometry) => void,
    private readonly ack: (value: Ack) => void,
  ) {}
  push(chunk: Buffer) {
    if (this.buffer.length + chunk.length > 16 * 1024 * 1024)
      throw new Error('Device stream exceeds the buffer limit.');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (this.buffer.length - offset >= 5) {
      const kind = this.buffer[offset],
        size = this.buffer.readUInt32BE(offset + 1);
      if (![1, 2, 3, 4].includes(kind!) || size > 8 * 1024 * 1024 || (kind !== 2 && size > 2048))
        throw new Error('Invalid device frame.');
      if (this.buffer.length - offset < size + 5) break;
      const payload = this.buffer.subarray(offset + 5, offset + 5 + size);
      if (kind === 1) this.geometry = metaSchema.parse(JSON.parse(payload.toString()));
      else if (kind === 2) {
        if (!this.geometry || !jpegSize(payload))
          throw new Error('Image arrived without valid geometry.');
        this.image(Buffer.from(payload), this.geometry);
      } else if (kind === 4) throw new Error(payload.toString().slice(0, 300));
      else {
        const value = JSON.parse(payload.toString());
        if ('action' in value) this.ack(ackSchema.parse(value));
      }
      offset += size + 5;
    }
    this.buffer = this.buffer.subarray(offset);
  }
}

export function jpegSize(bytes: Buffer) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return;
  for (let i = 2; i + 8 < bytes.length; ) {
    if (bytes[i++] !== 255) continue;
    const marker = bytes[i++]!;
    if (marker === 255) {
      i--;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return;
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const size = bytes.readUInt16BE(i);
    if (size < 2 || i + size > bytes.length) return;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      const width = bytes.readUInt16BE(i + 5),
        height = bytes.readUInt16BE(i + 3);
      if (width && height && width <= 16384 && height <= 16384) return { width, height };
      return;
    }
    i += size;
  }
}

function unusedPort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** One owned extension; platform-independent host code, prebuilt device-side .so. */
export class HarmonyBridge {
  private readonly lifetime = new AbortController();
  private socket?: Socket;
  private forwarding?: { port: number; name: string };
  private frameValue?: Frame;
  private geometry?: Geometry;
  private sequence = 0;
  private pending?: { id: number; resolve: (ack: Ack) => void; reject: (error: Error) => void };
  private closing?: Promise<void>;
  private opening?: Promise<void>;
  private lastFailure?: Error;
  constructor(
    private readonly shell: DeviceShell,
    private display: Display,
    private readonly scale = 1,
    private readonly assets = directory,
  ) {}
  get connected() {
    return (
      !!this.socket?.writable &&
      !this.socket.destroyed &&
      !!this.geometry &&
      !this.lifetime.signal.aborted
    );
  }
  get pointerReady() {
    const g = this.geometry;
    return (
      this.connected &&
      !!g &&
      this.display.id === g.id &&
      this.display.rotation === g.rotation &&
      this.display.inputWidth === g.width &&
      this.display.inputHeight === g.height
    );
  }
  get epoch() {
    return this.geometry?.epoch;
  }
  get failure() {
    return this.lastFailure;
  }
  remember(display: Display) {
    this.display = display;
    const frame = this.frameValue;
    if (
      frame &&
      frame.display.posture !== display.posture &&
      frame.display.id === display.id &&
      frame.display.inputWidth === display.inputWidth &&
      frame.display.inputHeight === display.inputHeight &&
      frame.display.rotation === display.rotation
    )
      this.frameValue = { ...frame, display: { ...frame.display, posture: display.posture } };
  }
  frame() {
    return this.connected ? this.frameValue : undefined;
  }
  start() {
    return (this.opening ??= this.open());
  }
  private async open() {
    const signal = this.lifetime.signal;
    try {
      const raw = (await this.shell.shell(['uname', '-m'])).trim();
      const arch =
        raw === 'aarch64' || raw === 'arm64' ? 'aarch64' : raw === 'x86_64' ? raw : undefined;
      if (!arch) throw new Error('The native preview does not support this device architecture.');
      const owners = await this.shell.shell(['cat', '/proc/net/unix']);
      if (/(?:^|\s)@?hmbot_capture_v1(?:\s|$)/.test(owners))
        throw new PhoneError('DEVICE_BUSY', 'System capture is already owned by another preview.');
      const path = fileURLToPath(pathToFileURL(join(this.assets, `phone-use-${arch}.so`)));
      const bytes = await readFile(path),
        digest = createHash('sha256').update(bytes).digest('hex').slice(0, 20);
      const filename = `phone-use-${arch}-${digest}.so`,
        remote = `/data/local/tmp/${filename}`;
      const exists = await this.shell.shell(['test', '-r', remote]).then(
        () => true,
        () => false,
      );
      if (!exists) await this.shell.run(['file', 'send', path, remote]);
      signal.throwIfAborted();
      const name = `phone_use_${randomBytes(16).toString('hex')}`,
        secret = randomBytes(24).toString('hex');
      // Firmware pads scaled rows to 32 pixels. Choose an aligned content width
      // instead of stretching that padding into input coordinates. Stay below 1
      // for firmware whose extension validator excludes the upper endpoint.
      const effectiveScale = Math.max(
        0.25,
        (Math.floor((this.display.inputWidth * Math.min(0.98, this.scale)) / 32) * 32) /
          this.display.inputWidth -
          0.000001,
      );
      await this.shell.shell([
        'uitest',
        'start-daemon',
        'singleness',
        '--extension-name',
        filename,
        name,
        secret,
        effectiveScale.toFixed(8),
      ]);
      const deadline = Date.now() + 8000;
      for (;;) {
        signal.throwIfAborted();
        const sockets = await this.shell.shell(['cat', '/proc/net/unix']);
        if (
          sockets.split(/\r?\n/).some((line) => {
            const fields = line.trim().split(/\s+/);
            return (
              fields.at(-1)?.replace(/^@/, '') === name &&
              (parseInt(fields[3] ?? '0', 16) & 0x10000) !== 0
            );
          })
        )
          break;
        if (Date.now() >= deadline) throw new Error('UiTest extension listener did not start.');
        await delay(100, undefined, { signal });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const port = await unusedPort();
        try {
          const result = await this.shell.run(['fport', `tcp:${port}`, `localabstract:${name}`]);
          if (/\[Fail\]|(?:^|\n)\s*error:/i.test(result.toString()))
            throw new Error('HDC forward failed.');
          this.forwarding = { port, name };
          break;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
      if (signal.aborted && this.forwarding) {
        const { port, name } = this.forwarding;
        this.forwarding = undefined;
        await this.shell
          .run(['fport', 'rm', `tcp:${port}`, `localabstract:${name}`], 2500)
          .catch(() => {});
      }
      signal.throwIfAborted();
      const socket = (this.socket = net.createConnection({
        host: '127.0.0.1',
        port: this.forwarding!.port,
      }));
      socket.setNoDelay(true);
      const decoder = new HarmonyBridgeDecoder(
        (bytes, geometry) => {
          this.geometry = geometry;
          const size = jpegSize(bytes)!;
          if (Math.abs(size.width - (size.height * geometry.width) / geometry.height) > 2)
            throw new PhoneError(
              'DISPLAY_CHANGED',
              'Native image padding changed with the display. Reconnect at the current geometry.',
            );
          this.frameValue = {
            bytes,
            mimeType: 'image/jpeg',
            transport: 'harmony-uitest',
            capturedAt: new Date().toISOString(),
            display: {
              ...this.display,
              ...size,
              id: geometry.id,
              inputWidth: geometry.width,
              inputHeight: geometry.height,
              rotation: geometry.rotation,
            },
          };
        },
        (ack) => {
          if (ack.action === this.pending?.id) {
            const pending = this.pending;
            this.pending = undefined;
            pending.resolve(ack);
          }
        },
      );
      socket.on('data', (bytes) => {
        try {
          decoder.push(bytes);
        } catch (error) {
          this.fail(error);
        }
      });
      socket.on('error', (error) => this.fail(error));
      socket.on('close', () => {
        void this.close();
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Device bridge connection timeout.')),
          4000,
        );
        socket.once('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      socket.write(`${secret}\n`);
      const heartbeat = setInterval(() => {
        if (socket.writable) socket.write('ping\n');
      }, 5000);
      heartbeat.unref();
      socket.once('close', () => clearInterval(heartbeat));
      const first = Date.now() + 5000;
      while (!this.frameValue) {
        signal.throwIfAborted();
        if (this.lastFailure) throw this.lastFailure;
        if (Date.now() >= first) throw new Error('Native capture produced no image.');
        await delay(20, undefined, { signal });
      }
    } catch (error) {
      await this.close();
      throw this.lastFailure ?? error;
    }
  }
  private fail(error: unknown) {
    this.lastFailure = error instanceof Error ? error : new Error(String(error));
    void this.close();
  }
  async execute(action: DriverAction): Promise<boolean> {
    if (
      !this.connected ||
      !this.geometry ||
      !['tap', 'swipe', 'key', 'pointer'].includes(action.kind) ||
      (action.kind === 'key' && !['back', 'home'].includes(action.key))
    )
      return false;
    const g = this.geometry;
    if (!this.pointerReady)
      throw new PhoneError('DISPLAY_CHANGED', 'Native preview geometry changed. Observe again.');
    if (this.pending) throw new PhoneError('DEVICE_BUSY', 'The native input channel is busy.');
    const id = ++this.sequence;
    let command: string;
    if (action.kind === 'pointer') command = `pointer_${action.phase} ${action.x} ${action.y}`;
    else if (action.kind === 'tap') command = `tap ${action.x} ${action.y}`;
    else if (action.kind === 'swipe')
      command = `swipe ${action.x} ${action.y} ${action.toX} ${action.toY} ${action.durationMs}`;
    else if (action.kind === 'key') command = action.key;
    else return false;
    const ack = await new Promise<Ack>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        void this.close();
        reject(
          new PhoneError(
            'ACTION_UNCERTAIN',
            'Native input acknowledgment timed out. Inspect; do not retry.',
            true,
          ),
        );
      }, 5000);
      this.pending = {
        id,
        resolve: (ack) => {
          clearTimeout(timer);
          resolve(ack);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.socket!.write(`action ${id} ${g.epoch} ${command}\n`);
    });
    if (ack.status !== 'applied')
      throw new PhoneError(
        ack.reason === 'display_changed'
          ? 'DISPLAY_CHANGED'
          : ack.reason === 'input_busy'
            ? 'DEVICE_BUSY'
            : 'ACTION_FAILED',
        `Native input ${ack.status}: ${ack.reason}. Inspect before continuing.`,
        ack.status === 'uncertain',
      );
    return true;
  }
  close() {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      this.pending?.reject(
        new PhoneError(
          'ACTION_UNCERTAIN',
          'Native input connection ended. Inspect; do not retry.',
          true,
        ),
      );
      this.pending = undefined;
      this.socket?.destroy();
      this.frameValue = undefined;
      const forward = this.forwarding;
      this.forwarding = undefined;
      if (forward)
        await this.shell
          .run(['fport', 'rm', `tcp:${forward.port}`, `localabstract:${forward.name}`], 2500)
          .catch(() => {});
    })());
  }
}
