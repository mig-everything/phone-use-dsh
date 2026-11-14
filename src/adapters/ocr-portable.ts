import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';
import type { OcrProvider, OcrText } from '../core/ocr.js';
import type { Frame } from '../core/types.js';

const bundled = fileURLToPath(new URL('../../../assets/ocr/', import.meta.url));
const hashes: Record<string, string> = {
  chi_sim: 'a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730',
  eng: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2',
};
const aliases: Record<string, string> = { 'zh-Hans': 'chi_sim', 'en-US': 'eng', en: 'eng' };

/** One disposable process; the pool below bounds CPU and memory across devices. */
class PortableOcrWorker implements OcrProvider {
  readonly id = 'tesseract-fast';
  readonly languages: string[];
  private child?: ChildProcess;
  private idle?: ReturnType<typeof setTimeout>;
  busy = false;
  constructor(
    languages = ['chi_sim', 'eng'],
    private readonly modelsDirectory = bundled,
  ) {
    this.languages = [...new Set(languages.map((l) => aliases[l] ?? l))];
    if (!this.languages.length || this.languages.some((l) => !hashes[l]))
      throw new Error(
        'Bundled OCR supports chi_sim/zh-Hans and eng/en-US. Inject a provider for other languages.',
      );
  }
  async recognize(frame: Frame, { signal }: { signal: AbortSignal }): Promise<OcrText[]> {
    signal.throwIfAborted();
    if (this.busy) throw new Error('Use OcrEngine to queue concurrent recognition.');
    this.busy = true;
    clearTimeout(this.idle);
    const cancel = () => this.stop();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (!this.child) {
        for (const language of this.languages) {
          const data = await readFile(join(this.modelsDirectory, `${language}.traineddata`));
          if (createHash('sha256').update(data).digest('hex') !== hashes[language])
            throw new Error('OCR model integrity check failed.');
        }
        signal.throwIfAborted();
        this.child = fork(
          fileURLToPath(new URL('../../../native/portable-ocr.cjs', import.meta.url)),
          [],
          {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            serialization: 'advanced',
            execArgv: [],
          },
        );
        // Request listeners handle failures; this prevents an idle process error becoming uncaught.
        const child = this.child;
        child.on('error', () => {
          if (this.child === child) this.stop();
        });
        child.on('exit', () => {
          if (this.child === child) this.child = undefined;
        });
      }
      const source = sharp(frame.bytes);
      const metadata = await source.metadata();
      if (metadata.width !== frame.display.width || metadata.height !== frame.display.height)
        throw new Error('OCR image geometry mismatch.');
      const { data, info } = await source
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      signal.throwIfAborted();
      const child = this.child!;
      const items = await new Promise<OcrText[]>((resolve, reject) => {
        const cleanup = () => {
          child.off('message', message);
          child.off('exit', failed);
          child.off('error', failed);
        };
        const failed = () => {
          cleanup();
          reject(new Error('OCR process stopped.'));
        };
        const message = (value: any) => {
          cleanup();
          if (Array.isArray(value?.items)) resolve(value.items);
          else reject(new Error('OCR recognition failed.'));
        };
        child.once('message', message);
        child.once('exit', failed);
        child.once('error', failed);
        child.send(
          { image: data, languages: this.languages, models: this.modelsDirectory },
          (error) => {
            if (error) failed();
          },
        );
      });
      const sx = frame.display.width / info.width,
        sy = frame.display.height / info.height;
      return items.map((item) => ({
        ...item,
        bounds: {
          x: item.bounds.x * sx,
          y: item.bounds.y * sy,
          width: item.bounds.width * sx,
          height: item.bounds.height * sy,
        },
      }));
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      this.busy = false;
      if (this.child) {
        this.idle = setTimeout(() => this.stop(), 60_000);
        this.idle.unref();
      }
    }
  }
  private stop() {
    clearTimeout(this.idle);
    this.child?.kill();
    this.child = undefined;
  }
  async dispose() {
    this.stop();
  }
}

/** Lazy pool: three selected devices can recognize concurrently without creating unbounded workers. */
export class PortableOcr implements OcrProvider {
  readonly id = 'tesseract-fast';
  readonly languages: string[];
  private readonly workers: PortableOcrWorker[];
  constructor(
    languages = ['chi_sim', 'eng'],
    readonly maxConcurrency = 3,
    modelsDirectory = bundled,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 3)
      throw new Error('OCR workers must be between 1 and 3.');
    this.workers = Array.from(
      { length: maxConcurrency },
      () => new PortableOcrWorker(languages, modelsDirectory),
    );
    this.languages = this.workers[0]!.languages;
  }
  recognize(frame: Frame, options: { signal: AbortSignal }) {
    const worker = this.workers.find((w) => !w.busy);
    if (!worker) return Promise.reject(new Error('Use OcrEngine for bounded OCR queuing.'));
    return worker.recognize(frame, options);
  }
  async dispose() {
    await Promise.all(this.workers.map((w) => w.dispose()));
  }
}
