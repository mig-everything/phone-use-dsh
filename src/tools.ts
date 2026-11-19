import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PhoneService, CaptureResult } from './core/service.js';
import { actionSchema, followUpSchema } from './core/schema.js';
import { errorData, PhoneError } from './core/errors.js';
import { settleParallel } from './core/parallel.js';
import { PreviewEncoder } from './core/preview.js';
import { panelStream, previewReportSchema } from './transport/panel-stream.js';
import { VERSION } from './version.js';
import { UI_URI } from './widget.js';
import { compactModelData, compactModelText } from './core/presentation.js';
import { targetSelectorSchema } from './core/targets.js';
import { resolveTapPlan } from './core/planning.js';
import { waitRequestSchema } from './core/wait.js';
import { PhoneToolCatalog, type ToolContext } from './core/tool-catalog.js';
export function jsonResult(
  data: Record<string, unknown>,
  maxNodes = 60,
  compact = true,
): CallToolResult {
  const presented = compact ? compactModelData(data, maxNodes) : data;
  return {
    content: [{ type: 'text', text: compact ? compactModelText(presented) : JSON.stringify(data) }],
    structuredContent: presented,
  };
}
export function captureResult(
  result: CaptureResult,
  appOnly = false,
  extra: Record<string, unknown> = {},
  maxNodes = 60,
): CallToolResult {
  const { frame, ...data } = result;
  const presented = jsonResult({ ...data, ...extra }, maxNodes, !appOnly);
  if (appOnly)
    return {
      ...presented,
      _meta: { frame: { data: frame.bytes.toString('base64'), mimeType: frame.mimeType } },
    };
  return {
    ...presented,
    content: [
      ...presented.content,
      { type: 'image', data: frame.bytes.toString('base64'), mimeType: frame.mimeType },
    ],
  };
}
const sid = { session_id: z.string().uuid() };
const requestScope = (extra: ToolContext) => extra.scope;
type BatchItem = {
  session_id: string;
  device_id: string;
  result: Record<string, unknown>;
  capture?: CaptureResult;
  maxNodes?: number;
};
function presentBatch(
  outcomes: PromiseSettledResult<BatchItem>[],
  targets: { session_id: string; device_id: string }[],
  startedAt: string,
  maxNodes = 60,
) {
  const images: CallToolResult['content'] = [];
  const results = outcomes.map((outcome, index) => {
    if (outcome.status === 'rejected')
      return { ...targets[index], status: 'error', error: errorData(outcome.reason) };
    const { capture, result, maxNodes: itemLimit, ...target } = outcome.value;
    if (!capture)
      return compactModelData({ ...target, status: 'ok', ...result }, itemLimit ?? maxNodes);
    const presented = captureResult(capture);
    images.push(
      {
        type: 'text',
        text: `Screenshot for ${target.device_id}; session ${target.session_id}; observation ${capture.observation.id}.`,
      },
      ...presented.content.filter((item) => item.type === 'image'),
    );
    const { frame: _frame, ...captureData } = capture;
    return compactModelData(
      { ...target, status: 'ok', ...result, ...captureData },
      itemLimit ?? maxNodes,
    );
  });
  const output = jsonResult(
    {
      all_succeeded: results.every((r) => r.status === 'ok' && !('observation_error' in r)),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      max_concurrency: 4,
      results,
    },
    maxNodes,
  );
  output.content.push(...images);
  return output;
}
export function createPhoneTools(service: PhoneService) {
  const encoder = new PreviewEncoder();
  const stream = panelStream(service);
  const server = new PhoneToolCatalog();
  const guarded = (handler: () => Promise<CallToolResult>) =>
    handler().catch((e) => ({ isError: true, ...jsonResult({ error: errorData(e) }) }));
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const control = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };
  const targets = (ids: string[], scope: string) => {
    if (new Set(ids).size !== ids.length)
      throw new PhoneError('DUPLICATE_DEVICE', 'Use at most one operation per device in a batch.');
    return ids.map((session_id) => {
      service.requireScope(session_id, scope);
      return { session_id, device_id: service.state(session_id).device.id };
    });
  };
  server.registerTool(
    'phone_devices',
    {
      description:
        'List connected HarmonyOS/Android devices and configured iOS WDA endpoints, with diagnostics. Only sessions in the current host scope are listed; devices may be in use elsewhere.',
      inputSchema: {},
      annotations: read,
    },
    (_, extra) =>
      guarded(async () =>
        jsonResult({
          ...(await service.devices()),
          perception: service.perceptionCapabilities(),
          sessions: service.listSessions(requestScope(extra)),
        }),
      ),
  );
  server.registerTool(
    'phone_open',
    {
      description:
        'Open an exact discovered device ID, reusing its existing session in this host scope. Returns session ID, pause state and runtime capabilities. Hosts providing openai/session metadata get conversation scoping; otherwise the local MCP process shares one scope.',
      inputSchema: { device_id: z.string().min(1) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ device_id }, extra) =>
      guarded(async () => jsonResult(await service.open(device_id, requestScope(extra)))),
  );
  server.registerTool(
    'phone_inspect',
    {
      description:
        'Read a compact control index without screenshots. Use query to search the full exported tree before limiting results. Returned IDs authorize tap_node or focused text; coordinate actions need phone_observe. Check truncated and warnings for missing content.',
      inputSchema: {
        ...sid,
        max_nodes: z.number().int().min(1).max(500).default(60),
        query: z.string().trim().min(1).max(120).optional(),
      },
      annotations: read,
    },
    ({ session_id, max_nodes, query }, extra) =>
      guarded(async () => {
        service.requireScope(session_id, requestScope(extra));
        return jsonResult(
          (await service.inspect(session_id, max_nodes, query)) as unknown as Record<
            string,
            unknown
          >,
          max_nodes,
        );
      }),
  );
  server.registerTool(
    'phone_observe',
    {
      description:
        'Capture a settled screenshot and compact controls. OCR auto adds text boxes only for incomplete trees; on forces it, off skips it. OCR IDs are not tap_node targets. Coordinates use screenshot pixels. Check stability/warnings; tree and image are sequential samples. Observations expire in 30s.',
      inputSchema: {
        ...sid,
        with_tree: z.boolean().default(true),
        max_nodes: z.number().int().min(1).max(500).default(60),
        wait_for: z.enum(['stable', 'none']).default('stable'),
        wait_timeout_ms: z.number().int().min(200).max(5000).default(2000),
        ocr: z.enum(['auto', 'on', 'off']).default('auto'),
      },
      annotations: read,
    },
    ({ session_id, with_tree, max_nodes, wait_for, wait_timeout_ms, ocr }, extra) =>
      guarded(async () => {
        service.requireScope(session_id, requestScope(extra));
        return captureResult(
          await service.observe(
            session_id,
            with_tree,
            max_nodes,
            wait_for === 'stable' ? wait_timeout_ms : 0,
            ocr,
          ),
          false,
          {},
          max_nodes,
        );
      }),
  );
  server.registerTool(
    'phone_act',
    {
      description:
        'Execute ONE phone action. Prefer tap_node from a current observation; tap_target reads and validates one exact unique selector. scroll_node scrolls a verified native region without a screenshot; direction is content exploration (down moves the finger up). Text needs a verified focused control; coordinate tap/swipe need a screenshot observation. Default follow-up is a tree: reuse it. observe:{mode:"tree",query,max_nodes} narrows it; true requests a screenshot, false skips follow-up. Launch needs app_id and ability/activity on HarmonyOS/Android. Never automatically retry uncertain actions.',
      inputSchema: {
        ...sid,
        action: actionSchema,
        observe: followUpSchema.default('tree'),
      },
      annotations: control,
    },
    ({ session_id, action, observe }, extra) =>
      guarded(async () => {
        service.requireScope(session_id, requestScope(extra));
        const result = await service.act(session_id, action, observe);
        if ('inspection' in result && result.inspection)
          return jsonResult(
            { ...result.inspection, applied: true },
            typeof observe === 'object' ? observe.max_nodes : 60,
          );
        if ('capture' in result && result.capture) {
          return captureResult(
            result.capture,
            false,
            { applied: true },
            typeof observe === 'object' ? observe.max_nodes : 60,
          );
        }
        return jsonResult(result);
      }),
  );
  server.registerTool(
    'phone_wait',
    {
      description:
        'Wait for a unique target to be present/actionable, its absence in the exported tree, or a visually stable normalized region. Bounded to 30s; returns only the final observation. No actions or retries. Background animation need not stop for a target condition. Stability is not business completion.',
      inputSchema: { ...sid, ...waitRequestSchema.shape },
      annotations: read,
    },
    ({ session_id, ...options }, extra) =>
      guarded(async () => {
        service.requireScope(session_id, requestScope(extra));
        const result = await service.waitFor(session_id, options, extra.signal);
        return result.capture
          ? captureResult(result.capture, false, { wait: result.wait }, options.max_nodes)
          : jsonResult({ ...result.inspection, wait: result.wait }, options.max_nodes);
      }),
  );
  server.registerTool(
    'phone_observe_many',
    {
      description:
        'Inspect 1–8 selected sessions, up to four in parallel. screenshot:false returns only UI controls. Otherwise returns labeled screenshots with the same bounded settling policy as phone_observe. Captures are not time-synchronized; inspect each timestamp, stability and result. Does not open devices.',
      inputSchema: {
        session_ids: z.array(sid.session_id).min(1).max(8),
        with_tree: z.boolean().default(true),
        screenshot: z.boolean().default(true),
        wait_for: z.enum(['stable', 'none']).default('stable'),
        wait_timeout_ms: z.number().int().min(200).max(5000).default(2000),
        max_nodes: z.number().int().min(1).max(500).default(60),
        ocr: z.enum(['auto', 'on', 'off']).default('auto'),
      },
      annotations: read,
    },
    ({ session_ids, with_tree, max_nodes, screenshot, wait_for, wait_timeout_ms, ocr }, extra) =>
      guarded(async () => {
        const selected = targets(session_ids, requestScope(extra)),
          startedAt = new Date().toISOString();
        const outcomes = await settleParallel(selected, async (target) => ({
          ...target,
          result: screenshot ? {} : { ...(await service.inspect(target.session_id, max_nodes)) },
          ...(screenshot
            ? {
                capture: await service.observe(
                  target.session_id,
                  with_tree,
                  max_nodes,
                  wait_for === 'stable' ? wait_timeout_ms : 0,
                  ocr,
                ),
              }
            : {}),
        }));
        return presentBatch(outcomes, selected, startedAt, max_nodes);
      }),
  );
  server.registerTool(
    'phone_resolve_many',
    {
      description:
        'Prepare one shared tap for 1–8 devices, without acting. Exact names/aliases, role, context and resource ID locate each device separately; per-target selectors override the common one. Returns phone_batch operations only when all targets are unique and enabled. Missing/ambiguous targets need refinement; batch execution can partially fail.',
      inputSchema: {
        targets: z
          .array(z.object({ ...sid, selector: targetSelectorSchema.optional() }).strict())
          .min(1)
          .max(8),
        selector: targetSelectorSchema,
      },
      annotations: read,
    },
    ({ targets, selector }, extra) =>
      guarded(async () => {
        const plan = await resolveTapPlan(service, targets, selector, requestScope(extra));
        return jsonResult({
          ready: plan.ready,
          operations: plan.operations,
          results: plan.results.map((result) =>
            'error' in result
              ? result
              : {
                  session_id: result.session_id,
                  device_id: result.device_id,
                  status: result.resolution.status,
                  candidate_count: result.resolution.candidate_count,
                  ...(result.resolution.status === 'matched'
                    ? {
                        target: result.resolution.candidates.find(
                          (c) => c.node_id === result.resolution.selected_node_id,
                        ),
                      }
                    : { candidates: result.resolution.candidates.slice(0, 8) }),
                },
          ),
        });
      }),
  );
  server.registerTool(
    'phone_batch',
    {
      description:
        'Execute one independently specified action per selected device, up to four devices in parallel. Each action must use that device’s own observation and coordinates. No coordinate broadcasting, timing guarantee, rollback or retries. Inspect every result; some devices may succeed while others fail. A successful action with observation_error must not be replayed.',
      inputSchema: {
        operations: z
          .array(
            z
              .object({
                ...sid,
                action: actionSchema,
                observe: followUpSchema.default('tree'),
              })
              .strict(),
          )
          .min(1)
          .max(8),
      },
      annotations: control,
    },
    ({ operations }, extra) =>
      guarded(async () => {
        const selected = targets(
            operations.map((op) => op.session_id),
            requestScope(extra),
          ),
          startedAt = new Date().toISOString();
        const outcomes = await settleParallel(operations, async (op) => {
          const executed = await service.act(op.session_id, op.action, op.observe);
          const { capture, inspection, ...result } = {
            capture: undefined as CaptureResult | undefined,
            inspection: undefined as Awaited<ReturnType<PhoneService['inspect']>> | undefined,
            ...executed,
          };
          return {
            ...selected.find((s) => s.session_id === op.session_id)!,
            result: { ...result, ...inspection },
            maxNodes: typeof op.observe === 'object' ? op.observe.max_nodes : 60,
            ...(capture ? { capture } : {}),
          };
        });
        return presentBatch(outcomes, selected, startedAt);
      }),
  );
  server.registerTool(
    'phone_focus',
    {
      description:
        'Switch the selected device in the existing conversation panel without opening a new preview or taking a screenshot.',
      inputSchema: sid,
      annotations: read,
    },
    ({ session_id }, extra) =>
      guarded(async () =>
        jsonResult({ selection: service.select(requestScope(extra), session_id) }),
      ),
  );
  server.registerTool(
    'phone_screen',
    {
      description:
        'Read the current panel state or select a session in the existing panel. This tool never creates a UI tab. Hosts without UI support receive a screenshot when session_id is supplied. Open the Phone Use conversation entrypoint for the interactive console.',
      inputSchema: { session_id: sid.session_id.optional() },
      annotations: read,
    },
    ({ session_id }, extra) =>
      guarded(async () => {
        const scope = requestScope(extra);
        if (session_id) service.requireScope(session_id, scope);
        if (session_id) service.select(scope, session_id);
        const panel = await service.panelState(service.panel(scope), true);
        const hasUi = extra.hasUi ?? false;
        const result =
          session_id && !hasUi && !service.state(session_id).paused
            ? captureResult(await service.observe(session_id, false), hasUi)
            : jsonResult({});
        const data = {
          ...result.structuredContent,
          panel,
          ...(session_id ? { selected_session_id: session_id } : {}),
        };
        return {
          ...result,
          structuredContent: data,
          content: [
            { type: 'text', text: JSON.stringify(data) },
            ...result.content.filter((item) => item.type !== 'text'),
          ],
        };
      }),
  );
  server.registerTool(
    'phone_console',
    {
      title: '手机控制台',
      description:
        'Open the phone dashboard when the user asks to see it or cannot find the panel entrypoint. Call once to open; use phone_focus to switch devices in the existing panel. Do not call again for routine operations or refreshes.',
      inputSchema: {},
      annotations: read,
      _meta: {
        ui: { resourceUri: UI_URI, visibility: ['model', 'app'] },
        'openai/outputTemplate': UI_URI,
        'openai/widgetAccessible': true,
        'openai/ui': { entrypoints: [{ type: 'thread' }] },
      },
    },
    (_, extra) =>
      guarded(async () =>
        jsonResult({ panel: await service.panelState(service.panel(requestScope(extra)), true) }),
      ),
  );
  server.registerTool(
    'phone_frame',
    {
      description: 'Refresh one frame for the phone screen component.',
      inputSchema: {
        ...sid,
        panel_id: z.string().uuid().optional(),
        after_id: z.string().optional(),
      },
      annotations: read,
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ session_id, panel_id, after_id }, extra) =>
      guarded(async () => {
        service.requireScope(
          session_id,
          panel_id ? service.panelScope(panel_id) : requestScope(extra),
        );
        const captured = await service.preview(session_id);
        const state = service.state(session_id);
        if (state.paused) return jsonResult({ session: state });
        const result = captured
          ? {
              ...jsonResult({ session_id, observation: captured.observation }),
              ...(captured.observation.id !== after_id
                ? { _meta: { frame: await encoder.encode(captured.frame) } }
                : {}),
            }
          : jsonResult({});
        return { ...result, structuredContent: { ...result.structuredContent, session: state } };
      }),
  );
  server.registerTool(
    'phone_appearance',
    {
      description:
        'App-only native model artwork from locally installed SDKs or configured skin assets.',
      inputSchema: { panel_id: z.string().uuid(), ...sid },
      annotations: read,
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ panel_id, session_id }) =>
      guarded(async () => {
        service.requireScope(session_id, service.panelScope(panel_id));
        return {
          ...jsonResult({ session_id }),
          _meta: { appearance: await service.appearance(session_id) },
        };
      }),
  );
  server.registerTool(
    'phone_connect',
    {
      description:
        'App-only short-lived, single-use bootstrap for the local live preview channel. Credentials are UI-only metadata.',
      inputSchema: {
        panel_id: z.string().uuid(),
        rtc_offer: z.string().min(1).max(16384).optional(),
      },
      annotations: read,
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ panel_id, rtc_offer }) =>
      guarded(async () => ({
        ...jsonResult({ connected: true }),
        _meta: {
          stream: rtc_offer
            ? await stream.rtcAnswer(panel_id, rtc_offer)
            : await stream.ticket(panel_id),
        },
      })),
  );
  server.registerTool(
    'phone_panel',
    {
      description:
        'App-only session status and optional device discovery for an existing phone panel. Does not capture screens or open devices.',
      inputSchema: {
        panel_id: z.string().uuid().optional(),
        discover: z.boolean().default(false),
        preview_client: previewReportSchema.optional(),
      },
      annotations: read,
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ panel_id, discover, preview_client }, extra) =>
      guarded(async () => {
        const id = panel_id ?? service.panel(requestScope(extra));
        return {
          ...jsonResult({ panel: await service.panelState(id, discover) }),
          _meta: { preview: stream.report(id, preview_client) },
        };
      }),
  );
  server.registerTool(
    'phone_panel_action',
    {
      description:
        'App-only explicit user action on one device in this panel. Never broadcasts actions to multiple devices.',
      inputSchema: {
        panel_id: z.string().uuid(),
        command: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('open'), device_id: z.string().min(1) }).strict(),
          z.object({ kind: z.literal('act'), ...sid, action: actionSchema }).strict(),
          z.object({ kind: z.literal('pause'), ...sid, paused: z.boolean() }).strict(),
          z.object({ kind: z.literal('close'), ...sid }).strict(),
          z
            .object({
              kind: z.literal('screenshot'),
              ...sid,
              wait_for: z.enum(['stable', 'none']).default('stable'),
            })
            .strict(),
        ]),
      },
      annotations: control,
      _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    },
    ({ panel_id, command }) =>
      guarded(async () => {
        const scope = service.panelScope(panel_id);
        if (command.kind === 'open')
          return jsonResult(await service.open(command.device_id, scope));
        service.requireScope(command.session_id, scope);
        if (command.kind === 'screenshot')
          return captureResult(
            await service.observe(
              command.session_id,
              false,
              0,
              command.wait_for === 'stable' ? 2000 : 0,
            ),
            true,
          );
        if (command.kind === 'close') return jsonResult(await service.close(command.session_id));
        const result =
          command.kind === 'pause'
            ? await service.pause(command.session_id, command.paused)
            : await service.act(command.session_id, command.action, false);
        return jsonResult({ ...result, session: service.state(command.session_id) });
      }),
  );
  server.registerTool(
    'phone_pause',
    {
      description:
        'Pause/resume ALL capture and control for a session during manual takeover. Resume requires a new observation.',
      inputSchema: { ...sid, paused: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ session_id, paused }, extra) =>
      guarded(async () => {
        service.requireScope(session_id, requestScope(extra));
        return jsonResult(await service.pause(session_id, paused));
      }),
  );
  server.registerTool(
    'phone_close',
    {
      description: 'Release the device session and its exclusive lock.',
      inputSchema: sid,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    ({ session_id }, extra) =>
      guarded(async () => {
        service.requireScope(session_id, requestScope(extra));
        return jsonResult(await service.close(session_id));
      }),
  );
  return server;
}
