import sharp from 'sharp';
import { setTimeout as delay } from 'node:timers/promises';
import { sameDisplay } from './geometry.js';
import type { Bounds, Frame } from './types.js';

export interface Stability {
  status: 'stable' | 'timeout' | 'immediate';
  elapsed_ms: number;
  samples: number;
}
const signature = (frame: Frame, region?: Bounds) => {
  const left = Math.floor((region?.x ?? 0) * frame.display.width);
  const top = Math.floor((region?.y ?? 0) * frame.display.height);
  return sharp(frame.bytes)
    .extract({
      left,
      top,
      width: Math.max(
        1,
        Math.min(
          frame.display.width - left,
          Math.floor((region?.width ?? 1) * frame.display.width),
        ),
      ),
      height: Math.max(
        1,
        Math.min(
          frame.display.height - top,
          Math.floor((region?.height ?? 1) * frame.display.height),
        ),
      ),
    })
    .resize(48, 80, { fit: 'fill' })
    .flatten({ background: '#fff' })
    .greyscale()
    .raw()
    .toBuffer();
};
function similar(a: Buffer, b: Buffer) {
  let changed = 0,
    difference = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    difference += d;
    if (d > 8) changed++;
  }
  return difference / a.length < 1.5 && changed / a.length < 0.015;
}
/** A bounded visual heuristic, not proof that network requests or business logic completed. */
export async function settleFrame(
  capture: () => Promise<Frame>,
  timeoutMs = 2000,
  intervalMs = 100,
  options: { region?: Bounds; quietMs?: number; maxSamples?: number; signal?: AbortSignal } = {},
): Promise<{ frame: Frame; stability: Stability }> {
  const started = performance.now();
  let frame = await capture(),
    samples = 1,
    stablePairs = 0;
  let previous = await signature(frame, options.region);
  let quietSince = performance.now();
  while (performance.now() - started < timeoutMs && samples < (options.maxSamples ?? 12)) {
    await delay(
      Math.min(intervalMs, Math.max(0, timeoutMs - (performance.now() - started))),
      undefined,
      { signal: options.signal },
    );
    if (performance.now() - started >= timeoutMs) break;
    const next = await capture();
    options.signal?.throwIfAborted();
    const current = await signature(next, options.region);
    samples++;
    stablePairs =
      sameDisplay(frame.display, next.display) && similar(previous, current) ? stablePairs + 1 : 0;
    frame = next;
    previous = current;
    if (!stablePairs) quietSince = performance.now();
    if (
      stablePairs >= 2 &&
      performance.now() - quietSince >= (options.quietMs ?? 0) &&
      performance.now() - started <= timeoutMs
    )
      return {
        frame,
        stability: {
          status: 'stable',
          elapsed_ms: Math.round(performance.now() - started),
          samples,
        },
      };
  }
  return {
    frame,
    stability: { status: 'timeout', elapsed_ms: Math.round(performance.now() - started), samples },
  };
}
