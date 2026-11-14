import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { OcrProvider, OcrText } from '../core/ocr.js';
import type { Frame } from '../core/types.js';

/** OS Vision, invoked through JXA: no Xcode, Python, pip or downloaded model dependency. */
export class MacVisionOcr implements OcrProvider {
  readonly id = 'macos-vision';
  constructor(readonly languages = ['zh-Hans', 'en-US']) {}
  async recognize(frame: Frame, { signal }: { signal: AbortSignal }): Promise<OcrText[]> {
    if (process.platform !== 'darwin') throw new Error('macOS Vision is unavailable');
    signal.throwIfAborted();
    const bytes = await sharp(frame.bytes)
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    signal.throwIfAborted();
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          fileURLToPath(new URL('../../../native/vision-ocr.js', import.meta.url)),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], signal },
      );
      const chunks: Buffer[] = [];
      let length = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 512 * 1024) {
          child.kill();
          reject(new Error('OCR output limit'));
        } else chunks.push(chunk);
      });
      // Never echo device-derived text or image data to the MCP transport.
      child.stderr.resume();
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks).toString('utf8'))
          : reject(new Error('Vision failed')),
      );
      child.stdin.end(
        JSON.stringify({
          image: bytes.toString('base64'),
          level: 'accurate',
          languages: this.languages,
        }),
      );
    });
    const parsed = JSON.parse(output) as { items: OcrText[] };
    return parsed.items.map((item) => ({
      ...item,
      bounds: {
        x: item.bounds.x * frame.display.width,
        y: item.bounds.y * frame.display.height,
        width: item.bounds.width * frame.display.width,
        height: item.bounds.height * frame.display.height,
      },
    }));
  }
}
