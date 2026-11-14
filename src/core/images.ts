import { PhoneError } from './errors.js';
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new PhoneError('INVALID_FRAME', 'Device did not return a PNG screenshot.');
  }
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384)
    throw new PhoneError('INVALID_FRAME', 'Unsupported screenshot dimensions.');
  return { width, height };
}
