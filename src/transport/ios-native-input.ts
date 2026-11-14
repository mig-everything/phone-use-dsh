import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Display, DriverAction } from '../core/types.js';
import { PhoneError } from '../core/errors.js';
import { stopChild, type IOSSimulatorOptions } from './host-video.js';

interface Geometry {
  width: number;
  height: number;
}
interface Link {
  child: ChildProcess;
  exited: Promise<void>;
  geometry?: Geometry;
  ready: boolean;
  waiting?: { id: number; resolve: () => void; reject: (error: Error) => void };
}
const directory = new URL('../../../native/ios-simulator-input/bin/', import.meta.url);
const unavailable = () =>
  new PhoneError(
    'SIMULATOR_INPUT_UNCERTAIN',
    'Native input may have been submitted. Observe before continuing; the action was not replayed.',
    true,
  );

/** The current bridge binds the simulator's portrait main display. Other viewports
 * remain on WDA until their display binding has been verified independently. */
export function nativeIOSViewport(display: Display | undefined, geometry: Geometry | undefined) {
  return (
    !!display &&
    !!geometry &&
    display.rotation === 0 &&
    Math.abs(display.inputWidth - geometry.width) < 0.5 &&
    Math.abs(display.inputHeight - geometry.height) < 0.5
  );
}
export function nativeIOSPacket(
  action: DriverAction,
  display: Display,
): Record<string, unknown> | undefined {
  if (action.kind !== 'tap' && action.kind !== 'swipe' && action.kind !== 'pointer') return;
  if (action.kind === 'pointer' && action.phase === 'cancel') return { phase: 'cancel' };
  const point = (x: number, y: number) => {
    if (
      ![x, y, display.inputWidth, display.inputHeight].every(Number.isFinite) ||
      display.inputWidth <= 1 ||
      display.inputHeight <= 1 ||
      x < 0 ||
      y < 0 ||
      x > display.inputWidth - 1 ||
      y > display.inputHeight - 1
    )
      throw new PhoneError('OUT_OF_BOUNDS', 'Native input requires current screen coordinates.');
    return { x: x / (display.inputWidth - 1), y: y / (display.inputHeight - 1) };
  };
  const start = point(action.x, action.y);
  const distances = [
    action.y,
    action.x,
    display.inputHeight - 1 - action.y,
    display.inputWidth - 1 - action.x,
  ];
  const nearest = Math.min(...distances);
  // DTUHID requires the origin edge on every contact of a system gesture. The
  // bridge preserves this value until release; moving inward never clears it.
  const edge = nearest < 24 ? distances.indexOf(nearest) + 1 : 0;
  if (action.kind === 'swipe') {
    const end = point(action.toX, action.toY);
    return {
      phase: 'swipe',
      ...start,
      toX: end.x,
      toY: end.y,
      edge,
      durationMs: action.durationMs,
    };
  }
  return {
    phase: action.kind === 'tap' ? 'tap' : action.phase,
    ...start,
    ...(action.kind === 'pointer' && action.phase === 'down' ? { edge } : {}),
  };
}

/** One owned macOS process and private stdio pipe; no server, forwarding or runtime install. */
export class IOSNativeInput {
  readonly supportsEdges = true;
  private link?: Link;
  private opening?: Promise<Link | undefined>;
  private generation = 0;
  private retryAfter = 0;
  private sequence = 0;
  private finger?: Link;
  private display?: Display;
  constructor(private readonly options: IOSSimulatorOptions) {}
  remember(display: Display) {
    this.display = display;
  }
  get pointerReady() {
    return (
      !!this.link?.ready &&
      this.link.child.exitCode === null &&
      this.link.child.signalCode === null &&
      nativeIOSViewport(this.display, this.link.geometry)
    );
  }
  async warmup() {
    await this.connection();
  }
  private async connection(): Promise<Link | undefined> {
    if (this.link?.ready) return this.link;
    if (this.opening) return this.opening;
    if (process.platform !== 'darwin' || Date.now() < this.retryAfter) return;
    const generation = this.generation;
    this.opening = (async () => {
      let link: Link | undefined;
      try {
        const binary =
          !this.options.inputBridge || this.options.inputBridge === 'bundled'
            ? fileURLToPath(new URL('phone-use-ios-input', directory))
            : this.options.inputBridge;
        if (!this.options.inputBridge || this.options.inputBridge === 'bundled') {
          const manifest = JSON.parse(await readFile(new URL('sha256.json', directory), 'utf8'));
          if (
            manifest.protocol !== 1 ||
            createHash('sha256')
              .update(await readFile(binary))
              .digest('hex') !== manifest.binary
          )
            throw new Error('Invalid native input artifact');
        }
        const { stdout } = await promisify(execFile)('/usr/bin/xcode-select', ['-p'], {
          timeout: 2000,
        });
        const developer = stdout.trim();
        if (!developer.startsWith('/')) throw new Error('Invalid Xcode developer directory');
        const child = spawn(binary, [developer, this.options.deviceSetPath, this.options.udid], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        const exited = new Promise<void>((resolve) => {
          child.once('error', () => resolve());
          child.once('close', () => resolve());
        });
        link = { child, exited, ready: false };
        const current = link;
        let resolveReady!: () => void, rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const fail = (error: Error) => {
          current.ready = false;
          rejectReady(error);
          current.waiting?.reject(error);
          current.waiting = undefined;
          if (this.link === current) this.link = undefined;
          stopChild(child);
        };
        child.once('error', fail);
        child.once('close', () => fail(unavailable()));
        child.stdin!.on('error', fail);
        let buffer = '';
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > 8192) {
            fail(unavailable());
            return;
          }
          for (;;) {
            const end = buffer.indexOf('\n');
            if (end < 0) break;
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const message = JSON.parse(line);
              if (
                !current.ready &&
                message.ready === true &&
                message.protocol === 1 &&
                message.backend === 'dtuhid' &&
                typeof message.udid === 'string' &&
                message.udid.toUpperCase() === this.options.udid.toUpperCase() &&
                [message.width, message.height].every(
                  (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 1 && n < 16384,
                )
              ) {
                current.geometry = { width: message.width, height: message.height };
                current.ready = true;
                resolveReady();
              } else if (current.ready && current.waiting && message.id === current.waiting.id) {
                const pending = current.waiting;
                current.waiting = undefined;
                if (message.submitted === true) pending.resolve();
                else
                  pending.reject(
                    message.error === 'INVALID_INPUT' && message.uncertain === false
                      ? new PhoneError(
                          'NATIVE_INPUT_REJECTED',
                          'Native input rejected the request before submission.',
                        )
                      : unavailable(),
                  );
              } else fail(unavailable());
            } catch {
              fail(unavailable());
            }
          }
        });
        const timeout = setTimeout(() => fail(new Error('Native input startup timed out')), 7000);
        try {
          await ready;
        } finally {
          clearTimeout(timeout);
        }
        if (generation !== this.generation) throw new Error('Native input closed');
        this.link = current;
        return current;
      } catch {
        if (link) {
          stopChild(link.child);
          await link.exited;
        }
        this.retryAfter = Date.now() + 30_000;
        return undefined;
      } finally {
        this.opening = undefined;
      }
    })();
    return this.opening;
  }
  async execute(action: DriverAction): Promise<boolean> {
    if (action.kind !== 'tap' && action.kind !== 'swipe' && action.kind !== 'pointer') return false;
    if (action.kind === 'pointer' && action.phase === 'cancel' && !this.link) {
      this.finger = undefined;
      return true;
    }
    const link = action.kind === 'pointer' ? this.link : await this.connection();
    if (!link?.ready) {
      if (action.kind === 'pointer' && action.phase !== 'down') throw unavailable();
      return false;
    }
    const cancel = action.kind === 'pointer' && action.phase === 'cancel';
    if (!cancel && !nativeIOSViewport(this.display, link.geometry)) return false;
    if (link.waiting) throw new PhoneError('DEVICE_BUSY', 'Another native input is still pending.');
    if (action.kind === 'pointer') {
      if (action.phase === 'down' && this.finger)
        throw new PhoneError('DEVICE_BUSY', 'A native finger is already active.');
      if (action.phase === 'cancel' && link !== this.finger) {
        this.finger = undefined;
        return true;
      }
      if (action.phase !== 'down' && action.phase !== 'cancel' && link !== this.finger)
        throw unavailable();
    }
    const packet = cancel ? { phase: 'cancel' } : nativeIOSPacket(action, this.display!)!;
    const id = ++this.sequence;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        link.waiting = { id, resolve, reject };
        timeout = setTimeout(() => reject(unavailable()), 5000);
        link.child.stdin!.write(JSON.stringify({ id, ...packet }) + '\n', (error) => {
          if (error) reject(unavailable());
        });
      });
      if (action.kind === 'pointer') {
        if (action.phase === 'down') this.finger = link;
        else if (action.phase === 'up' || action.phase === 'cancel') this.finger = undefined;
      }
      return true;
    } catch (error) {
      await this.close();
      if (error instanceof PhoneError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timeout);
      link.waiting = undefined;
    }
  }
  async close() {
    this.generation++;
    this.finger = undefined;
    const link = this.link,
      opening = this.opening;
    this.link = undefined;
    if (link) {
      link.ready = false;
      link.waiting?.reject(unavailable());
      link.waiting = undefined;
      link.child.stdin?.end();
      stopChild(link.child);
      await link.exited;
    }
    await opening;
    this.retryAfter = 0;
  }
}
