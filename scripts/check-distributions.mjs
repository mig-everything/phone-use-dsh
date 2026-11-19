#!/usr/bin/env node
// Exercise the released archives with independently installed production dependencies.
// All device operations use the demo adapter and a temporary state directory.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const npm = process.env.npm_execpath;
assert(npm, 'Run npm run check:distributions.');
const temporary = await mkdtemp(join(tmpdir(), 'phone-use-distributions-'));
const npmRun = (cwd, args) =>
  execFileSync(process.execPath, [npm, ...args, '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd,
    stdio: 'inherit',
    timeout: 240000,
  });

async function unpack(name, top) {
  const archive = join(root, 'releases', name);
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  assert.equal((await readFile(`${archive}.sha256`, 'utf8')).trim(), `${digest}  ${name}`);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert(entries.every((p) => p.startsWith(top + '/') && !p.split('/').includes('..')));
  const target = join(temporary, name);
  await mkdir(target);
  execFileSync('tar', ['-xzf', archive, '-C', target]);
  const folder = join(target, top);
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = relative(folder, path).replaceAll('\\', '/');
      assert(!entry.isSymbolicLink(), `Unexpected symlink: ${name}`);
      assert(
        !/(^|\/)(?:\.git|\.phone-use|node_modules|\.env(?:\..*)?|\.npmrc|phone-use\.local\.json)(?:\/|$)/.test(
          name,
        ) &&
          !/\.(?:pem|p12|pfx|key)$/.test(name) &&
          !/(^|\/)\._/.test(name),
        `Local or credential file in archive: ${name}`,
      );
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:json|js|mjs|cjs|map|html|md|yml|ts|cpp|h|mm)$/.test(name)) {
        const content = await readFile(path, 'utf8');
        assert(!/\/Users\/[^/\s]+\//.test(content), `Local user path in ${name}`);
        assert(
          !/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content),
          `Private key in ${name}`,
        );
        assert(
          !/(?:gh[pousr]_[A-Za-z0-9_]{25,}|npm_[A-Za-z0-9]{20,})/.test(content),
          `Credential in ${name}`,
        );
      }
    }
  }
  await walk(folder);
  const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version);
  for (const name of ['plugin.json', '.codex-plugin/plugin.json'])
    assert.equal(JSON.parse(await readFile(join(folder, name), 'utf8')).version, version);
  return { archive, folder };
}

const fixture = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createService } from 'phone-use';
import { createMcpServer, UI_URI } from 'phone-use/mcp';
import * as preview from 'phone-use/preview';
import * as dsh from 'phone-use/dsh';
const folder = process.argv[2], version = process.argv[3];
const req = createRequire(join(folder, 'package.json'));
const imp = (name) => import(pathToFileURL(req.resolve(name)).href);
const { Client } = await imp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await imp('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = await imp('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createHttpServer } = await import(pathToFileURL(join(folder, 'dist/src/http.js')));
assert.equal(typeof createMcpServer, 'function');
assert(Object.keys(preview).length > 0 && Object.keys(dsh).length > 0);
const phone = await createService(true);
try {
  const { session_id } = await phone.open('demo:foldable', 'package-check');
  assert((await phone.inspect(session_id)).observation.nodes.length > 0);
  await phone.act(session_id, {kind: 'key', key: 'home'}, 'tree');
} finally { await phone.shutdown(); }
const manifest = JSON.parse(await readFile(join(folder, 'mcp.json'), 'utf8')).mcpServers.phone_use;
const client = new Client({name: 'release-check', version: '1'});
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [...manifest.args.map((arg) => arg.replaceAll('$' + '{PLUGIN_ROOT}', folder)), '--demo'],
    cwd: folder, env: process.env, stderr: 'inherit',
  }));
  assert.equal(client.getServerVersion().version, version);
  const {tools} = await client.listTools();
  assert.equal(tools.length, 19);
  for (const tool of tools)
    for (const hint of ['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'])
      assert.equal(typeof tool.annotations?.[hint], 'boolean');
  assert.deepEqual(tools.find((t) => t.name === 'phone_console')._meta['openai/ui'],
    {entrypoints: [{type: 'thread'}]});
  const call = async (name, args = {}) => {
    const result = await client.callTool({name, arguments: args});
    assert.notEqual(result.isError, true, name + ': ' + JSON.stringify(result.structuredContent));
    return result;
  };
  const {session_id} = (await call('phone_open', {device_id: 'demo:foldable'})).structuredContent;
  try {
    const tree = await call('phone_inspect', {session_id});
    assert(!tree.content.some((c) => c.type === 'image'));
    const tapped = await call('phone_act', {session_id, action: {kind: 'tap_node', node_id: 'input',
      observation_id: tree.structuredContent.observation.id}});
    const typed = await call('phone_act', {session_id, action: {kind: 'text', text: 'Release 检查',
      observation_id: tapped.structuredContent.observation.id}});
    assert.match(JSON.stringify(typed.structuredContent), /Release 检查/);
    const capture = await call('phone_observe', {session_id, wait_for: 'none', ocr: 'off'});
    assert(capture.content.some((c) => c.type === 'image' && c.data.length > 0));
    const resource = (await client.readResource({uri: UI_URI})).contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.match(resource.text, /ui\/initialize/);
  } finally { await call('phone_close', {session_id}); }
} finally { await client.close(); }
const service = await createService(true);
const token = 'release-check-only-token-at-least-32-characters';
const http = createHttpServer(service, token);
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
const url = new URL('http://127.0.0.1:' + http.address().port + '/mcp');
const httpClient = new Client({name: 'release-http-check', version: '1'});
try {
  assert.equal((await fetch(url, {method: 'POST'})).status, 401);
  await httpClient.connect(new StreamableHTTPClientTransport(url,
    {requestInit: {headers: {Authorization: 'Bearer ' + token}}}));
  assert.equal((await httpClient.listTools()).tools.length, 19);
  const devices = await httpClient.callTool({name: 'phone_devices', arguments: {}});
  assert.equal(devices.structuredContent.devices[0].id, 'demo:foldable');
} finally {
  await httpClient.close();
  http.closeAllConnections();
  await new Promise((resolve, reject) => http.close((e) => e ? reject(e) : resolve()));
  await service.shutdown();
}
console.log(JSON.stringify({version, sdk: true, stdioTools: 19, authenticatedHttp: true,
  panelResource: true, actions: 'demo only'}));
`;

try {
  const portable = await unpack(`phone-use-${version}.tar.gz`, `phone-use-${version}`);
  console.log('Checking portable plugin with clean production dependencies');
  npmRun(portable.folder, ['ci', '--omit=dev']);
  const pluginCheck = join(portable.folder, 'release-check.mjs');
  await writeFile(pluginCheck, fixture);
  execFileSync(process.execPath, [pluginCheck, portable.folder, version], {
    cwd: portable.folder,
    stdio: 'inherit',
    timeout: 60000,
    env: { ...process.env, PHONE_USE_STATE_DIR: join(temporary, 'portable-state') },
  });

  const core = await unpack(`phone-use-${version}.tgz`, 'package');
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'release-consumer', private: true, type: 'module' }),
  );
  console.log('Checking MCP/SDK archive installed into a clean consumer project');
  npmRun(consumer, ['install', '--omit=dev', core.archive]);
  const consumerCheck = join(consumer, 'release-check.mjs');
  await writeFile(consumerCheck, fixture);
  execFileSync(
    process.execPath,
    [consumerCheck, join(consumer, 'node_modules/phone-use'), version],
    {
      cwd: consumer,
      stdio: 'inherit',
      timeout: 60000,
      env: { ...process.env, PHONE_USE_STATE_DIR: join(temporary, 'core-state') },
    },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
