import { createHash } from 'node:crypto';
import type { Bounds, Frame } from './types.js';

export type OcrMode = 'off' | 'auto' | 'on';
export interface OcrText {
  text: string;
  confidence: number;
  /** Top-left origin, in the supplied frame's pixels, not driver coordinates. */
  bounds: Bounds;
}
/** Inject a local or explicitly configured engine; the core never downloads models. */
export interface OcrProvider {
  readonly id: string;
  readonly languages?: readonly string[];
  readonly maxConcurrency?: number;
  recognize(frame: Frame, options: { signal: AbortSignal }): Promise<OcrText[]>;
  dispose?(): Promise<void>;
}
export interface OcrResult {
  source: 'ocr';
  status: 'ok' | 'unavailable' | 'timeout' | 'error';
  provider?: string;
  elapsed_ms: number;
  cached: boolean;
  reason?: 'cooldown' | 'queue_full' | 'cancelled';
  items: (OcrText & { id: string })[];
}

/** Short-lived, exact-image cache. No screenshots or recognized text are written to disk. */
export class OcrEngine {
  private readonly cache = new Map<string, { at: number; result: OcrResult }>();
  private readonly flights = new Map<string, Promise<OcrResult>>();
  private readonly queues: Promise<unknown>[];
  private readonly loads: number[];
  private pending = 0;
  private epoch = 0;
  private readonly retryAt: number[];
  private readonly healthy: boolean[];
  private readonly controllers = new Set<AbortController>();
  private disposed = false;
  constructor(
    readonly provider?: OcrProvider,
    private readonly timeoutMs = 2500,
  ) {
    const concurrency = Math.max(1, Math.min(3, Math.floor(provider?.maxConcurrency || 1)));
    this.queues = Array.from({ length: concurrency }, () => Promise.resolve());
    this.loads = Array.from({ length: concurrency }, () => 0);
    this.retryAt = Array.from({ length: concurrency }, () => 0);
    this.healthy = Array.from({ length: concurrency }, () => false);
  }
  capabilities() {
    const failed = this.retryAt.filter((t) => t > Date.now()).length;
    const health =
      failed === this.queues.length
        ? 'failed'
        : failed
          ? 'degraded'
          : this.healthy.some(Boolean)
            ? 'ready'
            : 'not_checked';
    return {
      configured: !!this.provider && !this.disposed,
      available:
        !this.provider || this.disposed || health === 'failed'
          ? false
          : this.healthy.some(Boolean)
            ? true
            : null,
      health: !this.provider || this.disposed ? 'disabled' : health,
      provider: this.provider?.id,
      languages: this.provider?.languages,
      on_demand: true,
      max_concurrency: this.queues.length,
      ...(failed === this.queues.length
        ? { retry_after_ms: Math.min(...this.retryAt) - Date.now() }
        : {}),
    };
  }
  async recognize(frame: Frame, options: { signal?: AbortSignal } = {}): Promise<OcrResult> {
    const started = Date.now();
    const result = (status: OcrResult['status'], items: OcrResult['items'] = []): OcrResult => ({
      source: 'ocr',
      status,
      provider: this.provider?.id,
      elapsed_ms: Date.now() - started,
      cached: false,
      items,
    });
    if (!this.provider || this.disposed) return result('unavailable');
    if (options.signal?.aborted) return { ...result('unavailable'), reason: 'cancelled' };
    const key = createHash('sha256')
      .update(frame.bytes)
      .update(`${frame.display.width}:${frame.display.height}`)
      .digest('hex');
    for (const [id, entry] of this.cache) if (started - entry.at > 5000) this.cache.delete(id);
    const cached = this.cache.get(key);
    if (cached)
      return { ...structuredClone(cached.result), cached: true, elapsed_ms: Date.now() - started };
    const flight = this.flights.get(key);
    if (flight && !options.signal) return structuredClone(await flight);
    const available = this.loads.map((load, i) => (this.retryAt[i]! > started ? Infinity : load));
    if (available.every((v) => v === Infinity))
      return { ...result('unavailable'), reason: 'cooldown' };
    if (this.pending >= 8) return { ...result('unavailable'), reason: 'queue_full' };
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    const epoch = this.epoch;
    this.pending++;
    let entered = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('OCR stopped')), {
        once: true,
      });
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    });
    const slot = available.indexOf(Math.min(...available));
    this.loads[slot]!++;
    const task = this.queues[slot]!.then(async () => {
      controller.signal.throwIfAborted();
      if (this.retryAt[slot]! > Date.now()) throw new Error('OCR cooldown');
      entered = true;
      // Race here too, so an extension that ignores cancellation cannot block the queue forever.
      return Promise.race([
        this.provider!.recognize(frame, { signal: controller.signal }),
        deadline,
      ]);
    });
    this.queues[slot] = task
      .catch(() => {})
      .finally(() => {
        this.loads[slot]!--;
      });
    const run = (async () => {
      try {
        const data = await Promise.race([task, deadline]);
        const items: OcrResult['items'] = [];
        for (const item of data.slice(0, 250)) {
          if (typeof item.text !== 'string' || !item.text.trim() || !item.bounds) continue;
          const { x, y, width, height } = item.bounds;
          if (
            ![x, y, width, height, item.confidence].every(Number.isFinite) ||
            width <= 0 ||
            height <= 0
          )
            continue;
          const left = Math.max(0, x),
            top = Math.max(0, y);
          const right = Math.min(frame.display.width, x + width),
            bottom = Math.min(frame.display.height, y + height);
          if (right <= left || bottom <= top) continue;
          items.push({
            id: `ocr:${items.length}`,
            text: item.text.trim().slice(0, 500),
            confidence: Math.max(0, Math.min(1, item.confidence)),
            bounds: { x: left, y: top, width: right - left, height: bottom - top },
          });
        }
        const output = result('ok', items);
        this.healthy[slot] = true;
        this.retryAt[slot] = 0;
        if (this.epoch === epoch)
          this.cache.set(key, { at: Date.now(), result: structuredClone(output) });
        while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
        return output;
      } catch {
        if (entered && !options.signal?.aborted && !this.disposed) {
          this.healthy[slot] = false;
          this.retryAt[slot] = Date.now() + 30_000;
        }
        if (options.signal?.aborted || this.disposed)
          return { ...result('unavailable'), reason: 'cancelled' as const };
        if (!entered && !controller.signal.aborted)
          return { ...result('unavailable'), reason: 'cooldown' as const };
        return result(controller.signal.aborted ? 'timeout' : 'error');
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        this.controllers.delete(controller);
        this.pending--;
      }
    })();
    if (!options.signal) this.flights.set(key, run);
    void run.finally(() => {
      if (this.flights.get(key) === run) this.flights.delete(key);
    });
    return run;
  }
  clear() {
    this.epoch++;
    this.cache.clear();
  }
  async dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.clear();
    await this.provider?.dispose?.();
  }
}
