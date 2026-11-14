#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  analyzePage,
  formatPage,
  parseHarmonyTree,
  parseAndroidTree,
  parseIOSTree,
} from '../dist/src/index.js';

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    input: { type: 'string', default: '-' },
    query: { type: 'string' },
    'max-nodes': { type: 'string', default: '200' },
    json: { type: 'boolean', default: false },
  },
});
try {
  const parsers = { harmonyos: parseHarmonyTree, android: parseAndroidTree, ios: parseIOSTree };
  const parser = parsers[values.platform];
  if (!parser) throw new Error('--platform must be harmonyos, android or ios.');
  const limit = 8 * 1024 * 1024;
  let bytes;
  if (values.input === '-') {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > limit) throw new Error('Page dump exceeds 8 MiB.');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } else {
    if ((await stat(values.input)).size > limit) throw new Error('Page dump exceeds 8 MiB.');
    bytes = await readFile(values.input);
  }
  if (bytes.length > limit) throw new Error('Page dump exceeds 8 MiB.');
  const raw = bytes.toString('utf8');
  const result = analyzePage(
    parser(values.platform === 'android' ? raw : JSON.parse(raw)),
    Number(values['max-nodes']),
    values.query,
  );
  console.log(
    values.json
      ? JSON.stringify({ offline: true, platform: values.platform, ...result }, null, 2)
      : `Offline page analysis; no live observation ID, no device actions.\n${formatPage(result.nodes, result.page)}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
