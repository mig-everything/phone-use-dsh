import sharp from 'sharp';
import type { Display, Frame } from '../core/types.js';
import { sameInputDisplay } from '../core/geometry.js';

/** Both WDA and FFmpeg's mpjpeg muxer delimit frames with Content-Length. */
export class MjpegParser {
  private buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}
  push(chunk: Uint8Array, receive: (bytes: Buffer) => void) {
    if (chunk.byteLength + this.buffer.length > this.maxBytes + 16_384)
      throw new Error('Video frame exceeds the memory limit');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      // WDA terminates each JPEG with two CRLFs; FFmpeg uses a single one.
      while (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10)
        this.buffer = this.buffer.subarray(2);
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > 16_384) throw new Error('Invalid MJPEG headers');
        return;
      }
      if (end > 16_384) throw new Error('Invalid MJPEG headers');
      const length = Number(
        this.buffer
          .subarray(0, end)
          .toString('ascii')
          .match(/content-length:\s*(\d+)/i)?.[1],
      );
      if (!Number.isInteger(length) || length < 4 || length > this.maxBytes)
        throw new Error('Invalid MJPEG frame length');
      if (this.buffer.length < end + 4 + length) return;
      const bytes = Buffer.from(this.buffer.subarray(end + 4, end + 4 + length));
      if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
        throw new Error('Invalid JPEG frame');
      receive(bytes);
      this.buffer = this.buffer.subarray(end + 4 + length);
    }
  }
}
export type VideoProducer = (
  signal: AbortSignal,
  receive: (chunk: Uint8Array) => void,
) => Promise<void>;
interface Packet {
  bytes: Buffer;
  at: number;
}
/** A single latest frame, no frame queue. Consumers renew a short visibility lease. */
export class LatestVideo {
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private packet?: Packet;
  private retryAfter = 0;
  constructor(
    private readonly produce: VideoProducer,
    private readonly leaseMs = 5000,
  ) {}
  latest(): Packet | undefined {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), this.leaseMs);
    this.timer.unref();
    if (!this.controller && Date.now() >= this.retryAfter) {
      const controller = new AbortController(),
        parser = new MjpegParser();
      this.controller = controller;
      void this.produce(controller.signal, (chunk) => {
        if (controller.signal.aborted) return;
        parser.push(chunk, (bytes) => {
          this.packet = { bytes, at: Date.now() };
        });
      })
        .catch(() => {})
        .finally(() => {
          if (this.controller === controller) {
            this.controller = undefined;
            this.packet = undefined;
            this.retryAfter = Date.now() + 2000;
          }
        });
    }
    // scrcpy deliberately stops repeating an unchanged screen. Silence alone is not EOF.
    // VideoPreview verifies the viewport and image periodically even on a quiet connection.
    return this.packet;
  }
  stop() {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
    this.packet = undefined;
  }
}
export function httpMjpeg(url: string, request: typeof fetch = fetch): VideoProducer {
  return async (signal, receive) => {
    const response = await request(url, { signal, redirect: 'error' });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error('MJPEG endpoint unavailable');
    }
    const reader = response.body.getReader();
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        receive(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
}
/** Stream pixels use the most recently verified native input viewport. Actions recheck it. */
export class VideoPreview {
  private geometry?: { display: Display; at: number };
  private cached?: { packet: Packet; display: Display; frame: Frame };
  private verified?: { frame: Frame; at: number };
  private geometryChangedAt = 0;
  constructor(
    private readonly video: LatestVideo,
    private readonly transport: NonNullable<Frame['transport']>,
  ) {}
  remember(display: Display) {
    if (!this.geometry || !sameInputDisplay(this.geometry.display, display)) {
      this.geometryChangedAt = Date.now();
      this.cached = undefined;
      this.verified = undefined;
    }
    this.geometry = { display, at: Date.now() };
  }
  async frame(
    refresh: () => Promise<Frame>,
    probe?: () => Promise<Display | undefined>,
    allowRefresh = true,
  ): Promise<Frame | undefined> {
    const packet = this.video.latest();
    if (!packet) return;
    if (!allowRefresh && !this.geometry) return;
    if (allowRefresh && (!this.geometry || Date.now() - this.geometry.at > 5000)) {
      const geometry = await probe?.();
      if (geometry && this.geometry && sameInputDisplay(this.geometry.display, geometry)) {
        this.remember(geometry);
      } else {
        const frame = await refresh();
        this.remember(frame.display);
        this.verified = { frame, at: Date.now() };
      }
    }
    if (packet.at < this.geometryChangedAt) return this.verified?.frame;
    if (this.verified && this.verified.at > packet.at && Date.now() - packet.at > 1500)
      return this.verified.frame;
    const display = this.geometry!.display;
    if (this.cached?.packet === packet && this.cached.display === display) return this.cached.frame;
    const info = await sharp(packet.bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (
      !info.width ||
      !info.height ||
      Math.abs(info.width / info.height - display.inputWidth / display.inputHeight) > 0.015
    ) {
      // Rotation/folding may change the stream before the input viewport. Fall back to a verified capture.
      this.geometry = undefined;
      return;
    }
    const frame: Frame = {
      bytes: packet.bytes,
      mimeType: 'image/jpeg',
      display: { ...display, width: info.width, height: info.height },
      capturedAt: new Date(packet.at).toISOString(),
      transport: this.transport,
    };
    this.cached = { packet, display, frame };
    return frame;
  }
  stop() {
    this.video.stop();
    this.cached = undefined;
    this.geometry = undefined;
    this.verified = undefined;
  }
}
