import sharp from 'sharp';
import type { Frame } from './types.js';

/** Only the human preview is resized. Agent screenshots and input geometry stay full-size. */
export class PreviewEncoder {
  private readonly binaries = new WeakMap<Frame, Map<string, Promise<Buffer>>>();
  binary(frame: Frame, quality: 'focus' | 'grid' = 'focus') {
    let variants = this.binaries.get(frame);
    if (!variants) this.binaries.set(frame, (variants = new Map()));
    let pending = variants.get(quality);
    if (!pending) {
      const width = quality === 'focus' ? 3200 : 1440;
      const height = quality === 'focus' ? 3200 : 1600;
      // Native JPEG streams already encode once. Preserve their detail when they fit.
      pending =
        frame.mimeType === 'image/jpeg' &&
        frame.display.width <= width &&
        frame.display.height <= height
          ? Promise.resolve(frame.bytes)
          : sharp(frame.bytes, { limitInputPixels: 40_000_000 })
              .resize({ width, height, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: quality === 'focus' ? 88 : 80, chromaSubsampling: '4:2:0' })
              .toBuffer();
      variants.set(quality, pending);
    }
    return pending;
  }
  private readonly frames = new WeakMap<
    Frame,
    Promise<{ data: string; mimeType: 'image/jpeg'; width: number; height: number }>
  >();
  encode(frame: Frame) {
    let pending = this.frames.get(frame);
    if (!pending) {
      pending = sharp(frame.bytes, { limitInputPixels: 40_000_000 })
        .resize({ width: 960, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 72, chromaSubsampling: '4:2:0' })
        .toBuffer({ resolveWithObject: true })
        .then(({ data, info }) => ({
          data: data.toString('base64'),
          mimeType: 'image/jpeg' as const,
          width: info.width,
          height: info.height,
        }));
      this.frames.set(frame, pending);
    }
    return pending;
  }
}
