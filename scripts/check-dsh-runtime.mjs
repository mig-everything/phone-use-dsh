/** Load the shipped bundle in a trusted, installed official DSH runtime. No model requests. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { archive: { type: 'string' }, dependencies: { type: 'string' } },
});
if (positionals.length !== 1)
  throw new Error(
    'Pass the installed @deepseek-ai/dsh directory, optionally --archive <tgz> and --dependencies <node_modules>.',
  );
const runtime = resolve(positionals[0]),
  req = createRequire(join(runtime, 'package.json'));
const imp = async (name) => import(pathToFileURL(req.resolve(name)).href);
const source = JSON.parse(await readFile(join(root, 'packages/dsh/package.json'), 'utf8'));
const archive = values.archive
  ? resolve(values.archive)
  : join(root, 'releases', `mig-everything-phone-use-dsh-${source.version}.tgz`);
const runtimeVersion = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version;
const home = await mkdtemp(join(tmpdir(), 'phone-use-dsh-check-'));
const profile = join(home, 'profiles', 'compat'),
  candidate = join(home, 'candidate');
let running, deadline;
try {
  await mkdir(candidate);
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', candidate]);
  const bundle = join(candidate, 'package');
  const metadata = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'));
  if (values.dependencies) {
    await symlink(resolve(values.dependencies), join(bundle, 'node_modules'), 'dir');
  } else {
    // Validate the archive with only freshly resolved production dependencies.
    // Never borrow the checkout's dev dependencies in the default acceptance path.
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: bundle, stdio: 'pipe', timeout: 180000, shell: process.platform === 'win32' },
    );
  }
  await mkdir(dirname(join(profile, 'node_modules', metadata.name)), { recursive: true });
  await symlink(bundle, join(profile, 'node_modules', metadata.name), 'dir');
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'phone-use-check',
      private: true,
      dependencies: { [metadata.name]: 'link:' + bundle },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', metadata.name] } },
    }),
  );
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    `- id: phone-use-dsh
  config:
    demo: true
- id: session-title-llm
  disabled: true
- id: session-telemetry-otel
  disabled: true
- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
    - id: subagent-model-selection-settings
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
`,
  );
  process.env.PHONE_USE_STATE_DIR = join(home, 'devices');
  process.env.DSH_HOME = home;
  const { runProfile } = await imp('@deepseek-ai/dsh/profile-boot');
  const { createLaunchEnvironmentSnapshot } = await imp('@deepseek-ai/dsh-launch-environment');
  deadline = setTimeout(() => {
    console.error('DSH check exceeded 60 seconds');
    process.exit(1);
  }, 60000);
  running = await runProfile({
    environment: createLaunchEnvironmentSnapshot([
      { source: 'process', values: { DSH_HOME: home, PATH: process.env.PATH } },
    ]),
    profile: 'compat',
    patchFiles: [req.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml')],
    args: [],
  });
  const { ctx } = running;
  const skills = await ctx.skills.list();
  assert(skills.some((s) => s.name === 'phone-use'));
  assert((await ctx.skills.get('phone-use'))?.content.includes('phone_inspect'));
  const visible = ctx.tools
    .schemas()
    .filter((t) => t.name.startsWith('phone_'))
    .map((t) => t.name);
  assert(visible.includes('phone_act') && visible.includes('phone_console'));
  assert(
    !visible.includes('phone_frame') && !visible.includes('phone_connect'),
    'UI frames must stay out of model context',
  );
  const agents = [];
  const make = async (id) => {
    const h = await ctx.agents.create({
      sessionId: id,
      meta: { cwd: home, agentPreset: 'standard' },
      setup: (agentCtx) => ctx.agentPresets.mount(agentCtx, 'standard').then(() => {}),
    });
    agents.push(h);
    return h.agent;
  };
  const a = await make('phone-compat-a'),
    b = await make('phone-compat-b');
  let count = 0;
  const call = async (agent, name, args) => {
    const input = { agent, signal: AbortSignal.timeout(10000) };
    const execution =
      typeof ctx.tools.selectExecutor === 'function'
        ? await ctx.tools.execute({
            ...input,
            calls: [{ id: 'check-' + ++count, name, arguments: JSON.stringify(args) }],
          })
        : await ctx.tools.execute({ ...input, callId: 'check-' + ++count, name, arguments: args });
    const result = Array.isArray(execution.results) ? execution.results[0].result : execution;
    return result;
  };
  const ok = async (...args) => {
    const r = await call(...args);
    assert.equal(r.isError, false, JSON.stringify(r));
    return r;
  };
  try {
    const opened = await ok(a, 'phone_open', { device_id: 'demo:foldable' });
    // The native result uses a single renderer; inspect its text without assuming internal fields.
    const findText = (value) =>
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value.map(findText).join('\n')
          : value && typeof value === 'object'
            ? value.type === 'text'
              ? value.text
              : Object.values(value).map(findText).join('\n')
            : '';
    const text = findText(opened);
    const id = text.match(/session_id["\s:]+([a-f0-9-]{36})/)?.[1];
    assert(id, 'native output must render the session id: ' + text.slice(0, 500));
    await ok(a, 'phone_inspect', { session_id: id });
    const forbidden = await call(b, 'phone_inspect', { session_id: id });
    assert.equal(forbidden.isError, true, 'device leases must be conversation scoped');
    const first = await ok(a, 'phone_console', {}),
      second = await ok(a, 'phone_console', {});
    const panelId = (r) => findText(r).match(/panel_id["\s:]+([a-f0-9-]{36})/)?.[1];
    assert(panelId(first));
    assert.equal(panelId(first), panelId(second));
    await ok(a, 'phone_close', { session_id: id });
    if (typeof ctx.connection?.createSharedFetchHandler === 'function') {
      const carrier = ctx.connection.createSharedFetchHandler('/api');
      const fetch = (path, body) =>
        carrier.fetch(
          new Request('http://fixture/api/phone-use/' + path + '?session=phone-compat-a', {
            method: body === undefined ? 'GET' : 'POST',
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          { principal: { kind: 'owner' } },
        );
      assert.equal((await fetch('widget')).status, 200, 'native DSH route is mounted');
      const ticketResponse = await fetch('tools', {
        name: 'phone_connect',
        arguments: { panel_id: panelId(first) },
      });
      assert.equal(ticketResponse.status, 200);
      const ticket = (await ticketResponse.json())._meta.stream;
      const openedStream = await fetch('stream', {}),
        reader = openedStream.body.getReader();
      const decode = async () => {
        const r = await reader.read();
        assert(!r.done);
        return JSON.parse(Buffer.from(r.value).subarray(5).toString());
      };
      assert.equal((await decode()).type, 'carrier-ready');
      const channel = openedStream.headers.get('x-phone-use-channel');
      assert.equal(
        (
          await fetch('input', {
            channel,
            sequence: 1,
            message: JSON.stringify({ type: 'hello', token: ticket.token }),
          })
        ).status,
        200,
      );
      assert.equal((await decode()).type, 'ready');
      await reader.cancel();
      const manager = ctx.get('pluginManager');
      if (manager) {
        const entry = (await manager.listPlugins()).find((row) => row.patchId === 'phone-use-dsh');
        assert(entry, 'Phone Use loader entry exists');
        await manager.setPluginEnabled(entry.entryId, false);
        assert.equal((await fetch('widget')).status, 404, 'disabled host route is removed');
        await manager.setPluginEnabled(entry.entryId, true);
        const deadline = Date.now() + 5000;
        while ((await fetch('widget')).status !== 200) {
          if (Date.now() > deadline)
            throw new Error('Phone Use route did not return after plugin re-enable');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await ok(a, 'phone_console', {});
      }
    }

    console.log(
      JSON.stringify({
        runtime: runtimeVersion,
        bundle: metadata.version,
        dependencies: values.dependencies
          ? 'explicit dependency directory'
          : 'isolated production install',
        archive,
        tools: visible.length,
        checks: [
          'native plugin activation',
          'skill loading',
          'tool dispatch',
          'conversation isolation',
          'one panel per conversation',
          'session release',
          'native Fetch handshake',
          'plugin disable/re-enable',
        ],
        externalModelRequests: 0,
      }),
    );
  } finally {
    for (const h of agents) await h.dispose();
  }
} finally {
  clearTimeout(deadline);
  await running?.shutdown.shutdown(0);
  await rm(home, { recursive: true, force: true });
}
