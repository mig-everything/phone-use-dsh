#!/usr/bin/env node
import { access } from 'node:fs/promises';
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(
    'Phone Use requires Node.js 22 or later. Install Node.js, then reinstall the plugin.',
  );
  process.exit(1);
}
const entry = new URL('../dist/src/cli.js', import.meta.url);
try {
  await access(entry);
} catch {
  console.error(
    'Phone Use is not built. Run npm ci && npm run build in the plugin directory first.',
  );
  process.exit(1);
}
await import(entry.href);
