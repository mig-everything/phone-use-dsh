#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createService } from './config.js';
import { createMcpServer } from './mcp.js';
import { createHttpServer } from './http.js';
import { errorData } from './core/errors.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      demo: { type: 'boolean', default: false },
      config: { type: 'string' },
      port: { type: 'string', default: '8765' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'stdio';
  if (values.help) {
    console.log(
      'phone-use [stdio|serve|doctor] [--demo] [--config path] [--port 8765]\nserve requires PHONE_USE_TOKEN (32+ chars); binds to 127.0.0.1 only.',
    );
    return;
  }
  if (!['stdio', 'serve', 'doctor'].includes(command)) throw new Error('Unknown command');
  const service = await createService(values.demo, values.config);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await service.shutdown();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  if (command === 'doctor') {
    try {
      const discovered = await service.devices();
      const setup = {
        harmonyos:
          'Install DevEco/HDC, enable debugging and authorize this host. Set PHONE_USE_HDC or harmony.binary if HDC is not on PATH.',
        android:
          'Install Android platform-tools, enable USB debugging and authorize this host. Set PHONE_USE_ADB or android.binary if ADB is not on PATH.',
        ios: 'Start a signed WDA runner and configure ios[].url. Building WDA or running iOS Simulator requires macOS/Xcode.',
      };
      console.log(
        JSON.stringify(
          {
            host: { platform: process.platform, arch: process.arch, node: process.versions.node },
            perception: service.perceptionCapabilities(),
            ...discovered,
            diagnostics: discovered.diagnostics.map((item) => ({
              ...item,
              next_step: setup[item.platform as keyof typeof setup],
            })),
            setup,
          },
          null,
          2,
        ),
      );
    } finally {
      await service.shutdown();
    }
    return;
  }
  if (command === 'stdio') {
    const server = createMcpServer(service);
    await server.connect(new StdioServerTransport());
    process.stdin.once('end', () => void stop());
    return;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  const http = createHttpServer(service, process.env.PHONE_USE_TOKEN ?? '');
  http.on('error', async () => {
    console.error('Could not bind HTTP listener.');
    await service.shutdown();
    process.exitCode = 1;
  });
  http.listen(port, '127.0.0.1', () =>
    console.error(`Phone Use MCP: http://127.0.0.1:${port}/mcp`),
  );
}
main().catch((e) => {
  console.error(JSON.stringify(errorData(e)));
  process.exitCode = 1;
});
