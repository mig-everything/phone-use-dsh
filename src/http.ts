import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PhoneService } from './core/service.js';
import { createMcpServer } from './mcp.js';
import { PhoneError } from './core/errors.js';

export function authorized(req: IncomingMessage, token: string) {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
/** Single-user loopback endpoint. Remote Work needs a separately authenticated HTTPS gateway. */
export function createHttpServer(service: PhoneService, token: string) {
  if (token.length < 32)
    throw new PhoneError('CONFIG_ERROR', 'PHONE_USE_TOKEN must contain at least 32 characters.');
  return createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) {
      res.writeHead(403).end('Invalid Host');
      return;
    }
    // Browsers use the host MCP bridge; arbitrary cross-origin access is unnecessary.
    if (req.headers.origin) {
      res.writeHead(403).end('Browser origins are not accepted');
      return;
    }
    if (!authorized(req, token)) {
      res
        .writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' })
        .end('Unauthorized');
      return;
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const mcp = createMcpServer(service);
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
    }
  });
}
