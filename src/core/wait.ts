import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { targetSelectorSchema } from './targets.js';

export const regionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine(
    (r) => r.x + r.width <= 1 && r.y + r.height <= 1,
    'Region must fit the normalized screen.',
  );
export const waitRequestSchema = z
  .object({
    condition: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('target'),
          selector: targetSelectorSchema,
          state: z.enum(['present', 'absent', 'actionable']).default('actionable'),
        })
        .strict(),
      z.object({ kind: z.literal('stable'), region: regionSchema.optional() }).strict(),
    ]),
    timeout_ms: z.number().int().min(200).max(30_000).default(5000),
    interval_ms: z.number().int().min(100).max(2000).default(250),
    quiet_ms: z.number().int().min(100).max(3000).default(400),
    max_nodes: z.number().int().min(1).max(500).default(60),
  })
  .strict();
export type WaitRequest = z.input<typeof waitRequestSchema>;

/** No device actions, screenshots, retries or growing event history in the scheduler. */
export async function waitUntil<T>(
  sample: () => Promise<T>,
  match: (sample: T) => string | undefined,
  options: { timeoutMs: number; intervalMs: number; quietMs: number; signal?: AbortSignal },
) {
  const started = performance.now();
  let since = started,
    previous: string | undefined,
    samples = 0;
  let latest!: T;
  do {
    options.signal?.throwIfAborted();
    latest = await sample();
    options.signal?.throwIfAborted();
    samples++;
    const key = match(latest),
      now = performance.now();
    if (key === undefined || key !== previous) since = now;
    previous = key;
    if (key !== undefined && now - since >= options.quietMs && now - started <= options.timeoutMs)
      return { status: 'matched' as const, elapsed_ms: Math.round(now - started), samples, latest };
    const remaining = options.timeoutMs - (now - started);
    if (remaining <= 0) break;
    await delay(Math.min(options.intervalMs, remaining), undefined, { signal: options.signal });
  } while (performance.now() - started < options.timeoutMs && samples < 300);
  return {
    status: 'timeout' as const,
    elapsed_ms: Math.round(performance.now() - started),
    samples,
    latest,
  };
}
