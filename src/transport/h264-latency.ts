/** Signal zero display reordering for our explicitly no-B-frame host encoders.
 * VideoToolbox can omit this VUI field even with AllowFrameReordering=false.
 * WebCodecs hardware decoders then wait for future frames, deadlocking a static
 * screen with render acknowledgements. Never apply this to arbitrary video.
 * Layout: H.264 SPS / VUI / HRD; the same constraint is used by WebRTC.
 */
class Bits {
  at = 0;
  constructor(readonly values: number[]) {}
  read(n = 1): number {
    if (n > 32 || this.at + n > this.values.length) throw new Error('Truncated H.264 SPS');
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 2 + this.values[this.at++]!;
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (!this.read()) if (++zeros > 24) throw new Error('Invalid H.264 integer');
    return 2 ** zeros - 1 + this.read(zeros);
  }
  se(): number {
    const value = this.ue();
    return value % 2 ? (value + 1) / 2 : -value / 2;
  }
}
const ue = (value: number) => {
  const bits = (value + 1).toString(2);
  return [...'0'.repeat(bits.length - 1), ...bits].map(Number);
};
function hrd(bits: Bits) {
  const count = bits.ue();
  if (count > 31) throw new Error('Invalid H.264 HRD');
  bits.read(8);
  for (let i = 0; i <= count; i++) {
    bits.ue();
    bits.ue();
    bits.read();
  }
  bits.read(20);
}
export function noReorderSps(nal: Buffer): Buffer {
  if ((nal[0]! & 31) !== 7 || nal.length < 5 || nal.length > 65536)
    throw new Error('Invalid H.264 SPS');
  const raw: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) {
      if (i + 1 >= nal.length || nal[i + 1]! > 3) throw new Error('Invalid H.264 escaping');
      continue;
    }
    raw.push(nal[i]!);
  }
  const bits = new Bits(
    raw.flatMap((n) => Array.from({ length: 8 }, (_, i) => (n >> (7 - i)) & 1)),
  );
  const profile = bits.read(8);
  bits.read(16);
  bits.ue();
  if (![66, 77, 100].includes(profile)) throw new Error('Unsupported host H.264 profile');
  if (profile === 100) {
    const chroma = bits.ue();
    if (chroma > 3) throw new Error('Invalid H.264 chroma');
    if (chroma === 3) bits.read();
    bits.ue();
    bits.ue();
    bits.read();
    if (bits.read())
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!bits.read()) continue;
        let last = 8,
          next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
          if (next) next = (last + bits.se() + 256) % 256;
          if (next) last = next;
        }
      }
  }
  bits.ue();
  const poc = bits.ue();
  if (poc === 0) bits.ue();
  else if (poc === 1) {
    bits.read();
    bits.se();
    bits.se();
    const count = bits.ue();
    if (count > 255) throw new Error('Invalid H.264 POC');
    for (let i = 0; i < count; i++) bits.se();
  } else if (poc !== 2) throw new Error('Invalid H.264 POC type');
  const references = bits.ue();
  if (references > 16) throw new Error('Invalid H.264 reference count');
  bits.read();
  bits.ue();
  bits.ue();
  if (!bits.read()) bits.read();
  bits.read();
  if (bits.read()) for (let i = 0; i < 4; i++) bits.ue();
  const vuiAt = bits.at,
    hasVui = bits.read();
  if (hasVui) {
    if (bits.read() && bits.read(8) === 255) bits.read(32);
    if (bits.read()) bits.read();
    if (bits.read()) {
      bits.read(4);
      if (bits.read()) bits.read(24);
    }
    if (bits.read()) {
      bits.ue();
      bits.ue();
    }
    if (bits.read()) {
      bits.read(32);
      bits.read(32);
      bits.read();
    }
    const nalHrd = bits.read();
    if (nalHrd) hrd(bits);
    const vclHrd = bits.read();
    if (vclHrd) hrd(bits);
    if (nalHrd || vclHrd) bits.read();
    bits.read();
  }
  const restrictionAt = bits.at;
  let prefix: number[], restriction: number[];
  if (hasVui && bits.read()) {
    bits.read();
    for (let i = 0; i < 4; i++) bits.ue();
    prefix = bits.values.slice(0, bits.at);
    bits.ue();
    bits.ue();
    restriction = [...ue(0), ...ue(Math.max(1, references))];
  } else {
    prefix = hasVui
      ? bits.values.slice(0, restrictionAt)
      : [...bits.values.slice(0, vuiAt), 1, 0, 0, 0, 0, 0, 0, 0, 0];
    restriction = [
      1,
      1,
      ...ue(2),
      ...ue(1),
      ...ue(16),
      ...ue(16),
      ...ue(0),
      ...ue(Math.max(1, references)),
    ];
  }
  // No unknown extension data is silently discarded.
  if (bits.read() !== 1 || bits.values.slice(bits.at).some(Boolean))
    throw new Error('Invalid H.264 SPS trailing bits');
  const output = [...prefix, ...restriction, 1];
  while (output.length % 8) output.push(0);
  const bytes = [nal[0]!];
  let zeros = 0;
  for (let i = 0; i < output.length; i += 8) {
    const value = output.slice(i, i + 8).reduce((n, b) => n * 2 + b, 0);
    if (zeros >= 2 && value <= 3) {
      bytes.push(3);
      zeros = 0;
    }
    bytes.push(value);
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(bytes);
}
