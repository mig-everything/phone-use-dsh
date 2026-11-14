/** Bounded single-track H.264 fMP4 demuxer for idb/FFmpeg live output.
 * ISO BMFF fragment fields follow idb 1.7.3 FBVideoCore/Writers/FMP4.swift.
 * No decoding or re-encoding: preserve access units and presentation timestamps.
 */
import { noReorderSps } from './h264-latency.js';
type Box = { type: string; bytes: Buffer; header: number; offset: number };
const MAX_BOX = 8 * 1024 * 1024;
function sizeAt(bytes: Buffer, offset: number) {
  if (offset + 8 > bytes.length) return;
  const size32 = bytes.readUInt32BE(offset);
  if (size32 === 1 && offset + 16 > bytes.length) return;
  const size = size32 === 1 ? Number(bytes.readBigUInt64BE(offset + 8)) : size32;
  const header = size32 === 1 ? 16 : 8;
  if (!Number.isSafeInteger(size) || size < header || size > MAX_BOX)
    throw new Error('Invalid or oversized MP4 box');
  return { size, header };
}
function boxes(bytes: Buffer, start = 0): Box[] {
  const result: Box[] = [];
  for (let offset = start; offset < bytes.length; ) {
    const info = sizeAt(bytes, offset);
    if (!info || offset + info.size > bytes.length) throw new Error('Truncated MP4 box');
    result.push({
      type: bytes.toString('ascii', offset + 4, offset + 8),
      bytes: bytes.subarray(offset, offset + info.size),
      header: info.header,
      offset,
    });
    offset += info.size;
  }
  return result;
}
function body(box: Box) {
  return box.bytes.subarray(box.header);
}
function child(parent: Box, name: string): Box {
  const found = boxes(body(parent)).find((b) => b.type === name);
  if (!found) throw new Error(`Missing MP4 ${name}`);
  return found;
}
function flags(bytes: Buffer) {
  return bytes.readUInt32BE(0) & 0xffffff;
}
function framed(bytes: Buffer, pts: number, config: boolean, key: boolean) {
  if (!Number.isSafeInteger(pts) || pts < 0) throw new Error('Invalid video timestamp');
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(BigInt(pts) | (config ? 1n << 62n : 0n) | (key ? 1n << 61n : 0n));
  header.writeUInt32BE(bytes.length, 8);
  return Buffer.concat([header, bytes]);
}
function parameterSets(avc: Buffer, noReordering: boolean) {
  if (avc.length < 7 || avc[0] !== 1) throw new Error('Invalid AVC configuration');
  let offset = 6;
  const nals: Buffer[] = [];
  for (const count of [avc[5]! & 31, -1]) {
    const n = count < 0 ? avc[offset++] : count;
    if (!n || n > 32) throw new Error('Missing AVC parameter sets');
    for (let i = 0; i < n; i++) {
      const length = avc.readUInt16BE(offset);
      offset += 2;
      if (length === 0 || offset + length > avc.length)
        throw new Error('Truncated AVC parameter set');
      const nal = avc.subarray(offset, offset + length);
      nals.push(Buffer.from([0, 0, 0, 1]), noReordering && count >= 0 ? noReorderSps(nal) : nal);
      offset += length;
    }
  }
  return { lengthSize: (avc[4]! & 3) + 1, config: Buffer.concat(nals) };
}
function annexB(bytes: Buffer, lengthSize: number, noReordering: boolean) {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    if (offset + lengthSize > bytes.length) throw new Error('Truncated AVC NAL length');
    const length = bytes.readUIntBE(offset, lengthSize);
    offset += lengthSize;
    if (!length || offset + length > bytes.length) throw new Error('Invalid AVC NAL size');
    const nal = bytes.subarray(offset, offset + length);
    parts.push(
      Buffer.from([0, 0, 0, 1]),
      noReordering && (nal[0]! & 31) === 7 ? noReorderSps(nal) : nal,
    );
    offset += length;
  }
  return Buffer.concat(parts);
}
type Sample = { size: number; pts: number; key: boolean; offset: number };
export class Fmp4Video {
  private buffer: Buffer = Buffer.alloc(0);
  private position = 0;
  private started = false;
  private timescale = 0;
  private track = 0;
  private lengthSize = 4;
  private defaults = { duration: 0, size: 0, flags: 0 };
  private pending: Sample[] = [];
  constructor(
    private readonly receive: (chunk: Uint8Array) => void,
    private readonly noReordering = false,
  ) {}
  push(chunk: Uint8Array) {
    if (chunk.byteLength + this.buffer.length > MAX_BOX + 65536)
      throw new Error('MP4 buffer limit');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const info = sizeAt(this.buffer, 0);
      if (!info || this.buffer.length < info.size) return;
      const box = {
        type: this.buffer.toString('ascii', 4, 8),
        bytes: this.buffer.subarray(0, info.size),
        header: info.header,
        offset: this.position,
      };
      if (box.type === 'moov') this.initialize(box);
      else if (box.type === 'moof') this.fragment(box);
      else if (box.type === 'mdat') this.media(box);
      this.position += info.size;
      this.buffer = this.buffer.subarray(info.size);
    }
  }
  finish() {
    if (this.buffer.length || this.pending.length) throw new Error('Truncated MP4 stream');
  }
  private initialize(box: Box) {
    if (this.pending.length) throw new Error('MP4 format changed during a fragment');
    const tracks = boxes(body(box)).filter((b) => b.type === 'trak');
    if (tracks.length !== 1) throw new Error('Expected one video track');
    const track = tracks[0]!,
      mdia = child(track, 'mdia');
    const tkhd = body(child(track, 'tkhd')),
      mdhd = body(child(mdia, 'mdhd'));
    this.track = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12);
    this.timescale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
    if (!this.track || !this.timescale) throw new Error('Invalid MP4 track clock');
    const stsd = body(child(child(child(mdia, 'minf'), 'stbl'), 'stsd'));
    const entries = boxes(stsd, 8),
      entry = entries[0];
    if (entries.length !== 1 || entry?.type !== 'avc1') throw new Error('Expected AVC video');
    const visual = body(entry),
      width = visual.readUInt16BE(24),
      height = visual.readUInt16BE(26);
    if (width < 64 || height < 64 || width * height > 40_000_000)
      throw new Error('Invalid MP4 dimensions');
    const avc = boxes(visual, 78).find((b) => b.type === 'avcC');
    if (!avc) throw new Error('Missing AVC configuration');
    const config = parameterSets(body(avc), this.noReordering);
    this.lengthSize = config.lengthSize;
    const trex = body(child(child(box, 'mvex'), 'trex'));
    if (trex.readUInt32BE(4) !== this.track) throw new Error('Mismatched MP4 defaults');
    this.defaults = {
      duration: trex.readUInt32BE(12),
      size: trex.readUInt32BE(16),
      flags: trex.readUInt32BE(20),
    };
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header.writeUInt32BE(width, 4);
    header.writeUInt32BE(height, 8);
    if (!this.started) {
      this.receive(Buffer.from('h264'));
      this.started = true;
    }
    this.receive(header);
    this.receive(framed(config.config, 0, true, false));
  }
  private fragment(box: Box) {
    if (!this.started || this.pending.length) throw new Error('Unexpected MP4 fragment');
    const fragments = boxes(body(box)).filter((b) => b.type === 'traf');
    if (fragments.length !== 1) throw new Error('Expected one video fragment');
    const traf = fragments[0]!,
      tfhd = body(child(traf, 'tfhd')),
      tfdt = body(child(traf, 'tfdt'));
    const f = flags(tfhd);
    if (tfhd.readUInt32BE(4) !== this.track) throw new Error('Unexpected MP4 track');
    let offset = 8,
      base = box.offset;
    if (f & 1) {
      base = Number(tfhd.readBigUInt64BE(offset));
      offset += 8;
    } else if (!(f & 0x020000)) throw new Error('Unsupported implicit MP4 base');
    if (f & 2) offset += 4;
    const defaults = { ...this.defaults };
    for (const [mask, name] of [
      [8, 'duration'],
      [16, 'size'],
      [32, 'flags'],
    ] as const)
      if (f & mask) {
        defaults[name] = tfhd.readUInt32BE(offset);
        offset += 4;
      }
    let dts = tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4),
      cursor = -1;
    for (const run of boxes(body(traf)).filter((b) => b.type === 'trun')) {
      const data = body(run),
        rf = flags(data),
        count = data.readUInt32BE(4);
      if (!count || count + this.pending.length > 180)
        throw new Error('Invalid MP4 fragment sample count');
      let at = 8,
        firstFlags: number | undefined;
      if (rf & 1) {
        cursor = base + data.readInt32BE(at);
        at += 4;
      }
      if (rf & 4) {
        firstFlags = data.readUInt32BE(at);
        at += 4;
      }
      if (cursor < 0) throw new Error('Missing MP4 data offset');
      for (let i = 0; i < count; i++) {
        const sample = { ...defaults };
        for (const [mask, name] of [
          [256, 'duration'],
          [512, 'size'],
          [1024, 'flags'],
        ] as const)
          if (rf & mask) {
            sample[name] = data.readUInt32BE(at);
            at += 4;
          }
        if (i === 0 && firstFlags !== undefined) sample.flags = firstFlags;
        let composition = 0;
        if (rf & 2048) {
          composition = data[0] === 1 ? data.readInt32BE(at) : data.readUInt32BE(at);
          at += 4;
        }
        if (this.noReordering && composition !== 0)
          throw new Error('Host encoder unexpectedly reordered video');
        if (!sample.size || sample.size > 4 * 1024 * 1024)
          throw new Error('Invalid MP4 sample size');
        const pts = Math.round(((dts + composition) * 1_000_000) / this.timescale);
        if (!Number.isSafeInteger(pts) || pts < 0 || !Number.isSafeInteger(cursor))
          throw new Error('Invalid MP4 timestamp or offset');
        this.pending.push({
          size: sample.size,
          pts,
          key: !(sample.flags & 0x10000),
          offset: cursor,
        });
        dts += sample.duration;
        cursor += sample.size;
      }
    }
    if (!this.pending.length) throw new Error('Empty MP4 fragment');
  }
  private media(box: Box) {
    if (!this.pending.length) throw new Error('Unexpected MP4 media');
    for (const sample of this.pending) {
      const start = sample.offset - box.offset;
      if (start < box.header || start + sample.size > box.bytes.length)
        throw new Error('MP4 sample out of bounds');
      this.receive(
        framed(
          annexB(
            box.bytes.subarray(start, start + sample.size),
            this.lengthSize,
            this.noReordering,
          ),
          sample.pts,
          false,
          sample.key,
        ),
      );
    }
    this.pending = [];
  }
}
