import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { DriverAction } from '../core/types.js';
import { PhoneError } from '../core/errors.js';
import { stopChild, type IOSSimulatorOptions } from './host-video.js';

type Client = grpc.Client &
  Record<string, any> & { hid: (...args: any[]) => grpc.ClientWritableStream<any> };
type Link = {
  client: Client;
  child: ChildProcess;
  directory: string;
  exited: Promise<void>;
  lastKeepAliveAt: number;
  keepAlive?: Promise<void>;
};
export function idbEvents(action: DriverAction): object[] | undefined {
  if (action.kind === 'pointer')
    return [
      {
        press: {
          action: { touch: { point: { x: action.x, y: action.y } } },
          direction: action.phase === 'up' || action.phase === 'cancel' ? 1 : 0,
        },
      },
    ];
  if (action.kind === 'swipe')
    return [
      {
        swipe: {
          start: { x: action.x, y: action.y },
          end: { x: action.toX, y: action.toY },
          duration: action.durationMs / 1000,
          delta: 2,
        },
      },
    ];
  const press =
    action.kind === 'tap'
      ? { touch: { point: { x: action.x, y: action.y } } }
      : action.kind === 'key' && action.key === 'home'
        ? { button: { button: 1 } }
        : action.kind === 'key' && action.key === 'enter'
          ? { key: { keycode: 40 } }
          : undefined;
  return press
    ? [
        { press: { action: press, direction: 0 } },
        { delay: { duration: 0.025 } },
        { press: { action: press, direction: 1 } },
      ]
    : undefined;
}
export async function sendIdbEvents(client: Pick<Client, 'hid'>, events: object[]) {
  await new Promise<void>((resolve, reject) => {
    const stream = client.hid({ deadline: Date.now() + 10000 }, (error: Error | null) =>
      error ? reject(error) : resolve(),
    );
    stream.on('error', reject);
    try {
      for (const event of events) stream.write(event);
      stream.end();
    } catch (error) {
      stream.cancel();
      reject(error);
    }
  });
}
/** Owns a simulator-specific idb companion; never exposes an unauthenticated LAN port. */
export class IOSSimulatorControl {
  get pointerReady() {
    return !!this.link && this.link.child.exitCode === null && this.link.child.signalCode === null;
  }
  async warmup() {
    const link = await this.connection();
    // Video is produced by a separate process, so an open preview alone does
    // not reset the companion's idle timer. Keep the owned input connection
    // warm while preview is active; a crashed host still loses its companion
    // after the existing 60-second idle limit.
    if (!link || this.pointerStream) return;
    if (link.keepAlive) return link.keepAlive;
    if (Date.now() - link.lastKeepAliveAt < 20_000) return;
    link.lastKeepAliveAt = Date.now();
    const ping = new Promise<void>((resolve) => {
      link.client.describe({}, { deadline: Date.now() + 3000 }, () => resolve());
    }).catch(() => {}); // Best effort; input submission still reports its own failures.
    link.keepAlive = ping;
    try {
      await ping;
    } finally {
      link.keepAlive = undefined;
    }
  }
  private link?: Link;
  private pending?: Promise<Link | undefined>;
  private retryAfter = 0;
  private generation = 0;
  private pointerStream?: {
    stream: grpc.ClientWritableStream<any>;
    done: Promise<void>;
    failure?: Error;
  };
  constructor(private readonly options: IOSSimulatorOptions) {}
  private async connection(): Promise<Link | undefined> {
    if (this.link && this.link.child.exitCode === null && this.link.child.signalCode === null)
      return this.link;
    if (this.pending) return this.pending;
    if (!this.options.companion || process.platform !== 'darwin' || Date.now() < this.retryAfter)
      return;
    const generation = this.generation;
    this.pending = (async () => {
      let link: Link | undefined;
      try {
        const proto = fileURLToPath(new URL('../../../protocols/idb.proto', import.meta.url));
        const definition = grpc.loadPackageDefinition(
          loadSync(proto, { longs: Number, defaults: true }),
        ) as any;
        // Keep the AF_UNIX path short even when the user's TMPDIR is long.
        const directory = await mkdtemp(join(tmpdir(), 'pu-idb-')),
          socket = join(directory, 'rpc');
        const child = spawn(
          this.options.companion!,
          [
            '--udid',
            this.options.udid,
            '--device-set-path',
            this.options.deviceSetPath,
            '--grpc-domain-sock',
            socket,
            '--debug-port',
            '0',
            '--idle-shutdown-time',
            '60',
            '--log-level',
            'info',
          ],
          { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        const exited = new Promise<void>((resolve) => {
          child.once('error', () => resolve());
          child.once('close', () => resolve());
        });
        const client: Client = new definition.idb.CompanionService(
          `unix:${socket}`,
          grpc.credentials.createInsecure(),
        );
        link = { client, child, directory, exited, lastKeepAliveAt: Date.now() };
        await new Promise<void>((resolve, reject) =>
          client.waitForReady(Date.now() + 7000, (error) => (error ? reject(error) : resolve())),
        );
        const description = await new Promise<any>((resolve, reject) =>
          client.describe(
            {},
            { deadline: Date.now() + 3000 },
            (error: Error | null, result: any) => (error ? reject(error) : resolve(result)),
          ),
        );
        const target = description.targetDescription;
        if (
          target?.udid?.toUpperCase() !== this.options.udid.toUpperCase() ||
          !/^simulator$/i.test(target?.targetType ?? '') ||
          !/^booted$/i.test(target?.state ?? '')
        )
          throw new Error('idb target does not match the configured booted simulator');
        if (generation !== this.generation) throw new Error('Simulator connection closed');
        this.link = link;
        void exited.then(async () => {
          client.close();
          if (this.link?.child === child) this.link = undefined;
          await rm(directory, { recursive: true, force: true }).catch(() => {});
        });
        return link;
      } catch {
        if (link) await this.dispose(link);
        this.retryAfter = Date.now() + 30000;
        return;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
  async execute(action: DriverAction) {
    const events = idbEvents(action);
    if (!events) return false;
    const link = await this.connection();
    if (!link) return false;
    try {
      if (action.kind === 'pointer') {
        if (action.phase === 'down') {
          if (this.pointerStream) throw new Error('A simulator finger is already active');
          let resolve!: () => void, reject!: (error: Error) => void;
          const done = new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          });
          const stream = link.client.hid({ deadline: Date.now() + 30000 }, (error: Error | null) =>
            error ? reject(error) : resolve(),
          );
          const entry: NonNullable<IOSSimulatorControl['pointerStream']> = (this.pointerStream = {
            stream,
            done,
          });
          done.catch((error) => {
            entry.failure = error;
          });
          stream.on('error', reject);
        }
        const entry = this.pointerStream;
        if (!entry) {
          if (action.phase === 'cancel') return true;
          throw new Error('No active simulator finger');
        }
        if (entry.failure) throw entry.failure;
        await new Promise<void>((resolve, reject) =>
          entry.stream.write(events[0], (error: Error | null | undefined) =>
            error ? reject(error) : resolve(),
          ),
        );
        if (action.phase === 'up' || action.phase === 'cancel') {
          entry.stream.end();
          await entry.done;
          this.pointerStream = undefined;
        }
        return true;
      }
      await sendIdbEvents(link.client, events);
      return true;
    } catch {
      // A best-effort finger/key release is allowed; replaying the gesture through WDA is not.
      const last = events.at(-1) as { press?: { direction: number } } | undefined;
      if (last?.press?.direction === 1) await sendIdbEvents(link.client, [last]).catch(() => {});
      await this.close();
      throw new PhoneError(
        'SIMULATOR_INPUT_UNCERTAIN',
        'Simulator input may have been applied. Inspect before retrying; WDA was not used to replay it.',
        true,
      );
    }
  }
  private async dispose(link: Link) {
    link.client.close();
    stopChild(link.child);
    await link.exited;
    await rm(link.directory, { recursive: true, force: true }).catch(() => {});
  }
  async close() {
    this.pointerStream?.stream.cancel();
    this.pointerStream = undefined;
    this.generation++;
    const link = this.link,
      pending = this.pending;
    this.link = undefined;
    if (link) await this.dispose(link);
    // A connection that was still starting observes the generation and disposes itself.
    await pending;
    this.retryAfter = 0;
  }
}
