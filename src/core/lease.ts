import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PhoneError } from './errors.js';

/** One host process/session owns a device; never steal a lock merely because it is old. */
export class DeviceLease {
  private readonly token = randomUUID();
  private constructor(readonly path: string) {}
  static async acquire(directory: string, deviceId: string): Promise<DeviceLease> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lease = new DeviceLease(
      join(directory, `${createHash('sha256').update(deviceId).digest('hex')}.lock`),
    );
    let file;
    try {
      file = await open(lease.path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new PhoneError(
          'DEVICE_BUSY',
          `Another session owns this device. Close it first. If it crashed, verify its PID before removing ${lease.path}.`,
        );
      throw e;
    }
    try {
      await file.writeFile(
        JSON.stringify({
          pid: process.pid,
          token: lease.token,
          createdAt: new Date().toISOString(),
        }),
      );
    } catch (e) {
      await unlink(lease.path).catch(() => {});
      throw e;
    } finally {
      await file.close();
    }
    return lease;
  }
  async release() {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      if (state.token === this.token) await unlink(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
