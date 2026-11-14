import { deflateSync } from 'node:zlib';
import type {
  Device,
  DeviceAdapter,
  DeviceInfo,
  DriverAction,
  Frame,
  Display,
  Posture,
  UINode,
} from '../core/types.js';

// Small programmatic PNG fixture: usable offline, clearly a simulated device.
function crc32(bytes: Buffer) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer) {
  const type = Buffer.from(name),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
export function demoPng(width: number, height: number, active = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * (width * 3 + 1) + 1 + x * 3;
      const button = x > width * 0.12 && x < width * 0.88 && y > height * 0.42 && y < height * 0.58;
      const card = x > width * 0.08 && x < width * 0.92 && y > height * 0.18 && y < height * 0.78;
      const color = button
        ? active
          ? [48, 192, 151]
          : [77, 133, 248]
        : card
          ? [34, 44, 63]
          : [16, 23, 37];
      raw[index] = color[0]!;
      raw[index + 1] = color[1]!;
      raw[index + 2] = color[2]!;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export class DemoAdapter implements DeviceAdapter {
  readonly platform = 'demo' as const;
  posture: Posture = 'folded';
  active = false;
  text = '';
  async discover(): Promise<Device[]> {
    return [
      {
        id: 'demo:foldable',
        platform: this.platform,
        name: 'Demo foldable · virtual device',
        transport: 'memory',
      },
    ];
  }
  async inspect(device: Device): Promise<DeviceInfo> {
    return {
      ...device,
      version: 'virtual-1',
      capabilities: {
        screenshot: true,
        tree: true,
        tap: true,
        swipe: true,
        text: 'unicode',
        keys: ['home', 'back', 'enter'],
        launch: true,
        displayState: true,
        foldControl: true,
        stream: 'snapshots',
      },
    };
  }
  async capture(): Promise<Frame> {
    const width = this.posture === 'expanded' ? 720 : 360,
      height = 720;
    return {
      bytes: demoPng(width, height, this.active),
      mimeType: 'image/png',
      display: {
        id: 'demo',
        width,
        height,
        inputWidth: width,
        inputHeight: height,
        rotation: 0,
        posture: this.posture,
      },
    };
  }
  async inputDisplay(): Promise<Display> {
    const width = this.posture === 'expanded' ? 720 : 360,
      height = 720;
    return {
      id: 'demo',
      width,
      height,
      inputWidth: width,
      inputHeight: height,
      rotation: 0,
      posture: this.posture,
    };
  }
  async tree(): Promise<UINode[]> {
    const w = this.posture === 'expanded' ? 720 : 360;
    return [
      {
        id: 'input',
        text: this.text,
        type: 'TextInput',
        resourceId: 'demo-input',
        enabled: true,
        focused: this.active,
        clickable: true,
        bounds: { x: w * 0.12, y: 302, width: w * 0.76, height: 116 },
      },
    ];
  }
  async execute(_device: Device, a: DriverAction) {
    if (a.kind === 'fold') this.posture = a.posture;
    if (a.kind === 'tap') this.active = true;
    if (a.kind === 'text') this.text += a.text;
    if (a.kind === 'key' && a.key === 'home') {
      this.active = false;
      this.text = '';
    }
  }
}
