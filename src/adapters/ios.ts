import type {
  Device,
  DeviceAdapter,
  DeviceInfo,
  DriverAction,
  Frame,
  Display,
} from '../core/types.js';
import { PhoneError } from '../core/errors.js';
import { pngSize } from '../core/images.js';
import { isEditableNode } from '../core/perception.js';
import { insideInputInset } from '../core/geometry.js';
import { parseIOSTree } from './parsers.js';
import { httpMjpeg, LatestVideo, VideoPreview } from '../transport/video.js';
import { EncodedVideo } from '../transport/encoded-video.js';
import { iosSimulatorVideo, type IOSSimulatorOptions } from '../transport/host-video.js';
import { IOSSimulatorControl } from '../transport/ios-simulator.js';
import { IOSNativeInput } from '../transport/ios-native-input.js';

export interface WdaDevice {
  name: string;
  url: string;
  model?: string;
  mjpegUrl?: string;
  allowRemote?: boolean;
  simulator?: IOSSimulatorOptions;
}
/** Connects to an already signed/running WDA. Signing and USB forwarding stay outside this adapter. */
export class IOSAdapter implements DeviceAdapter {
  readonly platform = 'ios' as const;
  private readonly sessions = new Map<string, string>();
  private readonly previews = new Map<string, VideoPreview>();
  private readonly encoded = new Map<string, EncodedVideo>();
  private readonly simulatorControls = new Map<string, IOSSimulatorControl | IOSNativeInput>();
  private readonly inputGeometry = new Map<string, { display: Display; at: number }>();
  constructor(
    private readonly devices: WdaDevice[],
    private readonly request: typeof fetch = fetch,
  ) {
    for (const device of devices) {
      if (device.simulator) {
        if (device.allowRemote)
          throw new PhoneError(
            'CONFIG_ERROR',
            'A local simulator cannot be combined with a remote WDA endpoint.',
          );
        this.encoded.set(
          `ios:${device.name}`,
          new EncodedVideo(iosSimulatorVideo(device.simulator)),
        );
        // Video and input have independent compatibility. Native input remains
        // explicit; the small DTUHID bridge also carries system edge gestures.
        if (device.simulator.nativeInput === true)
          this.simulatorControls.set(
            `ios:${device.name}`,
            device.simulator.inputBridge
              ? new IOSNativeInput(device.simulator)
              : new IOSSimulatorControl(device.simulator),
          );
      }
      for (const endpoint of [device.url, ...(device.mjpegUrl ? [device.mjpegUrl] : [])]) {
        const url = new URL(endpoint);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          (!device.allowRemote && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
          url.username ||
          url.password
        ) {
          throw new PhoneError(
            'CONFIG_ERROR',
            'WDA endpoints require HTTP(S), no embedded credentials, and loopback unless allowRemote is explicitly enabled for this device.',
          );
        }
      }
      if (device.mjpegUrl)
        this.previews.set(
          `ios:${device.name}`,
          new VideoPreview(new LatestVideo(httpMjpeg(device.mjpegUrl, request)), 'wda-mjpeg'),
        );
    }
  }
  private async call(
    device: Device,
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ): Promise<any> {
    const endpoint = this.devices.find((d) => `ios:${d.name}` === device.id);
    if (!endpoint) throw new PhoneError('DEVICE_NOT_FOUND', 'Unknown WDA endpoint.');
    let response: Response;
    try {
      response = await this.request(`${endpoint.url.replace(/\/$/, '')}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new PhoneError(
        'WDA_UNREACHABLE',
        'WDA did not respond. Check signing, runner and USB forwarding.',
        body !== undefined,
      );
    }
    if (!response.ok)
      throw new PhoneError(
        'WDA_ERROR',
        `WDA returned HTTP ${response.status}.`,
        body !== undefined,
      );
    const result = (await response.json()) as any;
    if (result.value?.error || (result.status && result.status !== 0))
      throw new PhoneError(
        'WDA_ERROR',
        'WDA reported an error. Observe before retrying.',
        body !== undefined,
      );
    return result;
  }
  async discover(): Promise<Device[]> {
    const found: Device[] = [];
    for (const endpoint of this.devices) {
      const device: Device = {
        id: `ios:${endpoint.name}`,
        name: endpoint.name,
        platform: this.platform,
        transport: endpoint.allowRemote ? 'wda-network' : 'wda-loopback',
        ...(endpoint.model ? { model: endpoint.model } : {}),
      };
      // Configured but unavailable WDA is an error, not a healthy phone.
      await this.call(device, '/status');
      found.push(device);
    }
    return found;
  }
  private async session(device: Device) {
    if (!this.sessions.has(device.id)) {
      const result = await this.call(device, '/session', {
        capabilities: { alwaysMatch: { shouldWaitForQuiescence: false, waitForIdleTimeout: 0 } },
      });
      const id = result.sessionId ?? result.value?.sessionId;
      if (typeof id !== 'string') throw new PhoneError('WDA_ERROR', 'WDA returned no session ID.');
      this.sessions.set(device.id, id);
      await this.call(device, `/session/${encodeURIComponent(id)}/appium/settings`, {
        settings: {
          waitForIdleTimeout: 0,
          animationCoolOffTimeout: 0,
          // JSON source's isFocused is accessibility focus, not keyboard focus.
          // /element/active queries XCTest's hasKeyboardFocus instead. Include
          // enough identity to match it to exactly one current tree control.
          shouldUseCompactResponses: false,
          elementResponseAttributes: 'type,label,rect,attribute/name,enabled,displayed',
          ...(this.previews.has(device.id)
            ? {
                mjpegServerFramerate: 30,
                mjpegServerScreenshotQuality: 80,
                mjpegScalingFactor: 100,
              }
            : {}),
        },
      }).catch(() => {}); // Older WDA versions keep their existing settings.
    }
    return `/session/${encodeURIComponent(this.sessions.get(device.id)!)}`;
  }
  async inspect(device: Device): Promise<DeviceInfo> {
    const status = await this.call(device, '/status');
    await this.session(device);
    await this.simulatorControls.get(device.id)?.warmup();
    return {
      ...device,
      version: String(status.value?.os?.version ?? 'unknown'),
      capabilities: {
        screenshot: true,
        tree: true,
        tap: true,
        swipe: true,
        text: 'unicode',
        keys: ['home', 'enter'],
        launch: true,
        displayState: true,
        foldControl: false,
        stream: this.encoded.has(device.id)
          ? 'ios-simulator'
          : this.previews.has(device.id)
            ? 'wda-mjpeg'
            : 'snapshots',
      },
    };
  }
  async capture(device: Device): Promise<Frame> {
    const session = await this.session(device);
    const window = (await this.call(device, `${session}/window/size`)).value;
    const orientation = (await this.call(device, `${session}/orientation`)).value;
    const image = (await this.call(device, '/screenshot')).value;
    const afterWindow = (await this.call(device, `${session}/window/size`)).value;
    const afterOrientation = (await this.call(device, `${session}/orientation`)).value;
    if (
      window?.width !== afterWindow?.width ||
      window?.height !== afterWindow?.height ||
      orientation !== afterOrientation
    ) {
      throw new PhoneError(
        'DISPLAY_CHANGED',
        'iOS orientation or viewport changed during capture. Observe again.',
      );
    }
    if (typeof image !== 'string' || image.length > 28 * 1024 * 1024)
      throw new PhoneError('INVALID_FRAME', 'WDA screenshot is missing or too large.');
    const bytes = Buffer.from(image, 'base64'),
      size = pngSize(bytes);
    if (!(window?.width > 0 && window?.height > 0))
      throw new PhoneError('INVALID_FRAME', 'WDA returned an invalid point viewport.');
    const frame: Frame = {
      bytes,
      mimeType: 'image/png',
      display: {
        id: 'default',
        ...size,
        inputWidth: window.width,
        inputHeight: window.height,
        rotation:
          (
            {
              PORTRAIT: 0,
              LANDSCAPE: 90,
              PORTRAIT_UPSIDEDOWN: 180,
              LANDSCAPE_RIGHT: 270,
            } as Record<string, number>
          )[orientation] ?? null,
        posture: 'unknown',
      },
    };
    this.rememberInput(device, frame.display);
    this.previews.get(device.id)?.remember(frame.display);
    return frame;
  }
  async preview(device: Device) {
    void this.simulatorControls.get(device.id)?.warmup();
    return this.previews.get(device.id)?.frame(
      () => this.capture(device),
      () => this.inputDisplay(device),
    );
  }
  encodedVideo(device: Device, after: number) {
    void this.simulatorControls.get(device.id)?.warmup();
    const batch = this.encoded.get(device.id)?.read(after);
    return batch ? { ...batch, source: 'ios-simulator' as const } : undefined;
  }
  async inputDisplay(device: Device): Promise<Display> {
    const session = await this.session(device);
    const [sizeResult, orientationResult] = await Promise.all([
      this.call(device, `${session}/window/size`),
      this.call(device, `${session}/orientation`),
    ]);
    const { width, height } = sizeResult.value ?? {};
    if (!(width > 0 && height > 0)) throw new PhoneError('INVALID_FRAME', 'Invalid WDA viewport.');
    const display: Display = {
      id: 'default',
      width,
      height,
      inputWidth: width,
      inputHeight: height,
      rotation:
        (
          { PORTRAIT: 0, LANDSCAPE: 90, PORTRAIT_UPSIDEDOWN: 180, LANDSCAPE_RIGHT: 270 } as Record<
            string,
            number
          >
        )[orientationResult.value] ?? null,
      posture: 'unknown',
    };
    this.rememberInput(device, display);
    return display;
  }
  private rememberInput(device: Device, display: Display) {
    this.inputGeometry.set(device.id, { display, at: Date.now() });
    const control = this.simulatorControls.get(device.id);
    if (control instanceof IOSNativeInput) control.remember(display);
  }
  stopPreview(device: Device) {
    this.previews.get(device.id)?.stop();
    this.encoded.get(device.id)?.stop();
  }
  async liveFrame(device: Device) {
    return this.previews.get(device.id)?.frame(
      () => {
        throw new Error('Live frame cannot capture');
      },
      undefined,
      false,
    );
  }
  async tree(device: Device) {
    const session = await this.session(device);
    const nodes = parseIOSTree((await this.call(device, `${session}/source?format=json`)).value);
    const inputs = nodes.filter(isEditableNode);
    // Never authorize typing from accessibility focus or a previous tap alone.
    for (const input of inputs) input.focused = false;
    if (!inputs.some((input) => input.enabled)) return nodes;
    const active = await this.call(device, `${session}/element/active`)
      .then((result) => result.value)
      .catch(() => undefined);
    if (
      !active ||
      typeof active.type !== 'string' ||
      !(typeof active.label === 'string' || active.label === null) ||
      !(typeof active['attribute/name'] === 'string' || active['attribute/name'] === null) ||
      active.enabled !== true ||
      active.displayed !== true ||
      !active.rect ||
      !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(active.rect[key]))
    )
      return nodes;
    const matches = inputs.filter(
      (input) =>
        input.enabled &&
        input.type.replace(/^XCUIElementType/, '') ===
          active.type.replace(/^XCUIElementType/, '') &&
        (input.description ?? '') === (active.label ?? '') &&
        input.resourceId === (active['attribute/name'] ?? '') &&
        (['x', 'y', 'width', 'height'] as const).every(
          (key) => Math.abs(input.bounds[key] - active.rect[key]) < 0.5,
        ),
    );
    if (matches.length === 1) matches[0]!.focused = true;
    return nodes;
  }
  pointerReady(device: Device) {
    return this.simulatorControls.get(device.id)?.pointerReady ?? false;
  }
  pointerInset(device: Device) {
    // idb's HID RPC does not carry DTUHID's edge-origin flag. Keep system
    // gestures on WDA, selected BEFORE submission; ordinary drags still stream.
    // This conservative band is in logical points, independent of model/scale.
    const control = this.simulatorControls.get(device.id);
    return control && !(control instanceof IOSNativeInput) ? 24 : 0;
  }
  async execute(device: Device, action: DriverAction): Promise<void> {
    const native = this.simulatorControls.get(device.id);
    let nativeStart = true;
    if (
      native &&
      (action.kind === 'swipe' || (action.kind === 'pointer' && action.phase === 'down'))
    ) {
      const cached = this.inputGeometry.get(device.id);
      const display =
        cached && Date.now() - cached.at < 500 ? cached.display : await this.inputDisplay(device);
      nativeStart = insideInputInset(action.x, action.y, display, this.pointerInset(device));
    }
    if (nativeStart && (await native?.execute(action))) return;
    if (action.kind === 'pointer')
      throw new PhoneError(
        'UNSUPPORTED',
        'Continuous touch requires a native simulator channel. WDA uses complete gestures.',
      );
    const session = await this.session(device);
    switch (action.kind) {
      case 'tap':
        await this.call(device, `${session}/wda/tap`, { x: action.x, y: action.y });
        break;
      case 'swipe':
        // WDA dragfromtoforduration.duration is a stationary press BEFORE
        // dragging, not the movement duration. A W3C touch sequence preserves
        // the requested movement time without turning swipes into long presses.
        await this.call(device, `${session}/actions`, {
          actions: [
            {
              type: 'pointer',
              id: 'finger',
              parameters: { pointerType: 'touch' },
              actions: [
                { type: 'pointerMove', duration: 0, origin: 'viewport', x: action.x, y: action.y },
                { type: 'pointerDown', button: 0 },
                {
                  type: 'pointerMove',
                  duration: action.durationMs,
                  origin: 'viewport',
                  x: action.toX,
                  y: action.toY,
                },
                { type: 'pointerUp', button: 0 },
              ],
            },
          ],
        });
        break;
      case 'text':
        await this.call(device, `${session}/wda/keys`, { value: [action.text] });
        break;
      case 'launch':
        await this.call(device, `${session}/wda/apps/activate`, { bundleId: action.appId });
        break;
      case 'key':
        if (action.key === 'home') await this.call(device, '/wda/homescreen', {});
        else if (action.key === 'enter')
          await this.call(device, `${session}/wda/keys`, { value: ['\n'] });
        else throw new PhoneError('UNSUPPORTED', 'iOS has no universal back key.');
        break;
      case 'fold':
        throw new PhoneError('UNSUPPORTED', 'iOS fold control is unavailable.');
    }
  }
  async close(device: Device) {
    this.stopPreview(device);
    this.inputGeometry.delete(device.id);
    await this.simulatorControls.get(device.id)?.close();
    const session = this.sessions.get(device.id);
    try {
      if (session)
        await this.call(device, `/session/${encodeURIComponent(session)}`, undefined, 'DELETE');
    } finally {
      this.sessions.delete(device.id);
    }
  }
}
