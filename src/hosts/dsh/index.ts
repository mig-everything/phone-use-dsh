import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createService } from '../../config.js';
import { createPhoneTools } from '../../tools.js';
import { PhoneError, errorData } from '../../core/errors.js';
import type { PhoneService } from '../../core/service.js';
import type { ToolContext } from '../../core/tool-catalog.js';
import { panelStream } from '../../transport/panel-stream.js';
import { widgetHtml } from '../../widget.js';
import { FetchPreviewSocket } from './fetch-socket.js';

export const name = 'phone-use-dsh';
export const inject = ['tools', 'skills', 'sessions'];
export interface Config {
  configPath?: string;
  demo?: boolean;
}
const sessionId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w-]+$/);
const bodySchema = z
  .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
  .strict();
const inputSchema = z
  .object({
    channel: z.string().uuid(),
    sequence: z.number().int().positive(),
    message: z.string().max(65536),
  })
  .strict();

/** The DSH boundary owns identity, attachment admission and authenticated UI routes. */
export async function apply(ctx: any, config: Config = {}) {
  const service = await createService(config.demo ?? false, config.configPath);
  mountDsh(ctx, service);
}

export function mountDsh(ctx: any, service: PhoneService) {
  const catalog = createPhoneTools(service),
    stream = panelStream(service);
  const lifetime = new AbortController();
  const channels = new Map<string, { scope: string; socket: FetchPreviewSocket }>();
  const scopeOf = (id: unknown) => `dsh:${sessionId.parse(id)}`;
  const contextOf = (id: unknown, signal: AbortSignal): ToolContext => {
    const scope = scopeOf(id);
    if (!ctx.sessions.get(id))
      throw new PhoneError('SESSION_CLOSED', 'Open the DSH conversation before using its devices.');
    return { scope, signal, hasUi: true };
  };
  const requirePanel = (args: Record<string, unknown>, context: ToolContext) => {
    if (typeof args.panel_id === 'string' && service.panelScope(args.panel_id) !== context.scope)
      throw new PhoneError('SESSION_CLOSED', 'The panel belongs to another conversation.');
  };
  for (const tool of catalog.tools.values()) {
    if (tool._meta?.ui?.visibility?.includes('app') && !tool._meta.ui.visibility.includes('model'))
      continue;
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(
        JSON.stringify(z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' })),
      ),
      output: { schema: {}, render: (_args: unknown, value: any) => value.content },
      async execute(args: unknown, exec: any) {
        const context = contextOf(exec.agent?.session?.header?.id, exec.signal);
        if (
          ['phone_act', 'phone_batch'].includes(tool.name) &&
          ctx.get('sandboxPolicy')?.resolve({ session: exec.agent.session }).mode === 'read-only'
        )
          throw new PhoneError(
            'READ_ONLY',
            'This DSH session is read-only. Device input is disabled.',
          );
        const result = await tool.execute(args, context);
        if (result.isError) {
          const error = (result.structuredContent as any)?.error;
          throw new PhoneError(
            error?.code ?? 'PHONE_ERROR',
            error?.message ?? 'Phone operation failed.',
            error?.uncertain === true,
          );
        }
        const content: any[] = [];
        for (const block of result.content) {
          if (block.type === 'text') content.push({ type: 'text', text: block.text });
          if (block.type !== 'image') continue;
          const route = exec.agent?.session?.requestHeader?.()?.config;
          const provider = route?.provider ?? exec.agent?.options?.provider;
          const model = route?.model ?? exec.agent?.options?.model;
          const attachments = ctx.get('attachments');
          // Attachment discovery is presentation, not a reason to hide an applied action.
          const info =
            provider && model
              ? await ctx
                  .get('llm')
                  ?.resolveModelInfo(provider, model, exec.signal)
                  .catch(() => undefined)
              : undefined;
          if (!attachments || !info?.inputModalities?.includes('image')) {
            content.push({
              type: 'text',
              text: 'Screenshot captured, but the selected DSH model does not declare image input. Use native controls/OCR or select a vision model; sidebar video remains available.',
            });
            continue;
          }
          try {
            const [attachment] = await attachments.saveImages([
              { data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType },
            ]);
            content.push({ type: 'image', attachment });
          } catch {
            content.push({
              type: 'text',
              text: 'Screenshot attachment unavailable. The action result above remains authoritative; do not replay the action.',
            });
          }
        }
        // Only one canonical presentation reaches the model. UI tickets and frames stay out.
        return { content };
      },
    });
  }
  ctx.skills.registerProvider(() => ({
    name,
    list: async () => [
      {
        name: 'phone-use',
        description: 'Operate HarmonyOS, Android and iOS devices; show the Phone Use sidebar.',
        provider: name,
        source: 'bundled',
        rank: 600,
        locator: 'phone-use',
        invocation: { modelInvocable: true, userInvocable: true },
      },
    ],
    get: async (candidate: any) =>
      candidate.name !== 'phone-use'
        ? undefined
        : {
            name: 'phone-use',
            description: 'Cross-platform phone operation',
            provider: name,
            source: 'bundled',
            invocation: { modelInvocable: true, userInvocable: true },
            content: await readFile(
              new URL('../../../../skills/phone-use/SKILL.md', import.meta.url),
              'utf8',
            ),
          },
  }));
  ctx.effect(
    () => () => {
      lifetime.abort();
      for (const c of channels.values()) c.socket.close();
      void service.shutdown();
    },
    'Phone Use service cleanup',
  );
  ctx.on('session/disposed', (session: any) => {
    const scope = scopeOf(session.header.id);
    for (const c of channels.values()) if (c.scope === scope) c.socket.close();
    for (const device of service.listSessions(scope)) void service.close(device.session_id);
  });
  ctx.inject(['connection'], (native: any) => {
    const route = (
      path: string,
      methods: string[],
      handler: (request: Request, context: ToolContext) => Promise<Response>,
    ) => {
      native.connection.fetch.register({
        path: `/api/phone-use/${path}`,
        methods,
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          try {
            const id = new URL(request.url).searchParams.get('session');
            return await handler(
              request,
              contextOf(id, AbortSignal.any([request.signal, lifetime.signal])),
            );
          } catch (error) {
            return Response.json(
              { error: errorData(error) },
              { status: 400, headers: { 'cache-control': 'no-store' } },
            );
          }
        },
      });
    };
    route(
      'widget',
      ['GET'],
      async () =>
        new Response(await widgetHtml(), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        }),
    );
    route('tools', ['POST'], async (request, context) => {
      const text = await request.text();
      if (text.length > 65536) throw new PhoneError('INVALID_REQUEST', 'Request exceeds 64 KiB.');
      const { name: toolName, arguments: args } = bodySchema.parse(JSON.parse(text));
      const tool = catalog.tools.get(toolName);
      if (!tool || (!tool._meta?.ui?.visibility?.includes('app') && toolName !== 'phone_focus'))
        throw new PhoneError('UNKNOWN_TOOL', 'This operation is not available to the sidebar.');
      requirePanel(args, context);
      const result =
        toolName === 'phone_connect'
          ? {
              content: [],
              _meta: { stream: stream.hostTicket(z.string().uuid().parse(args.panel_id)) },
            }
          : await tool.execute(args, context);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    });
    route('stream', ['POST'], async (_request, context) => {
      if (channels.size >= 16)
        throw new PhoneError('DEVICE_BUSY', 'Preview connection limit reached.');
      const id = randomUUID(),
        socket = new FetchPreviewSocket(context.signal);
      channels.set(id, { scope: context.scope, socket });
      socket.once('close', () => channels.delete(id));
      // Some host Fetch carriers publish headers with the first response chunk.
      // Flush a non-sensitive preamble so hello authentication cannot deadlock.
      socket.send(JSON.stringify({ type: 'carrier-ready' }));
      stream.attachHost(socket);
      return new Response(socket.body, {
        headers: {
          'content-type': 'application/x-phone-use-stream',
          'cache-control': 'no-store, no-transform',
          'x-phone-use-channel': id,
        },
      });
    });
    route('input', ['POST'], async (request, context) => {
      const text = await request.text();
      if (text.length > 70000) throw new PhoneError('INVALID_REQUEST', 'Input exceeds 64 KiB.');
      const input = inputSchema.parse(JSON.parse(text));
      const channel = channels.get(input.channel);
      if (!channel || channel.scope !== context.scope)
        throw new PhoneError('SESSION_CLOSED', 'Preview channel is closed.');
      channel.socket.receive(input.sequence, input.message);
      return Response.json({ accepted: true });
    });
    route('feedback', ['POST'], async (request, context) => {
      const text = await request.text();
      if (text.length > 8192) throw new PhoneError('INVALID_REQUEST', 'Feedback exceeds 8 KiB.');
      const input = z
        .object({
          channel: z.string().uuid(),
          sequence: z.number().int().positive(),
          acks: z
            .array(
              z
                .object({
                  session_id: z.string().uuid(),
                  observation_id: z.string().uuid(),
                })
                .strict(),
            )
            .min(1)
            .max(32),
        })
        .strict()
        .parse(JSON.parse(text));
      const channel = channels.get(input.channel);
      if (!channel || channel.scope !== context.scope)
        throw new PhoneError('SESSION_CLOSED', 'Preview channel is closed.');
      channel.socket.receiveFeedback(input.sequence, input.acks);
      return Response.json({ accepted: true });
    });
    route('disconnect', ['POST'], async (request, context) => {
      const text = await request.text();
      if (text.length > 100) throw new PhoneError('INVALID_REQUEST', 'Invalid connection.');
      const { channel } = z.object({ channel: z.string().uuid() }).strict().parse(JSON.parse(text));
      const entry = channels.get(channel);
      if (entry?.scope === context.scope) entry.socket.close();
      return Response.json({ closed: true });
    });
  });
  return { service, catalog };
}
