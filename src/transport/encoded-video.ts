import type { VideoProducer } from './video.js';
import type { PreviewTransport } from '../core/types.js';

export interface EncodedPacket {
  sequence: number;
  timestamp: number;
  key: boolean;
  bytes: Buffer;
}
export interface EncodedBatch {
  source?: PreviewTransport;
  codec: string;
  width: number;
  height: number;
  epoch: number;
  capturedAt: string;
  packets: EncodedPacket[];
  reset: boolean;
}

/** Switching sources must reset both the decoder and the source-local packet cursor. */
export class VideoChoice {
  private selected?: string;
  private epoch = 0;
  read(sources: Array<{ name: PreviewTransport; video: EncodedVideo }>, after: number) {
    for (const { name, video } of sources) {
      let batch = video.read(after);
      if (!batch) continue;
      const key = `${name}:${batch.epoch}`;
      if (key !== this.selected) {
        batch = video.read(0)!;
        this.selected = key;
        this.epoch++;
      }
      return { ...batch, source: name, epoch: this.epoch };
    }
    return;
  }
}

/** scrcpy 4.x: codec word, session headers, then length-prefixed MediaCodec buffers. */
export class ScrcpyParser {
  private buffer: Buffer = Buffer.alloc(0);
  private header = false;
  push(
    chunk: Uint8Array,
    session: (width: number, height: number) => void,
    packet: (bytes: Buffer, timestamp: number, config: boolean, key: boolean) => void,
  ) {
    if (this.buffer.length + chunk.byteLength > 8 * 1024 * 1024)
      throw new Error('Encoded packet too large');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.header) {
      if (this.buffer.length < 4) return;
      if (this.buffer.toString('ascii', 0, 4) !== 'h264') throw new Error('Expected H.264');
      this.buffer = this.buffer.subarray(4);
      this.header = true;
    }
    while (this.buffer.length >= 12) {
      const flags = this.buffer.readBigUInt64BE(0);
      if (this.buffer[0]! & 0x80) {
        const width = this.buffer.readUInt32BE(4),
          height = this.buffer.readUInt32BE(8);
        if (width < 64 || height < 64 || width * height > 40_000_000)
          throw new Error('Invalid stream geometry');
        session(width, height);
        this.buffer = this.buffer.subarray(12);
        continue;
      }
      const length = this.buffer.readUInt32BE(8);
      if (length < 1 || length > 4 * 1024 * 1024) throw new Error('Invalid encoded packet length');
      if (this.buffer.length < 12 + length) return;
      const bytes = Buffer.from(this.buffer.subarray(12, 12 + length));
      packet(
        bytes,
        Number(flags & ((1n << 61n) - 1n)),
        Boolean(flags & (1n << 62n)),
        Boolean(flags & (1n << 61n)),
      );
      this.buffer = this.buffer.subarray(12 + length);
    }
  }
}

function avcCodec(bytes: Buffer) {
  for (let i = 0; i + 7 < bytes.length; i++) {
    const start = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 ? i + 3 : -1;
    if (start >= 0 && (bytes[start]! & 31) === 7)
      return `avc1.${bytes.subarray(start + 1, start + 4).toString('hex')}`;
  }
  return undefined;
}

/** Retains one bounded, decodable GOP. Never discard a P frame and continue its dependents. */
export class EncodedVideo {
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private retryAfter = 0;
  private sequence = 0;
  private epoch = 0;
  private width = 0;
  private height = 0;
  private codec?: string;
  private config: Buffer = Buffer.alloc(0);
  private packets: EncodedPacket[] = [];
  private bytes = 0;
  private capturedAt = '';
  constructor(private readonly producer: VideoProducer) {}
  read(after = 0): EncodedBatch | undefined {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), 5000);
    this.timer.unref();
    if (!this.controller && Date.now() >= this.retryAfter) {
      const controller = new AbortController(),
        parser = new ScrcpyParser();
      this.controller = controller;
      void this.producer(controller.signal, (chunk) => {
        if (controller.signal.aborted) return;
        parser.push(
          chunk,
          (w, h) => {
            this.epoch++;
            this.width = w;
            this.height = h;
            this.packets = [];
            this.config = Buffer.alloc(0);
            this.codec = undefined;
            this.bytes = 0;
          },
          (bytes, timestamp, config, key) => {
            if (config) {
              if (bytes.length > 65536) throw new Error('Codec configuration too large');
              this.config = bytes;
              this.codec = avcCodec(bytes);
              return;
            }
            if (!this.codec || !this.width) return;
            if (key) {
              this.packets = [];
              this.bytes = 0;
              bytes = Buffer.concat([this.config, bytes]);
            }
            if (!key && !this.packets.length) return;
            if (this.bytes + bytes.length > 4 * 1024 * 1024 || this.packets.length >= 180) {
              this.packets = [];
              this.bytes = 0;
              return;
            }
            this.packets.push({ sequence: ++this.sequence, timestamp, key, bytes });
            this.bytes += bytes.length;
            this.capturedAt = new Date().toISOString();
          },
        );
      })
        .catch(() => {})
        .finally(() => {
          if (this.controller === controller) {
            this.controller = undefined;
            this.packets = [];
            this.retryAfter = Date.now() + 5000;
          }
        });
    }
    if (!this.codec || !this.packets.length) return;
    const reset = after === 0 || after < this.packets[0]!.sequence - 1;
    const packets = reset ? this.packets : this.packets.filter((p) => p.sequence > after);
    return {
      codec: this.codec,
      width: this.width,
      height: this.height,
      epoch: this.epoch,
      capturedAt: this.capturedAt,
      packets,
      reset,
    };
  }
  stop() {
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
    this.packets = [];
    this.bytes = 0;
  }
}
