import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { PhoneError } from '../core/errors.js';
import type { DriverAction } from '../core/types.js';

export function touchPacket(action: number, x: number, y: number, width: number, height: number) {
  const b = Buffer.alloc(32);
  b[0] = 2;
  b[1] = action;
  b.writeBigInt64BE(-2n, 2); // scrcpy virtual finger (not the mouse pointer).
  b.writeUInt32BE(Math.max(0, Math.min(width - 1, Math.round(x))), 10);
  b.writeUInt32BE(Math.max(0, Math.min(height - 1, Math.round(y))), 14);
  b.writeUInt16BE(width, 18);
  b.writeUInt16BE(height, 20);
  b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);
  return b;
}
function keyPacket(action: number, key: number) {
  const b = Buffer.alloc(14);
  b[1] = action;
  b.writeUInt32BE(key, 2);
  return b;
}
/** Writes once to the native control socket. A failed/partial write is never replayed via ADB. */
export async function scrcpyAction(
  socket: Socket,
  action: DriverAction,
  width: number,
  height: number,
) {
  if (
    !['tap', 'swipe', 'key', 'pointer'].includes(action.kind) ||
    socket.destroyed ||
    !socket.writable
  )
    return false;
  const write = (bytes: Buffer) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new PhoneError(
              'ACTION_UNCERTAIN',
              'Native input acknowledgement timed out; observe before continuing.',
              true,
            ),
          ),
        2000,
      );
      socket.write(bytes, (error) => {
        clearTimeout(timer);
        error
          ? reject(
              new PhoneError(
                'ACTION_UNCERTAIN',
                'Native input connection closed; observe before continuing.',
                true,
              ),
            )
          : resolve();
      });
    });
  if (action.kind === 'pointer') {
    await write(
      touchPacket(
        action.phase === 'down' ? 0 : action.phase === 'move' ? 2 : 1,
        action.x,
        action.y,
        width,
        height,
      ),
    );
    return true;
  }
  if (action.kind === 'key') {
    const key = ({ home: 3, back: 4, enter: 66 } as Record<string, number>)[action.key];
    if (key === undefined) return false;
    await write(Buffer.concat([keyPacket(0, key), keyPacket(1, key)]));
    return true;
  }
  if (action.kind !== 'tap' && action.kind !== 'swipe') return false;
  if (width < 1 || height < 1 || width > 65535 || height > 65535) return false;
  await write(touchPacket(0, action.x, action.y, width, height));
  try {
    if (action.kind === 'swipe') {
      const started = performance.now();
      while (true) {
        await delay(16);
        const progress = Math.min(1, (performance.now() - started) / action.durationMs);
        await write(
          touchPacket(
            2,
            action.x + (action.toX - action.x) * progress,
            action.y + (action.toY - action.y) * progress,
            width,
            height,
          ),
        );
        if (progress === 1) break;
      }
    }
  } finally {
    // Always lift an accepted finger, even if a move failed. Never replay the gesture.
    await write(
      touchPacket(
        1,
        action.kind === 'swipe' ? action.toX : action.x,
        action.kind === 'swipe' ? action.toY : action.y,
        width,
        height,
      ),
    );
  }
  return true;
}
