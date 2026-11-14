// Synthetic, offline bilingual smoke check. Never opens or locks a phone.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv.includes('--installed')
  ? join(homedir(), '.codex', 'plugins', 'phone-use-local')
  : resolve('.');
const { OcrEngine, PortableOcr } = await import(
  pathToFileURL(join(root, 'dist/src/index.js')).href
);
const engine = new OcrEngine(new PortableOcr(), 10_000);
try {
  const bytes = await readFile(join(root, 'assets/ocr/self-test.png'));
  const result = await engine.recognize({
    bytes,
    mimeType: 'image/png',
    display: {
      id: 'synthetic',
      width: 1000,
      height: 600,
      inputWidth: 1000,
      inputHeight: 600,
      rotation: 0,
      posture: 'unknown',
    },
  });
  const text = result.items
    .map((item) => item.text)
    .join('')
    .replace(/\s/g, '');
  const valid = result.status === 'ok' && text.includes('Continue') && text.includes('继续');
  console.log(
    JSON.stringify({
      synthetic: true,
      installed: process.argv.includes('--installed'),
      provider: result.provider,
      status: result.status,
      bilingual: valid,
      elapsed_ms: result.elapsed_ms,
      boxes: result.items.length,
    }),
  );
  if (!valid) process.exitCode = 1;
} finally {
  await engine.dispose();
}
