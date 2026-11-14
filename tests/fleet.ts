import { DemoAdapter } from '../src/adapters/demo.js';
import type { Device, DeviceAdapter, DriverAction } from '../src/core/types.js';

/** Independent virtual phones; only used by tests, never advertised as real platforms. */
export class Fleet implements DeviceAdapter {
  readonly platform = 'demo' as const;
  readonly phones = new Map<string, DemoAdapter>();
  readonly calls: { device: string; action: DriverAction }[] = [];
  readonly captures = new Map<string, number>();
  broken = new Set<string>();
  constructor(count = 2) {
    for (let i = 0; i < count; i++) this.phones.set(`demo:phone-${i + 1}`, new DemoAdapter());
  }
  async discover(): Promise<Device[]> {
    return [...this.phones.keys()].map((id, i) => ({
      id,
      platform: this.platform,
      name: i === 0 ? 'Foldable · 虚拟折叠设备' : `Phone ${i + 1} · 虚拟设备`,
      transport: 'memory',
    }));
  }
  async inspect(device: Device) {
    return this.phones.get(device.id)!.inspect(device);
  }
  async capture(device: Device) {
    this.captures.set(device.id, (this.captures.get(device.id) ?? 0) + 1);
    if (this.broken.has(device.id)) throw new Error('Test device disconnected');
    return this.phones.get(device.id)!.capture();
  }
  async inputDisplay(device: Device) {
    return this.phones.get(device.id)!.inputDisplay();
  }
  async tree(device: Device) {
    return this.phones.get(device.id)!.tree();
  }
  async execute(device: Device, action: DriverAction) {
    this.calls.push({ device: device.id, action });
    await this.phones.get(device.id)!.execute(device, action);
  }
}
