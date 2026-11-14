import { createServer, type Server } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import type { PhoneService } from '../core/service.js';
import { PreviewEncoder } from '../core/preview.js';
import { errorData, PhoneError } from '../core/errors.js';
import { actionSchema } from '../core/schema.js';
import { VERSION } from '../version.js';
import { RtcPreviewServer, type PreviewSocket } from './rtc-stream.js';

export const previewReportSchema = z
  .object({
    version: z.string().max(32),
    state: z.enum(['connecting', 'direct', 'fallback']),
    reason: z.enum([
      'none',
      'csp',
      'connect-error',
      'handshake-timeout',
      'closed',
      'bootstrap',
      'invalid-ticket',
      'server-config',
    ]),
    secure: z.boolean(),
    webcodecs: z.boolean(),
    transport: z.enum(['webrtc', 'ws', 'wss', 'mcp', 'host']).optional(),
    rtc_failure: z
      .enum(['none', 'unavailable', 'negotiation', 'connect-error', 'timeout', 'closed'])
      .optional(),
  })
  .strict();

const messageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('pointer'),
      id: z.number().int().nonnegative(),
      session_id: z.string().uuid(),
      phase: z.enum(['down', 'move', 'up', 'cancel']),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      observation_id: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ type: z.literal('hello'), token: z.string().length(64) }).strict(),
  z
    .object({
      type: z.literal('view'),
      sessions: z.array(z.string().uuid()).max(8),
      quality: z.enum(['focus', 'grid']),
      video: z.boolean().optional(),
      frame_window: z.number().int().min(1).max(4).optional(),
      // Per-device decoder negotiation. Older clients retain the boolean default.
      video_sessions: z.array(z.string().uuid()).max(8).optional(),
      video_failures: z
        .array(
          z
            .object({
              session_id: z.string().uuid(),
              reason: z.enum(['unavailable', 'unsupported', 'decode-error', 'timeout']),
            })
            .strict(),
        )
        .max(8)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('ack'),
      session_id: z.string().uuid(),
      observation_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal('act'),
      id: z.number().int().nonnegative(),
      session_id: z.string().uuid(),
      action: actionSchema,
    })
    .strict(),
]);

/** Local, capability-authenticated media/control channel. MCP remains the bootstrap/fallback. */
export class PanelStream {
  private http?: Server;
  private readonly reports = new Map<string, z.infer<typeof previewReportSchema>>();
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  private readonly tickets = new Map<string, { panelId: string; expires: number }>();
  private readonly encoder = new PreviewEncoder();
  private readonly rtc = new RtcPreviewServer();
  private endpoint?: Promise<string>;
  private closed = false;
  private readonly hostSockets = new Set<PreviewSocket>();
  constructor(private readonly service: PhoneService) {
    service.onShutdown(() => this.close());
  }
  private async createListener() {
    const tls = this.service.panelTransport.tls;
    const rejectHttp = (_req: unknown, res: import('node:http').ServerResponse) =>
      res.writeHead(404).end();
    if (tls) {
      try {
        const [cert, key] = await Promise.all([readFile(tls.certificate), readFile(tls.key)]);
        const x509 = new X509Certificate(cert);
        if (
          !x509.checkIP('127.0.0.1') ||
          !x509.checkPrivateKey(createPrivateKey(key)) ||
          Date.parse(x509.validFrom) > Date.now() ||
          Date.parse(x509.validTo) <= Date.now()
        )
          throw new Error('Invalid loopback certificate');
        this.http = createSecureServer({ cert, key, minVersion: 'TLSv1.2' }, rejectHttp);
      } catch {
        throw new PhoneError(
          'CONFIG_ERROR',
          'Preview TLS requires a valid certificate for 127.0.0.1 and its matching private key. Check preview.tls.',
        );
      }
    } else this.http = createServer(rejectHttp);
    this.http.on('upgrade', (req, socket, head) => {
      const address = this.http!.address();
      if (
        this.closed ||
        !address ||
        typeof address === 'string' ||
        req.url !== '/phone-use' ||
        req.headers.host !== `127.0.0.1:${address.port}` ||
        this.sockets.clients.size + this.rtc.size >= 16
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      // Opaque sandbox origins are normal in MCP Apps. An unguessable, single-use
      // ticket delivered through app-only MCP metadata is required before any data.
      this.sockets.handleUpgrade(req, socket, head, (ws) => this.connection(ws));
    });
  }
  start() {
    return (this.endpoint ??= (async () => {
      if (this.closed) throw new Error('Stream is closed');
      await this.createListener();
      if (this.closed) throw new Error('Stream is closed');
      return new Promise<string>((resolve, reject) => {
        this.http!.once('error', reject);
        this.http!.listen(0, '127.0.0.1', () => {
          this.http!.unref();
          const address = this.http!.address();
          if (!address || typeof address === 'string') return reject(new Error('No loopback port'));
          resolve(
            `${this.service.panelTransport.tls ? 'wss' : 'ws'}://127.0.0.1:${address.port}/phone-use`,
          );
        });
      });
    })());
  }
  report(panelId: string, report?: z.infer<typeof previewReportSchema>) {
    this.service.panelScope(panelId);
    if (report) {
      this.reports.set(panelId, previewReportSchema.parse(report));
      while (this.reports.size > 128) this.reports.delete(this.reports.keys().next().value!);
    }
    return {
      server_version: VERSION,
      tls_configured: Boolean(this.service.panelTransport.tls),
      client: this.reports.get(panelId),
    };
  }
  private issueTicket(panelId: string) {
    this.service.panelScope(panelId);
    for (const [key, value] of this.tickets)
      if (value.expires < Date.now()) this.tickets.delete(key);
    while (this.tickets.size >= 128) this.tickets.delete(this.tickets.keys().next().value!);
    const token = randomBytes(32).toString('hex');
    this.tickets.set(token, { panelId, expires: Date.now() + 60_000 });
    return {
      token,
      protocol: 1,
      version: VERSION,
      features: ['per-device-video'],
      expires_in_seconds: 60,
    };
  }
  async ticket(panelId: string) {
    this.service.panelScope(panelId);
    return { ...this.issueTicket(panelId), url: await this.start() };
  }
  /** An authenticated host supplies the carrier; tickets still bind a single panel. */
  hostTicket(panelId: string) {
    return {
      ...this.issueTicket(panelId),
      transport: 'host' as const,
      features: ['per-device-video', 'frame-window', 'frame-feedback'],
    };
  }
  attachHost(socket: PreviewSocket) {
    if (this.closed || this.hostSockets.size >= 16)
      throw new PhoneError('DEVICE_BUSY', 'Preview connection limit reached.');
    this.hostSockets.add(socket);
    socket.once('close', () => this.hostSockets.delete(socket));
    this.connection(socket);
  }
  async rtcAnswer(panelId: string, offer: string) {
    this.service.panelScope(panelId);
    if (this.rtc.size + this.sockets.clients.size >= 16)
      throw new PhoneError('DEVICE_BUSY', 'Preview connection limit reached.');
    const answer = await this.rtc.answer(offer, (socket) => this.connection(socket));
    return {
      ...this.issueTicket(panelId),
      transport: 'webrtc',
      features: ['per-device-video', 'rtc-fragments-v1'],
      answer,
    };
  }
  private connection(ws: PreviewSocket) {
    const pointerOwner = randomBytes(16).toString('hex'),
      pointerDevices = new Set<string>();
    let pointerPending = 0;
    let panelId: string | undefined, scope: string | undefined;
    let visibleUntil = 0,
      quality: 'focus' | 'grid' = 'focus',
      lastActionId = -1;
    let nativeVideo = false;
    let frameWindow = 1;
    const videoSessions = new Set<string>();
    const videoCursors = new Map<string, number>();
    const videoReady = new Map<string, boolean>();
    const videoActivity = new Map<string, number>();
    const videoUpdated = new Map<string, number>();
    const selected = new Set<string>(),
      working = new Set<string>(),
      actions = new Set<string>();
    const sent = new Map<string, { id: string; at: number }[]>();
    const outstanding = (id: string) => sent.get(id)?.length ?? 0;
    const markSent = (id: string, observation: string) => {
      const pending = sent.get(id) ?? [];
      pending.push({ id: observation, at: Date.now() });
      sent.set(id, pending);
    };
    const last = new Map<string, string>(),
      next = new Map<string, number>();
    const send = (data: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 3000);
    authTimer.unref();
    // Legacy clients keep one in-flight batch. A host can negotiate a bounded
    // window so each frame does not wait for a desktop IPC round trip.
    const wakeups = new Map<string, ReturnType<typeof setTimeout>>();
    const schedule = (sessionId: string) => {
      if (!selected.has(sessionId) || ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(wakeups.get(sessionId));
      const timer = setTimeout(
        () => {
          wakeups.delete(sessionId);
          void pump(sessionId);
        },
        Math.max(0, (next.get(sessionId) ?? 0) - Date.now()),
      );
      timer.unref();
      wakeups.set(sessionId, timer);
    };
    const pump = async (sessionId: string) => {
      if (
        !panelId ||
        !scope ||
        Date.now() > visibleUntil ||
        ws.readyState !== WebSocket.OPEN ||
        !selected.has(sessionId) ||
        outstanding(sessionId) >= frameWindow ||
        working.has(sessionId)
      )
        return;
      if (ws.bufferedAmount > 512 * 1024) {
        next.set(sessionId, Date.now() + 16);
        schedule(sessionId);
        return;
      }
      working.add(sessionId);
      const started = Date.now();
      try {
        this.service.requireScope(sessionId, scope!);
        const state = this.service.state(sessionId);
        if (state.paused) return;
        // MCP/another panel may mutate a device while its video is static.
        // Renew the visible observation after completion even without new pixels.
        if (!state.busy && (state.activity?.id ?? 0) !== (videoActivity.get(sessionId) ?? 0))
          videoCursors.delete(sessionId);
        let native = videoSessions.has(sessionId)
          ? await this.service.videoPreview(sessionId, videoCursors.get(sessionId) ?? 0)
          : undefined;
        if (
          native &&
          !native.video.packets.length &&
          native.observation.input_ready &&
          (videoReady.get(sessionId) === false ||
            Date.now() - (videoUpdated.get(sessionId) ?? 0) >= 10_000)
        )
          // Healthy change-driven video may stay static longer than the input
          // observation lifetime. Renew the visible view with its current GOP;
          // agent observations retain their original expiry and capture time.
          native = await this.service.videoPreview(sessionId, 0);
        if (native) {
          const { video, observation } = native;
          if (
            !video.packets.length ||
            ws.readyState !== WebSocket.OPEN ||
            !selected.has(sessionId) ||
            Date.now() > visibleUntil ||
            this.service.state(sessionId).paused
          )
            return;
          const { packets, ...format } = video;
          const metadata = Buffer.from(
            JSON.stringify({
              session_id: sessionId,
              observation,
              session: this.service.state(sessionId),
              mimeType: 'video/h264',
              video: {
                ...format,
                packets: packets.map(({ bytes, ...packet }) => ({
                  ...packet,
                  length: bytes.length,
                })),
              },
            }),
          );
          const length = Buffer.alloc(4);
          length.writeUInt32BE(metadata.length);
          markSent(sessionId, observation.id);
          videoCursors.set(sessionId, packets.at(-1)!.sequence);
          videoReady.set(sessionId, observation.input_ready !== false);
          videoActivity.set(sessionId, this.service.state(sessionId).activity?.id ?? 0);
          videoUpdated.set(sessionId, Date.now());
          ws.send(Buffer.concat([length, metadata, ...packets.map((p) => p.bytes)]));
          return;
        }
        const frame = await this.service.preview(sessionId);
        if (!frame || last.get(sessionId) === frame.observation.id) return;
        const bytes = await this.encoder.binary(frame.frame, quality);
        if (
          ws.readyState !== WebSocket.OPEN ||
          !selected.has(sessionId) ||
          Date.now() > visibleUntil ||
          this.service.state(sessionId).paused
        )
          return;
        const metadata = Buffer.from(
          JSON.stringify({
            session_id: sessionId,
            observation: frame.observation,
            session: this.service.state(sessionId),
            mimeType: 'image/jpeg',
          }),
        );
        const length = Buffer.alloc(4);
        length.writeUInt32BE(metadata.length);
        markSent(sessionId, frame.observation.id);
        last.set(sessionId, frame.observation.id);
        ws.send(Buffer.concat([length, metadata, bytes]));
      } catch (error) {
        next.set(sessionId, Date.now() + 1500);
        send({ type: 'frame-error', session_id: sessionId, error: errorData(error) });
      } finally {
        working.delete(sessionId);
        next.set(
          sessionId,
          Math.max(
            next.get(sessionId) ?? 0,
            started + (videoSessions.has(sessionId) ? (quality === 'focus' ? 16 : 33) : 33),
          ),
        );
        if (outstanding(sessionId) < frameWindow) schedule(sessionId);
      }
    };
    const status = setInterval(() => {
      if (!panelId || Date.now() > visibleUntil) return;
      if ([...sent.values()].some((items) => items.some((item) => Date.now() - item.at > 5000))) {
        ws.close(1013, 'Frame consumer stalled');
        return;
      }
      void this.service
        .panelState(panelId)
        .then((panel) => send({ type: 'panel', panel }))
        .catch(() => ws.close(1008, 'Panel expired'));
    }, 1000);
    status.unref();
    ws.on('message', (raw, binary) => {
      void (async () => {
        if (binary) throw new Error('Expected JSON');
        const message = messageSchema.parse(JSON.parse(raw.toString()));
        if (!panelId) {
          if (message.type !== 'hello') throw new Error('Authenticate first');
          const ticket = this.tickets.get(message.token);
          this.tickets.delete(message.token);
          if (!ticket || ticket.expires < Date.now()) throw new Error('Invalid ticket');
          scope = this.service.panelScope(ticket.panelId);
          panelId = ticket.panelId;
          clearTimeout(authTimer);
          send({ type: 'ready', panel_id: panelId });
          return;
        }
        if (message.type === 'view') {
          const requested = new Set<string>();
          for (const id of message.sessions) {
            try {
              this.service.requireScope(id, scope!);
              requested.add(id);
            } catch (error) {
              send({ type: 'frame-error', session_id: id, error: errorData(error) });
            }
          }
          for (const id of selected)
            if (!requested.has(id)) {
              sent.delete(id);
              last.delete(id);
              videoCursors.delete(id);
              videoUpdated.delete(id);
            }
          selected.clear();
          for (const id of requested) selected.add(id);
          quality = message.quality;
          frameWindow = message.frame_window ?? 1;
          nativeVideo = Boolean(message.video);
          const requestedVideo = new Set(
            message.video_sessions ?? (nativeVideo ? [...requested] : []),
          );
          for (const id of new Set([...videoSessions, ...requestedVideo]))
            if (videoSessions.has(id) !== requestedVideo.has(id)) videoCursors.delete(id);
          videoSessions.clear();
          for (const id of requested) {
            if (requestedVideo.has(id)) videoSessions.add(id);
            this.service.reportPreview(id, {
              decoder: videoSessions.has(id) ? 'h264' : 'jpeg',
              fallback_reason: message.video_failures?.find((failure) => failure.session_id === id)
                ?.reason,
            });
          }
          visibleUntil = Date.now() + 5000;
          for (const id of selected) schedule(id);
        } else if (message.type === 'ack') {
          const pending = sent.get(message.session_id);
          const index = pending?.findIndex((item) => item.id === message.observation_id) ?? -1;
          if (pending && index >= 0) {
            pending.splice(index, 1);
            if (!pending.length) sent.delete(message.session_id);
            schedule(message.session_id);
          }
        } else if (message.type === 'pointer') {
          if (message.id <= lastActionId || pointerPending >= 16)
            throw new Error('Duplicate or excessive pointer input');
          lastActionId = message.id;
          this.service.requireScope(message.session_id, scope!);
          if (!selected.has(message.session_id) || Date.now() > visibleUntil)
            throw new Error('Pointer view is not visible');
          pointerPending++;
          pointerDevices.add(message.session_id);
          try {
            const result = await this.service.pointer(message.session_id, pointerOwner, message);
            send({ type: 'result', id: message.id, result: { structuredContent: result } });
            if (message.phase === 'up' || message.phase === 'cancel') {
              last.delete(message.session_id);
              videoCursors.delete(message.session_id);
              schedule(message.session_id);
            }
          } catch (error) {
            send({
              type: 'result',
              id: message.id,
              result: { isError: true, structuredContent: { error: errorData(error) } },
            });
          } finally {
            pointerPending--;
          }
        } else if (message.type === 'act') {
          // Duplicate/out-of-order requests are rejected, never replayed.
          if (message.id <= lastActionId) throw new Error('Duplicate action');
          lastActionId = message.id;
          try {
            this.service.requireScope(message.session_id, scope!);
            if (actions.has(message.session_id) || actions.size >= 4)
              throw new PhoneError('DEVICE_BUSY', 'An action is already running.');
            actions.add(message.session_id);
            try {
              const result = await this.service.act(message.session_id, message.action, false);
              send({
                type: 'result',
                id: message.id,
                result: {
                  structuredContent: { ...result, session: this.service.state(message.session_id) },
                },
              });
              last.delete(message.session_id);
              videoCursors.delete(message.session_id);
              schedule(message.session_id);
            } finally {
              actions.delete(message.session_id);
            }
          } catch (error) {
            send({
              type: 'result',
              id: message.id,
              result: { isError: true, structuredContent: { error: errorData(error) } },
            });
          }
        }
      })().catch(() => ws.close(1008, 'Invalid request'));
    });
    ws.on('error', () => {});
    ws.once('close', () => {
      for (const id of pointerDevices) void this.service.cancelPointer(id, pointerOwner);
      clearTimeout(authTimer);
      for (const timer of wakeups.values()) clearTimeout(timer);
      wakeups.clear();
      clearInterval(status);
      selected.clear();
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.tickets.clear();
    for (const socket of this.hostSockets) socket.close(1001, 'Service shutdown');
    this.hostSockets.clear();
    for (const ws of this.sockets.clients) ws.terminate();
    await this.rtc.close();
    this.sockets.close();
    this.reports.clear();
    if (this.http) await new Promise<void>((resolve) => this.http!.close(() => resolve()));
  }
}
const streams = new WeakMap<PhoneService, PanelStream>();
export function panelStream(service: PhoneService) {
  let stream = streams.get(service);
  if (!stream) streams.set(service, (stream = new PanelStream(service)));
  return stream;
}
