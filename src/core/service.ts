import { randomUUID } from 'node:crypto';
import { PhoneError, errorData, requireCapability } from './errors.js';
import { DeviceLease } from './lease.js';
import {
  insideInputInset,
  sameDisplay,
  sameInputDisplay,
  toDriverPoint,
  toPixelBounds,
  visibleInputPoint,
} from './geometry.js';
import { actionSchema, followUpSchema, type Action, type FollowUp } from './schema.js';
import { settleFrame, type Stability } from './settle.js';
import { DeviceSkins } from './appearance.js';
import { analyzePage, describeNodes, isEditableNode, type PageAnalysis } from './perception.js';
import { OcrEngine, type OcrMode, type OcrProvider, type OcrResult } from './ocr.js';
import {
  ExactTargetResolver,
  matchesTarget,
  type TargetResolver,
  type TargetSelector,
} from './targets.js';
import { waitRequestSchema, waitUntil, type WaitRequest } from './wait.js';
import type {
  Device,
  DeviceAdapter,
  DeviceInfo,
  Frame,
  UINode,
  DriverAction,
  PreviewTransport,
  PanelTransportOptions,
} from './types.js';

export interface Observation {
  id: string;
  capturedAt: string;
  display: Frame['display'];
  nodes: UINode[];
  truncated: boolean;
  warnings: string[];
  page?: PageAnalysis;
  ocr?: OcrResult;
  stability?: Stability;
  input_ready?: boolean;
  preview_transport?: 'snapshots' | PreviewTransport;
}
export interface TreeObservation extends Omit<Observation, 'display'> {
  kind: 'tree';
  coordinate_space: 'driver';
}
export interface InspectionResult {
  session_id: string;
  device: DeviceInfo;
  observation: TreeObservation;
}
interface StoredObservation {
  observation: Observation | TreeObservation;
  nativeNodes: UINode[];
  evidenceNodes: Map<string, UINode>;
  created: number;
  source: 'agent' | 'preview';
}
export interface Activity {
  id: number;
  kind: Action['kind'];
  at: string;
  status: 'running' | 'applied' | 'failed' | 'uncertain';
  point?: { x: number; y: number };
  to?: { x: number; y: number };
}
interface Session {
  id: string;
  device: DeviceInfo;
  adapter: DeviceAdapter;
  lease: DeviceLease;
  observations: Map<string, StoredObservation>;
  queue: Promise<unknown>;
  touched: number;
  closing: boolean;
  paused: boolean;
  scope: string;
  pending: number;
  controls: number;
  revision: number;
  activity?: Activity;
  display?: Frame['display'];
  cached?: CaptureResult;
  previewFlight?: Promise<CaptureResult>;
  previewStartedAt?: number;
  untrackedPreview?: CaptureResult;
  encodedGeometry?: { display: Frame['display']; at: number; epoch: number };
  previewClient?: { decoder: 'h264' | 'jpeg'; fallback_reason?: string; reported_at: string };
  pointer?: {
    owner: string;
    display: Frame['display'];
    x: number;
    y: number;
    checkedAt: number;
    timer?: ReturnType<typeof setTimeout>;
  };
}
export interface CaptureResult {
  session_id: string;
  device: DeviceInfo;
  observation: Observation;
  frame: Frame;
}
export class PhoneService {
  private readonly ocr: OcrEngine;
  private readonly resolver: TargetResolver;
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<
    string,
    { scope: string; promise: Promise<ReturnType<PhoneService['opened']>> }
  >();
  private readonly panels = new Map<string, string>();
  private readonly selections = new Map<string, { session_id: string; revision: number }>();
  private readonly disposers = new Set<() => Promise<void>>();
  private readonly expiry: ReturnType<typeof setInterval>;
  constructor(
    private readonly adapters: DeviceAdapter[],
    private readonly lockDirectory: string,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs = 30_000,
    private readonly skins = new DeviceSkins(),
    readonly panelTransport: PanelTransportOptions = {},
    extensions: { ocr?: OcrProvider; ocrTimeoutMs?: number; resolver?: TargetResolver } = {},
  ) {
    this.ocr = new OcrEngine(extensions.ocr, extensions.ocrTimeoutMs);
    this.resolver = extensions.resolver ?? new ExactTargetResolver();
    this.expiry = setInterval(() => {
      for (const s of this.sessions.values())
        if (!s.closing && this.now() - s.touched > 15 * 60_000)
          void this.close(s.id).catch(() => {});
    }, 30_000);
    this.expiry.unref();
  }
  perceptionCapabilities() {
    return {
      semantic_tree: true,
      target_resolver: this.resolver.id,
      ocr: this.ocr.capabilities(),
    };
  }
  async devices() {
    const devices: Device[] = [],
      diagnostics: { platform: string; error: ReturnType<typeof errorData> }[] = [];
    const results = await Promise.allSettled(this.adapters.map((a) => a.discover()));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') devices.push(...r.value);
      else diagnostics.push({ platform: this.adapters[i]!.platform, error: errorData(r.reason) });
    });
    return { devices, diagnostics };
  }
  private opened(session: Session, reused: boolean) {
    return {
      session_id: session.id,
      device: session.device,
      paused: session.paused,
      reused,
      idle_timeout_seconds: 900,
    };
  }
  async open(deviceId: string, scope = 'local') {
    const existing = [...this.sessions.values()].find(
      (s) => s.device.id === deviceId && !s.closing,
    );
    if (existing?.scope === scope) {
      existing.touched = this.now();
      return this.opened(existing, true);
    }
    const pending = this.opening.get(deviceId);
    if (pending) {
      if (pending.scope !== scope)
        throw new PhoneError('DEVICE_BUSY', 'Device belongs to another conversation.');
      return pending.promise;
    }
    const promise = this.openNew(deviceId, scope);
    this.opening.set(deviceId, { scope, promise });
    try {
      return await promise;
    } finally {
      this.opening.delete(deviceId);
    }
  }
  private async openNew(deviceId: string, scope: string) {
    const { devices } = await this.devices();
    const device = devices.find((d) => d.id === deviceId);
    if (!device)
      throw new PhoneError(
        'DEVICE_NOT_FOUND',
        'Device not discovered. Call phone_devices and use an exact ID.',
      );
    const adapter = this.adapters.find((a) => a.platform === device.platform)!;
    const lease = await DeviceLease.acquire(this.lockDirectory, deviceId);
    try {
      const info = await adapter.inspect(device);
      requireCapability(info.capabilities.screenshot, 'screenshots');
      const session: Session = {
        id: randomUUID(),
        device: info,
        adapter,
        lease,
        observations: new Map(),
        queue: Promise.resolve(),
        touched: this.now(),
        closing: false,
        paused: false,
        scope,
        pending: 0,
        controls: 0,
        revision: 0,
      };
      this.sessions.set(session.id, session);
      return this.opened(session, false);
    } catch (e) {
      await adapter.close?.(device).catch(() => {});
      await lease.release();
      throw e;
    }
  }
  private get(id: string) {
    const s = this.sessions.get(id);
    if (!s || s.closing) throw new PhoneError('SESSION_CLOSED', 'Open a device session first.');
    return s;
  }
  requireScope(id: string, scope: string) {
    if (this.get(id).scope !== scope)
      throw new PhoneError('SESSION_CLOSED', 'This session belongs to another conversation.');
  }
  state(id: string) {
    const s = this.get(id);
    const streaming = s.adapter.pointerReady?.(s.device) ?? false;
    const inset = streaming ? (s.adapter.pointerInset?.(s.device) ?? 0) : 0;
    return {
      session_id: id,
      device: s.device,
      paused: s.paused,
      busy: s.controls > 0 || !!s.pointer,
      manual_input: streaming ? ('stream' as const) : ('gesture' as const),
      ...(inset > 0 ? { manual_input_inset: inset } : {}),
      revision: s.revision,
      ...(s.display ? { display: s.display } : {}),
      ...(s.activity ? { activity: s.activity } : {}),
      ...(s.previewClient ? { preview_client: s.previewClient } : {}),
    };
  }
  reportPreview(id: string, client: Omit<NonNullable<Session['previewClient']>, 'reported_at'>) {
    this.get(id).previewClient = { ...client, reported_at: new Date(this.now()).toISOString() };
  }
  appearance(id: string) {
    const s = this.get(id);
    return s.display
      ? this.skins.appearance(s.device, s.display)
      : Promise.resolve({ kind: 'generic', reason: '等待屏幕尺寸' });
  }
  listSessions(scope = 'local') {
    return [...this.sessions.values()]
      .filter((s) => !s.closing && s.scope === scope)
      .map((s) => this.state(s.id));
  }
  panel(scope = 'local') {
    for (const [id, owner] of this.panels) if (owner === scope) return id;
    const id = randomUUID();
    this.panels.set(id, scope);
    if (this.panels.size > 128) this.panels.delete(this.panels.keys().next().value!);
    return id;
  }
  panelScope(id: string) {
    const scope = this.panels.get(id);
    if (scope === undefined)
      throw new PhoneError('PANEL_CLOSED', 'Reopen phone_screen to reconnect this panel.');
    return scope;
  }
  select(scope: string, sessionId: string) {
    this.requireScope(sessionId, scope);
    const previous = this.selections.get(scope);
    const selection = { session_id: sessionId, revision: (previous?.revision ?? 0) + 1 };
    this.selections.set(scope, selection);
    return selection;
  }
  async panelState(id: string, discover = false) {
    const scope = this.panelScope(id);
    return {
      panel_id: id,
      sessions: this.listSessions(scope),
      selection: this.selections.get(scope),
      ...(discover ? await this.devices() : {}),
    };
  }
  private serialized<T>(s: Session, operation: () => Promise<T>, control = true): Promise<T> {
    s.pending++;
    if (control) s.controls++;
    s.revision++;
    s.touched = this.now();
    const task = s.queue.then(async () => {
      s.touched = this.now();
      try {
        return await operation();
      } finally {
        s.touched = this.now();
        s.pending--;
        if (control) s.controls--;
        s.revision++;
      }
    });
    s.queue = task.catch(() => {});
    return task;
  }
  private async capture(
    s: Session,
    withTree: boolean,
    maxNodes: number,
    source: 'agent' | 'preview' = 'agent',
    settleMs = 0,
    ocrMode: OcrMode = 'off',
    query?: string,
  ): Promise<CaptureResult> {
    if (s.paused)
      throw new PhoneError(
        'SESSION_PAUSED',
        'Screen capture and controls are paused. Resume after manual takeover.',
      );
    const sample = async () => {
      if (s.paused || s.closing)
        throw new PhoneError(
          s.paused ? 'SESSION_PAUSED' : 'SESSION_CLOSED',
          'Capture stopped after pause or close.',
        );
      if (source === 'preview') {
        try {
          const frame = await s.adapter.preview?.(s.device);
          if (frame) return frame;
        } catch {
          // A failed optional video source must not take down screenshot preview or controls.
        }
      }
      return s.adapter.capture(s.device);
    };
    const { frame, stability } =
      settleMs > 0
        ? await settleFrame(sample, settleMs)
        : {
            frame: await sample(),
            stability: { status: 'immediate' as const, elapsed_ms: 0, samples: 1 },
          };
    const capturedAt = frame.capturedAt ?? new Date(this.now()).toISOString();
    if (source === 'preview' && s.cached?.frame === frame && !s.paused && !s.closing) {
      const stored = s.observations.get(s.cached.observation.id);
      // Changed-frame streams can remain on one image indefinitely. Renew the
      // visible view's input authorization, without recapturing or extending an
      // agent observation. The adapter must still return a healthy live frame.
      if (
        stored?.source === 'preview' &&
        this.now() - stored.created < Math.min(10_000, this.maxAgeMs / 2)
      )
        return s.cached;
    }
    let nodes: UINode[] = [];
    const warnings: string[] = [];
    if (stability?.status === 'timeout')
      warnings.push(
        'Screen did not settle before the deadline. This is the latest frame, not a verified stable state.',
      );
    if (withTree && s.device.capabilities.tree) {
      try {
        nodes = await s.adapter.tree(s.device);
      } catch (e) {
        warnings.push(`Tree unavailable: ${errorData(e).code}. Use the screenshot.`);
      }
    }
    if (s.paused || s.closing)
      throw new PhoneError(
        s.paused ? 'SESSION_PAUSED' : 'SESSION_CLOSED',
        'Capture discarded after pause or close.',
      );
    const clipped = nodes.filter(
      (n) =>
        n.bounds.x < frame.display.inputWidth &&
        n.bounds.y < frame.display.inputHeight &&
        n.bounds.x + n.bounds.width > 0 &&
        n.bounds.y + n.bounds.height > 0,
    );
    const analysis =
      withTree && source === 'agent' ? analyzePage(clipped, maxNodes, query) : undefined;
    const selected = analysis?.nodes ?? clipped.slice(0, maxNodes);
    const needsOcr =
      !analysis ||
      !analysis.page.meaningful_nodes ||
      analysis.page.opaque_region_ids.length > 0 ||
      analysis.page.unnamed_actionable_nodes > 0;
    const ocr =
      source === 'agent' && (ocrMode === 'on' || (ocrMode === 'auto' && needsOcr))
        ? await this.ocr.recognize(frame)
        : undefined;
    if (s.paused || s.closing)
      throw new PhoneError(
        s.paused ? 'SESSION_PAUSED' : 'SESSION_CLOSED',
        'Observation discarded after pause or close.',
      );
    if (ocr && ocr.status !== 'ok')
      warnings.push(
        `OCR ${ocr.status}; use the screenshot. Controls and preview do not require OCR.`,
      );
    const observation: Observation = {
      id: randomUUID(),
      capturedAt,
      display: frame.display,
      nodes: selected.map((n) => ({ ...n, bounds: toPixelBounds(n.bounds, frame.display) })),
      truncated: analysis?.truncated ?? clipped.length > maxNodes,
      warnings,
      ...(analysis
        ? {
            page: {
              ...analysis.page,
              scroll_regions: analysis.page.scroll_regions.map((region) => ({
                ...region,
                bounds: toPixelBounds(region.bounds, frame.display),
              })),
            },
          }
        : {}),
      ...(ocr ? { ocr } : {}),
      ...(source === 'preview' ? { preview_transport: frame.transport ?? 'snapshots' } : {}),
      ...(stability ? { stability } : {}),
    };
    this.remember(s, observation, selected, source, clipped);
    s.display = frame.display;
    s.cached = { session_id: s.id, device: s.device, observation, frame };
    return s.cached;
  }
  private remember(
    s: Session,
    observation: Observation | TreeObservation,
    nativeNodes: UINode[],
    source: StoredObservation['source'],
    allNodes: UINode[] = nativeNodes,
  ) {
    const byId = new Map(allNodes.map((node) => [node.id, node]));
    const evidenceNodes = new Map<string, UINode>();
    for (const node of nativeNodes) {
      for (const id of [
        ...(node.semantic?.name_node_ids ?? []),
        ...(node.semantic?.context?.name_node_ids ?? []),
      ]) {
        const evidence = byId.get(id);
        if (evidence) evidenceNodes.set(id, evidence);
      }
    }
    s.observations.set(observation.id, {
      observation,
      nativeNodes,
      evidenceNodes,
      created: this.now(),
      source,
    });
    const entries = [...s.observations].filter(([, item]) => item.source === source);
    for (const [id] of entries.slice(
      0,
      Math.max(0, entries.length - (source === 'agent' ? 16 : 128)),
    ))
      s.observations.delete(id);
  }
  private async inspectTree(
    s: Session,
    maxNodes: number,
    query?: string,
  ): Promise<InspectionResult> {
    if (s.paused) throw new PhoneError('SESSION_PAUSED', 'UI inspection is paused.');
    requireCapability(s.device.capabilities.tree, 'UI tree inspection');
    const nodes = await s.adapter.tree(s.device);
    if (s.paused || s.closing)
      throw new PhoneError(
        s.paused ? 'SESSION_PAUSED' : 'SESSION_CLOSED',
        'Inspection discarded after pause or close.',
      );
    const analysis = analyzePage(nodes, maxNodes, query);
    const selected = analysis.nodes;
    const observation: TreeObservation = {
      id: randomUUID(),
      kind: 'tree',
      coordinate_space: 'driver',
      capturedAt: new Date(this.now()).toISOString(),
      nodes: selected,
      truncated: analysis.truncated,
      page: analysis.page,
      warnings: analysis.page.reasons,
    };
    this.remember(s, observation, selected, 'agent', nodes);
    return { session_id: s.id, device: s.device, observation };
  }
  inspect(id: string, maxNodes = 200, query?: string) {
    const s = this.get(id);
    return this.serialized(s, () => this.inspectTree(s, maxNodes, query));
  }
  resolve(id: string, selector: TargetSelector) {
    const s = this.get(id);
    return this.serialized(s, () => this.resolveTree(s, selector));
  }
  private async resolveTree(s: Session, selector: TargetSelector) {
    if (s.paused) throw new PhoneError('SESSION_PAUSED', 'Target resolution is paused.');
    requireCapability(s.device.capabilities.tree, 'UI tree inspection');
    requireCapability(s.device.capabilities.tap, 'tap');
    const raw = await s.adapter.tree(s.device),
      nodes = describeNodes(raw);
    const resolution = await this.resolver.resolve(nodes, selector, s.device);
    if (s.paused || s.closing)
      throw new PhoneError('SESSION_CLOSED', 'Resolution discarded after pause or close.');
    const target =
      resolution.status === 'matched'
        ? nodes.find((n) => n.id === resolution.selected_node_id)
        : undefined;
    if (
      resolution.status === 'matched' &&
      (!target?.semantic?.actions.includes('tap_node') ||
        raw.filter((n) => n.id === target.id).length !== 1)
    )
      throw new PhoneError(
        'INVALID_TARGET',
        'Resolver must select one existing enabled native control.',
      );
    const included = nodes.filter(
      (n) => n.id === target?.id || resolution.candidates.some((c) => c.node_id === n.id),
    );
    const observation: TreeObservation = {
      id: randomUUID(),
      kind: 'tree',
      coordinate_space: 'driver',
      capturedAt: new Date(this.now()).toISOString(),
      nodes: included,
      truncated: resolution.candidate_count > included.length,
      warnings: [],
    };
    this.remember(s, observation, included, 'agent', raw);
    return {
      resolution,
      observation,
      ...(target
        ? {
            action: {
              kind: 'tap_node' as const,
              node_id: target.id,
              observation_id: observation.id,
            },
          }
        : {}),
    };
  }
  observe(id: string, withTree = true, maxNodes = 200, settleMs = 0, ocr: OcrMode = 'off') {
    const s = this.get(id);
    return this.serialized(s, () => this.capture(s, withTree, maxNodes, 'agent', settleMs, ocr));
  }
  async waitFor(id: string, input: WaitRequest, signal?: AbortSignal) {
    const options = waitRequestSchema.parse(input),
      s = this.get(id);
    const condition = options.condition;
    if (condition.kind === 'stable') {
      let capture!: CaptureResult;
      const result = await settleFrame(
        async () => {
          signal?.throwIfAborted();
          capture = await this.observe(id, false, 0);
          return capture.frame;
        },
        options.timeout_ms,
        options.interval_ms,
        {
          region: condition.region,
          quietMs: options.quiet_ms,
          maxSamples: 300,
          signal,
        },
      );
      capture.observation.stability = result.stability;
      if (result.stability.status === 'timeout')
        capture.observation.warnings.push('Requested region did not settle before the deadline.');
      return { wait: { ...result.stability, condition }, capture };
    }
    const result = await waitUntil(
      async () =>
        this.serialized(s, async () => {
          if (s.paused || s.closing)
            throw new PhoneError('SESSION_PAUSED', 'Waiting stopped after pause or close.');
          requireCapability(s.device.capabilities.tree, 'UI tree inspection');
          const raw = await s.adapter.tree(s.device);
          if (s.paused || s.closing)
            throw new PhoneError('SESSION_PAUSED', 'Waiting stopped after pause or close.');
          const nodes = describeNodes(raw),
            matches = nodes.filter(
              (n) =>
                matchesTarget(n, condition.selector) &&
                (condition.state !== 'actionable' || n.semantic!.actions.includes('tap_node')),
            );
          const ready =
            condition.state === 'absent'
              ? matches.length === 0
              : matches.length === 1 &&
                (condition.state === 'present' ||
                  matches[0]!.semantic!.actions.includes('tap_node'));
          const analysis = analyzePage(
            raw,
            options.max_nodes,
            matches[0]?.semantic?.name ||
              condition.selector.names?.[0] ||
              condition.selector.resource_id,
          );
          const observation: TreeObservation = {
            id: randomUUID(),
            kind: 'tree',
            coordinate_space: 'driver',
            capturedAt: new Date(this.now()).toISOString(),
            nodes: analysis.nodes,
            truncated: analysis.truncated,
            page: analysis.page,
            warnings: analysis.page.reasons,
          };
          if (condition.state === 'absent')
            observation.warnings.push('Absence is limited to the exported accessibility tree.');
          this.remember(s, observation, analysis.nodes, 'agent', raw);
          return {
            inspection: { session_id: id, device: s.device, observation },
            key: ready
              ? JSON.stringify([s.activity?.id, matches.map((n) => [n.id, n.bounds, n.enabled])])
              : undefined,
          };
        }),
      (sample) => sample.key,
      {
        timeoutMs: options.timeout_ms,
        intervalMs: options.interval_ms,
        quietMs: options.quiet_ms,
        signal,
      },
    );
    return {
      wait: {
        status: result.status,
        elapsed_ms: result.elapsed_ms,
        samples: result.samples,
        condition,
      },
      inspection: result.latest.inspection,
    };
  }
  async preview(id: string) {
    const s = this.get(id);
    if (s.paused) throw new PhoneError('SESSION_PAUSED', 'Preview is paused.');
    if (s.previewFlight) return s.previewFlight;
    // Do not queue preview work behind controls. Another device can continue refreshing.
    if (s.pending > 0) {
      // Keep native video moving while a driver is executing. These frames do
      // not enter the observation store and cannot authorize another action.
      const frame = await s.adapter.liveFrame?.(s.device).catch(() => undefined);
      if (!frame || s.paused || s.closing) return;
      if (s.untrackedPreview?.frame === frame) return s.untrackedPreview;
      return (s.untrackedPreview = {
        session_id: id,
        device: s.device,
        frame,
        observation: {
          id: randomUUID(),
          capturedAt: frame.capturedAt ?? new Date(this.now()).toISOString(),
          display: frame.display,
          nodes: [],
          truncated: false,
          warnings: [],
          preview_transport: frame.transport ?? 'snapshots',
          input_ready: false,
        },
      } satisfies CaptureResult);
    }
    s.untrackedPreview = undefined;
    // Native sources already cache their newest packet. A 35 ms service cache
    // sampled at 33 ms silently halves a 30 fps stream to about 15 fps.
    const cacheMs = s.cached?.frame.transport ? 0 : 120;
    if (
      s.cached &&
      this.now() - (s.previewStartedAt ?? Date.parse(s.cached.observation.capturedAt)) < cacheMs
    )
      return s.cached;
    s.previewStartedAt = this.now();
    const task = this.serialized(s, () => this.capture(s, false, 0, 'preview'), false);
    s.previewFlight = task;
    try {
      return await task;
    } finally {
      s.previewFlight = undefined;
    }
  }
  async videoPreview(id: string, after: number) {
    const s = this.get(id);
    if (s.paused) throw new PhoneError('SESSION_PAUSED', 'Preview is paused.');
    const video = s.adapter.encodedVideo?.(s.device, after);
    if (!video) return;
    if (
      (!s.encodedGeometry ||
        s.encodedGeometry.epoch !== video.epoch ||
        this.now() - s.encodedGeometry.at > 5000) &&
      !s.pending
    ) {
      const display = await this.serialized(
        s,
        async () => s.adapter.inputDisplay?.(s.device),
        false,
      );
      if (display) s.encodedGeometry = { display, at: this.now(), epoch: video.epoch };
    }
    if (s.paused || s.closing) return;
    const geometry = s.encodedGeometry?.display;
    if (
      !geometry ||
      Math.abs(video.width / video.height - geometry.inputWidth / geometry.inputHeight) > 0.015
    ) {
      s.encodedGeometry = undefined;
      return;
    }
    const display = { ...geometry, width: video.width, height: video.height };
    const observation: Observation = {
      id: randomUUID(),
      capturedAt: video.capturedAt,
      display,
      nodes: [],
      truncated: false,
      warnings: [],
      preview_transport: video.source ?? s.device.capabilities.stream,
      input_ready: s.pending === 0,
    };
    if (video.packets.length && observation.input_ready)
      this.remember(s, observation, [], 'preview');
    s.display = display;
    return { video, observation };
  }
  private async prepare(s: Session, action: Action): Promise<DriverAction> {
    const c = s.device.capabilities;
    if (action.kind === 'tap_target') {
      const resolved = await this.resolveTree(s, action.selector);
      if (!resolved.action)
        throw new PhoneError(
          `TARGET_${resolved.resolution.status.toUpperCase()}`,
          'No unique enabled target. Refine the selector or inspect before acting.',
        );
      // Keep native identity, geometry and evidence validation; never replay an uncertain action.
      return this.prepare(s, resolved.action);
    }
    if (action.kind === 'launch') {
      requireCapability(c.launch, 'app launching');
      return {
        kind: 'launch',
        appId: action.app_id,
        ...(action.ability ? { ability: action.ability } : {}),
      };
    }
    if (action.kind === 'key') {
      requireCapability(c.keys.includes(action.key), `key ${action.key}`);
      return action;
    }
    if (action.kind === 'fold') {
      requireCapability(c.foldControl, 'fold simulation');
      return action;
    }
    const old = s.observations.get(action.observation_id);
    if (!old || this.now() - old.created > this.maxAgeMs)
      throw new PhoneError(
        'STALE_OBSERVATION',
        'Inspect or observe again: the observation is missing or older than 30 seconds.',
      );
    if (action.kind === 'scroll_node') {
      requireCapability(c.swipe, 'scrolling');
      const target = old.nativeNodes.find((n) => n.id === action.node_id);
      if (!target?.enabled || !(target.scrollable || target.semantic?.role === 'scroll'))
        throw new PhoneError(
          'NODE_NOT_SCROLLABLE',
          'Choose a scroll region from the current observation.',
        );
      const current = this.currentNode(old, target, await s.adapter.tree(s.device));
      if (!current?.enabled)
        throw new PhoneError('STALE_NODE', 'The scroll region changed. Inspect again.');
      const display =
        (await s.adapter.inputDisplay?.(s.device)) ?? (await s.adapter.capture(s.device)).display;
      if ('display' in old.observation && !sameInputDisplay(old.observation.display, display))
        throw new PhoneError('DISPLAY_CHANGED', 'Display changed. Observe again before scrolling.');
      const b = current.bounds;
      const left = Math.max(0, b.x),
        right = Math.min(display.inputWidth - 1, b.x + b.width);
      const top = Math.max(0, b.y),
        bottom = Math.min(display.inputHeight - 1, b.y + b.height);
      if (right - left < 20 || bottom - top < 20)
        throw new PhoneError('NODE_NOT_SCROLLABLE', 'The visible scroll region is too small.');
      const x = (left + right) / 2,
        y = (top + bottom) / 2;
      // direction describes content exploration: down moves the finger upward.
      const dx = ['left', 'right'].includes(action.direction)
        ? (((right - left) * action.distance) / 2) * (action.direction === 'right' ? 1 : -1)
        : 0;
      const dy = ['up', 'down'].includes(action.direction)
        ? (((bottom - top) * action.distance) / 2) * (action.direction === 'down' ? 1 : -1)
        : 0;
      return {
        kind: 'swipe',
        x: Math.round(x + dx),
        y: Math.round(y + dy),
        toX: Math.round(x - dx),
        toY: Math.round(y - dy),
        durationMs: action.duration_ms,
      };
    }
    if (!('display' in old.observation)) {
      if (action.kind !== 'tap_node' && action.kind !== 'text')
        throw new PhoneError(
          'SCREEN_OBSERVATION_REQUIRED',
          'Coordinate actions need a screenshot from phone_observe. Use tap_node with a tree observation.',
        );
      requireCapability(action.kind === 'text' ? c.text !== 'unsupported' : c.tap, action.kind);
      const target =
        action.kind === 'tap_node'
          ? old.nativeNodes.find((node) => node.id === action.node_id && node.enabled)
          : old.nativeNodes.find((node) => node.enabled && node.focused && isEditableNode(node));
      if (!target)
        throw new PhoneError(
          action.kind === 'text' ? 'FOCUS_REQUIRED' : 'NODE_NOT_FOUND',
          'Inspect the current controls and select an enabled target.',
        );
      const current = this.currentNode(old, target, await s.adapter.tree(s.device));
      if (!current?.enabled || (action.kind === 'text' && !current.focused))
        throw new PhoneError(
          action.kind === 'text' ? 'FOCUS_CHANGED' : 'STALE_NODE',
          'The control moved, changed or lost focus. Inspect again before acting.',
        );
      const display =
        (await s.adapter.inputDisplay?.(s.device)) ?? (await s.adapter.capture(s.device)).display;
      const point = visibleInputPoint(current.bounds, display);
      return action.kind === 'text'
        ? { kind: 'text', text: action.text, target: point }
        : { kind: 'tap', ...point };
    }
    // Pointer input needs a current viewport, not another full-resolution PNG.
    // Unknown/older drivers retain the verified capture fallback.
    const inputDisplay = await s.adapter.inputDisplay?.(s.device).catch(() => undefined);
    const freshDisplay = inputDisplay ?? (await s.adapter.capture(s.device)).display;
    if (
      !(inputDisplay || old.source === 'preview' ? sameInputDisplay : sameDisplay)(
        old.observation.display,
        freshDisplay,
      )
    ) {
      s.observations.clear();
      throw new PhoneError(
        'DISPLAY_CHANGED',
        'Display size, rotation or posture changed. Observe again before acting.',
      );
    }
    if (action.kind === 'text') {
      requireCapability(c.text !== 'unsupported', 'text input');
      const target = old.nativeNodes.find((n) => n.enabled && n.focused && isEditableNode(n));
      if (!target)
        throw new PhoneError(
          'FOCUS_REQUIRED',
          'Focus an editable field and observe with_tree=true before typing.',
        );
      const current = this.currentNode(old, target, await s.adapter.tree(s.device));
      if (!current?.enabled || !current.focused)
        throw new PhoneError(
          'FOCUS_CHANGED',
          'The observed input field lost focus or changed. Observe again.',
        );
      return {
        kind: 'text',
        text: action.text,
        target: visibleInputPoint(current.bounds, freshDisplay),
      };
    }
    requireCapability(action.kind === 'swipe' ? c.swipe : c.tap, action.kind);
    if (action.kind === 'tap_node') {
      const node = old.nativeNodes.find((n) => n.id === action.node_id);
      if (!node?.enabled)
        throw new PhoneError('NODE_NOT_FOUND', 'Use an enabled node from this observation.');
      const freshNode = this.currentNode(old, node, await s.adapter.tree(s.device));
      if (!freshNode?.enabled)
        throw new PhoneError('STALE_NODE', 'The target moved or changed. Observe again.');
      return { kind: 'tap', ...visibleInputPoint(freshNode.bounds, freshDisplay) };
    }
    const point = toDriverPoint(action.x, action.y, action.space, old.observation.display);
    if (action.kind === 'tap') return { kind: 'tap', ...point };
    const end = toDriverPoint(action.to_x, action.to_y, action.space, old.observation.display);
    return { kind: 'swipe', ...point, toX: end.x, toY: end.y, durationMs: action.duration_ms };
  }
  private sameNode(a: UINode, b: UINode) {
    return (
      a.type === b.type &&
      a.parentId === b.parentId &&
      a.resourceId === b.resourceId &&
      JSON.stringify(a.bounds) === JSON.stringify(b.bounds) &&
      a.text === b.text &&
      ['description', 'value', 'hint', 'checked', 'selected', 'editable', 'password'].every(
        (key) => a[key as keyof UINode] === b[key as keyof UINode],
      )
    );
  }
  private currentNode(old: StoredObservation, target: UINode, current: UINode[]) {
    const ids = [
      target.id,
      ...(target.semantic?.name_node_ids ?? []),
      ...(target.semantic?.context?.name_node_ids ?? []),
    ];
    const byId = new Map<string, UINode[]>();
    for (const node of current)
      if (ids.includes(node.id)) {
        const matches = byId.get(node.id) ?? [];
        matches.push(node);
        byId.set(node.id, matches);
      }
    for (const id of new Set(ids)) {
      const previous = id === target.id ? target : old.evidenceNodes.get(id);
      const matches = byId.get(id);
      if (!previous || matches?.length !== 1 || !this.sameNode(previous, matches[0]!)) return;
    }
    return byId.get(target.id)?.[0];
  }
  /** A manual finger owns a short lease. Model actions cannot interleave with it. */
  pointer(
    id: string,
    owner: string,
    event: {
      phase: 'down' | 'move' | 'up' | 'cancel';
      x: number;
      y: number;
      observation_id?: string;
    },
  ) {
    if (
      !owner ||
      owner.length > 200 ||
      !['down', 'move', 'up', 'cancel'].includes(event.phase) ||
      ![event.x, event.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
    )
      throw new PhoneError('INVALID_REQUEST', 'Invalid manual pointer event.');
    const s = this.get(id);
    return this.serialized(s, async () => {
      if (event.phase === 'cancel') {
        if (s.pointer?.owner === owner) await this.releasePointer(s);
        return { applied: true };
      }
      if (s.paused) throw new PhoneError('SESSION_PAUSED', 'Device is paused.');
      if (s.pointer && s.pointer.owner !== owner)
        throw new PhoneError('DEVICE_BUSY', 'Another view owns the active finger.');
      try {
        if (!s.adapter.pointerReady?.(s.device))
          throw new PhoneError('UNSUPPORTED', 'Continuous native input is unavailable.');
        let point;
        if (event.phase === 'down') {
          if (s.pointer) throw new PhoneError('DEVICE_BUSY', 'A finger is already active.');
          const prepared = await this.prepare(
            s,
            actionSchema.parse({
              kind: 'tap',
              x: event.x,
              y: event.y,
              space: 'normalized',
              observation_id: event.observation_id,
            }),
          );
          if (prepared.kind !== 'tap') throw new Error('Invalid pointer preparation');
          const old = s.observations.get(event.observation_id!)!;
          if (!('display' in old.observation))
            throw new PhoneError(
              'SCREEN_OBSERVATION_REQUIRED',
              'Manual input needs a visible frame.',
            );
          point = { x: prepared.x, y: prepared.y };
          if (
            !insideInputInset(
              point.x,
              point.y,
              old.observation.display,
              s.adapter.pointerInset?.(s.device) ?? 0,
            )
          )
            throw new PhoneError(
              'UNSUPPORTED',
              'This screen edge requires a complete gesture. No touch was submitted.',
            );
          s.pointer = { owner, display: old.observation.display, ...point, checkedAt: this.now() };
          s.observations.clear();
          s.cached = undefined;
          s.activity = {
            id: (s.activity?.id ?? 0) + 1,
            kind: 'swipe',
            at: new Date(this.now()).toISOString(),
            status: 'running',
          };
        } else {
          if (!s.pointer)
            throw new PhoneError('STALE_POINTER', 'Start a new gesture from a current frame.');
          // Keep coordinate conversion local; periodically confirm geometry during long drags.
          if (this.now() - s.pointer.checkedAt > 500) {
            const display = await s.adapter.inputDisplay?.(s.device);
            if (!display || !sameInputDisplay(display, s.pointer.display))
              throw new PhoneError('DISPLAY_CHANGED', 'Display changed during manual input.');
            s.pointer.checkedAt = this.now();
          }
          point = toDriverPoint(event.x, event.y, 'normalized', s.pointer.display);
        }
        if (s.paused || s.closing)
          throw new PhoneError('SESSION_PAUSED', 'Manual input cancelled before submission.');
        clearTimeout(s.pointer!.timer);
        s.pointer!.x = point.x;
        s.pointer!.y = point.y;
        s.pointer!.timer = setTimeout(() => {
          void this.cancelPointer(id, owner);
        }, 5000);
        s.pointer!.timer.unref();
        await s.adapter.execute(s.device, { kind: 'pointer', phase: event.phase, ...point });
        if (event.phase === 'up') {
          clearTimeout(s.pointer!.timer);
          s.pointer = undefined;
          if (s.activity) s.activity.status = 'applied';
        }
        return { applied: true };
      } catch (error) {
        if (s.pointer?.owner === owner && s.activity)
          s.activity.status =
            event.phase === 'down' && error instanceof PhoneError && !error.uncertain
              ? 'failed'
              : 'uncertain';
        await this.releasePointer(s);
        throw error;
      }
    });
  }
  async cancelPointer(id: string, owner: string) {
    const s = this.sessions.get(id);
    if (!s || s.closing) return;
    await this.serialized(
      s,
      async () => {
        if (s.pointer?.owner === owner) await this.releasePointer(s);
      },
      false,
    ).catch(() => {});
  }
  private async releasePointer(s: Session) {
    const pointer = s.pointer;
    s.pointer = undefined;
    if (!pointer) return;
    clearTimeout(pointer.timer);
    await s.adapter
      .execute(s.device, { kind: 'pointer', phase: 'cancel', x: pointer.x, y: pointer.y })
      .catch(() => {
        if (s.activity) s.activity.status = 'uncertain';
      });
    if (s.activity?.status === 'running') s.activity.status = 'applied';
    s.observations.clear();
    s.cached = undefined;
  }
  act(id: string, input: unknown, observe: FollowUp = 'tree') {
    const follow = followUpSchema.parse(observe);
    const action = actionSchema.parse(input),
      s = this.get(id);
    const requestedAt = performance.now();
    return this.serialized(s, async () => {
      const startedAt = performance.now();
      if (s.pointer)
        throw new PhoneError(
          'DEVICE_BUSY',
          'A manual finger is active. Finish the gesture before model input.',
        );
      if (s.paused)
        throw new PhoneError('SESSION_PAUSED', 'Resume the session before controlling the device.');
      const activity: Activity = {
        id: (s.activity?.id ?? 0) + 1,
        kind: action.kind,
        at: new Date(this.now()).toISOString(),
        status: 'running',
      };
      s.activity = activity;
      let prepared: DriverAction;
      try {
        prepared = await this.prepare(s, action);
      } catch (error) {
        activity.status = 'failed';
        throw error;
      }
      if (s.paused || s.closing) {
        activity.status = 'failed';
        throw new PhoneError(
          s.paused ? 'SESSION_PAUSED' : 'SESSION_CLOSED',
          'Action cancelled before submission.',
        );
      }
      if ((prepared.kind === 'tap' || prepared.kind === 'swipe') && s.display) {
        activity.point = {
          x: prepared.x / s.display.inputWidth,
          y: prepared.y / s.display.inputHeight,
        };
        if (prepared.kind === 'swipe')
          activity.to = {
            x: prepared.toX / s.display.inputWidth,
            y: prepared.toY / s.display.inputHeight,
          };
      }
      // Clear before submission: a timeout must never leave an apparently reusable observation.
      s.observations.clear();
      s.cached = undefined;
      const preparedAt = performance.now();
      try {
        await s.adapter.execute(s.device, prepared);
      } catch (e) {
        activity.status = e instanceof PhoneError && !e.uncertain ? 'failed' : 'uncertain';
        if (e instanceof PhoneError) throw e;
        throw new PhoneError(
          'ACTION_UNCERTAIN',
          'The driver failed after action submission. Observe before continuing.',
          true,
        );
      }
      activity.status = 'applied';
      if (!follow)
        return {
          applied: true as const,
          timing_ms: {
            queue: Math.round(startedAt - requestedAt),
            prepare: Math.round(preparedAt - startedAt),
            execute: Math.round(performance.now() - preparedAt),
          },
        };
      try {
        const options =
          typeof follow === 'object'
            ? follow
            : {
                mode: follow === 'tree' ? 'tree' : 'image',
                max_nodes: 60,
                wait_timeout_ms: 2000,
                query: undefined,
                ocr: 'off' as const,
              };
        if (options.mode === 'tree')
          return {
            applied: true as const,
            inspection: await this.inspectTree(s, options.max_nodes, options.query),
          };
        return {
          applied: true as const,
          capture: await this.capture(
            s,
            true,
            options.max_nodes,
            'agent',
            options.wait_timeout_ms,
            options.ocr,
            options.query,
          ),
        };
      } catch (e) {
        return { applied: true as const, observation_error: errorData(e) };
      }
    });
  }
  pause(id: string, paused: boolean) {
    const s = this.get(id);
    // Stop in-flight preview publication as soon as a pause is requested.
    if (paused) {
      s.paused = true;
      s.revision++;
      s.observations.clear();
      s.cached = undefined;
    }
    return this.serialized(s, async () => {
      await this.releasePointer(s);
      if (paused) s.adapter.stopPreview?.(s.device);
      s.paused = paused;
      s.observations.clear();
      s.cached = undefined;
      return { session_id: id, paused };
    });
  }
  async close(id: string) {
    const s = this.get(id);
    s.closing = true;
    const warnings: ReturnType<typeof errorData>[] = [];
    await this.serialized(s, async () => {
      try {
        await this.releasePointer(s);
        s.adapter.stopPreview?.(s.device);
        await s.adapter.close?.(s.device);
      } catch (error) {
        // Device teardown can fail after a cable is removed or WDA stops. The
        // local session and exclusive lease are still released below; report
        // that outcome so clients do not retry closing a nonexistent session.
        warnings.push(errorData(error));
      } finally {
        await s.lease.release();
        s.observations.clear();
        s.cached = undefined;
        this.sessions.delete(id);
        this.ocr.clear();
      }
    });
    return { closed: true, ...(warnings.length ? { cleanup_warnings: warnings } : {}) };
  }
  async shutdown() {
    clearInterval(this.expiry);
    await Promise.allSettled([...this.disposers].map((dispose) => dispose()));
    this.disposers.clear();
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
    await this.ocr.dispose();
  }
  onShutdown(dispose: () => Promise<void>) {
    this.disposers.add(dispose);
  }
}
