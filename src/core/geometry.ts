import type { Display, Bounds } from './types.js';
import { PhoneError } from './errors.js';
export function sameDisplay(a: Display, b: Display): boolean {
  return ['id', 'width', 'height', 'inputWidth', 'inputHeight', 'rotation', 'posture'].every(
    (k) => a[k as keyof Display] === b[k as keyof Display],
  );
}
export function sameInputDisplay(a: Display, b: Display): boolean {
  return ['id', 'inputWidth', 'inputHeight', 'rotation', 'posture'].every(
    (k) => a[k as keyof Display] === b[k as keyof Display],
  );
}
export function toDriverPoint(x: number, y: number, space: 'pixels' | 'normalized', d: Display) {
  const nx = space === 'normalized' ? x : x / (d.width - 1);
  const ny = space === 'normalized' ? y : y / (d.height - 1);
  if (![nx, ny].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))
    throw new PhoneError('OUT_OF_BOUNDS', 'Point must be inside the observed screen.');
  return { x: Math.round(nx * (d.inputWidth - 1)), y: Math.round(ny * (d.inputHeight - 1)) };
}
export function toPixelBounds(b: Bounds, d: Display): Bounds {
  return {
    x: (b.x * d.width) / d.inputWidth,
    y: (b.y * d.height) / d.inputHeight,
    width: (b.width * d.width) / d.inputWidth,
    height: (b.height * d.height) / d.inputHeight,
  };
}
/** A partially clipped native control must be tapped inside its visible portion. */
export function visibleInputPoint(b: Bounds, d: Display) {
  const left = Math.max(0, b.x),
    right = Math.min(d.inputWidth, b.x + b.width);
  const top = Math.max(0, b.y),
    bottom = Math.min(d.inputHeight, b.y + b.height);
  if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top)
    throw new PhoneError(
      'NODE_NOT_VISIBLE',
      'The control is outside the current screen. Scroll or inspect again.',
    );
  return {
    x: Math.min(d.inputWidth - 1, Math.round((left + right) / 2)),
    y: Math.min(d.inputHeight - 1, Math.round((top + bottom) / 2)),
  };
}
export function insideInputInset(x: number, y: number, d: Display, inset: number) {
  return Math.min(x, y, d.inputWidth - 1 - x, d.inputHeight - 1 - y) >= inset;
}
