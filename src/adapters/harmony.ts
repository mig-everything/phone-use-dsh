import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
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
import { DeviceShell, ProcessRunner, type Runner } from '../transport/process.js';
import { parseDisplayDump, parseHarmonyTree } from './parsers.js';
import { LatestVideo, VideoPreview } from '../transport/video.js';
import { harmonyVideo, harmonyEncoded } from '../transport/process-video.js';
import { EncodedVideo } from '../transport/encoded-video.js';
import { HarmonyBridge } from '../transport/harmony-bridge.js';

export interface HarmonyOptions {
  binary?: string;
  server?: string;
  allowEmulatorFold?: boolean;
  bridge?: { enabled?: boolean; scale?: number; input?: boolean };
  video?: {
    ffmpeg: string;
    devices: { deviceId: string; url: string; token: string; allowRemote?: boolean }[];
  };
}
export function isUITestFailure(output: string) {
  // UITest reports successful input as the literal string "No Error".
  return /(?:^|\n)\s*(?:error(?:\s|:|$)|failed\b|fail:|missing parameter\b|not support\b)/i.test(
    output,
  );
}
export class HarmonyAdapter implements DeviceAdapter {
  readonly platform = 'harmonyos' as const;
  private readonly inputModes = new Map<string, 'text' | 'inputText' | 'unsupported'>();
  private readonly previews = new Map<string, VideoPreview>();
  private readonly encoded = new Map<string, EncodedVideo>();
  private readonly snapshotRetry = new Map<string, number>();
  private readonly bridges = new Map<string, HarmonyBridge>();
  private readonly bridgeRetry = new Map<string, number>();
  private readonly bridgeChecked = new Map<string, { epoch?: number; at: number }>();
  constructor(
    private readonly options: HarmonyOptions = {},
    private readonly runner: Runner = new ProcessRunner(),
  ) {
    for (const endpoint of options.video?.devices ?? []) {
      const url = new URL(endpoint.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        (!endpoint.allowRemote && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      )
        throw new PhoneError(
          'CONFIG_ERROR',
          'Harmony video requires HTTP(S) without embedded credentials; set allowRemote explicitly for a LAN endpoint.',
        );
      this.previews.set(
        endpoint.deviceId,
        new VideoPreview(
          new LatestVideo(harmonyVideo(endpoint.url, endpoint.token, options.video!.ffmpeg)),
          'harmony-native',
        ),
      );
      this.encoded.set(
        endpoint.deviceId,
        new EncodedVideo(harmonyEncoded(endpoint.url, endpoint.token)),
      );
    }
  }
  private channel(device?: Device) {
    return new DeviceShell(this.runner, this.options.binary ?? 'hdc', [
      ...(this.options.server ? ['-s', this.options.server] : []),
      ...(device ? ['-t', device.id.slice('harmonyos:'.length)] : []),
    ]);
  }
  async discover(): Promise<Device[]> {
    const output = (await this.channel().run(['list', 'targets'], 6000)).toString();
    if (/\[Empty\]/i.test(output)) return [];
    return output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && /^[\w.:-]+$/.test(s))
      .map((serial) => ({
        id: `harmonyos:${serial}`,
        platform: this.platform,
        name: serial,
        transport: serial.includes(':') ? 'hdc-tcp' : 'hdc-usb',
      }));
  }
  private async display(device: Device) {
    return this.channel(device).shell(['hidumper', '-s', 'DisplayManagerService', '-a', '-a']);
  }
  async inspect(device: Device): Promise<DeviceInfo> {
    const shell = this.channel(device);
    const help = await shell.shell(['uitest', 'help']);
    const inputMode = /\btext\s+<text>/.test(help)
      ? 'text'
      : /\binputText\b/.test(help)
        ? 'inputText'
        : 'unsupported';
    this.inputModes.set(device.id, inputMode);
    const version = await shell.shell(['param', 'get', 'const.product.software.version']);
    const apiLevel = await shell.shell(['param', 'get', 'const.ohos.apiversion']);
    const name = await shell.shell(['param', 'get', 'const.product.model']);
    const display = await this.display(device).catch(() => '');
    const foldControl = Boolean(
      this.options.allowEmulatorFold &&
        /emulator/i.test(version) &&
        /dms\.hidumper\.supportdebug\s+true/.test(display) &&
        parseDisplayDump(display).posture !== 'unknown',
    );
    return {
      ...device,
      name: name || device.name,
      ...(name ? { model: name } : {}),
      version,
      apiLevel,
      capabilities: {
        screenshot: /screenCap/.test(help),
        tree: /dumpLayout/.test(help),
        tap: /\bclick\b/.test(help),
        swipe: /\bswipe\b/.test(help),
        text: inputMode !== 'unsupported' ? 'unicode' : 'unsupported',
        keys: /keyEvent/.test(help) ? ['home', 'back', 'enter'] : [],
        launch: true,
        displayState: /Screen ID:/.test(display),
        foldControl,
        stream: this.previews.has(device.id) ? 'harmony-native' : 'snapshots',
      },
    };
  }
  private async file(
    device: Device,
    kind: 'screenCap' | 'dumpLayout' | 'snapshot',
  ): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'phone-use-'));
    const remote = `/data/local/tmp/phone-use-${randomUUID()}.${kind === 'snapshot' ? 'jpeg' : kind === 'screenCap' ? 'png' : 'json'}`;
    const local = join(dir, 'capture');
    const shell = this.channel(device);
    try {
      const result = await shell.shell(
        kind === 'snapshot' ? ['snapshot_display', '-f', remote] : ['uitest', kind, '-p', remote],
      );
      if (isUITestFailure(result)) throw new PhoneError('CAPTURE_FAILED', `UITest ${kind} failed.`);
      await shell.run(['file', 'recv', remote, local]);
      const bytes = await readFile(local);
      if (bytes.length > 20 * 1024 * 1024)
        throw new PhoneError('OUTPUT_LIMIT', 'Capture exceeds 20 MiB.');
      return bytes;
    } finally {
      await shell.shell(['rm', '-f', remote], 3000).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
  async capture(device: Device): Promise<Frame> {
    const before = await this.display(device).catch(() => '');
    const bytes = await this.file(device, 'screenCap');
    const size = pngSize(bytes);
    const after = await this.display(device).catch(() => '');
    if (JSON.stringify(parseDisplayDump(before)) !== JSON.stringify(parseDisplayDump(after))) {
      throw new PhoneError('DISPLAY_CHANGED', 'Screen changed during capture. Observe again.');
    }
    const frame: Frame = {
      bytes,
      mimeType: 'image/png',
      display: {
        ...size,
        inputWidth: size.width,
        inputHeight: size.height,
        ...parseDisplayDump(after),
      },
    };
    this.previews.get(device.id)?.remember(frame.display);
    return frame;
  }
  async preview(device: Device) {
    try {
      const video = await this.previews.get(device.id)?.frame(
        () => this.capture(device),
        () => this.inputDisplay(device),
      );
      if (video) return video;
    } catch {} // Native capture is optional; keep the screenshot channel available.
    if (
      this.options.bridge?.enabled !== false &&
      Date.now() >= (this.bridgeRetry.get(device.id) ?? 0)
    ) {
      let bridge = this.bridges.get(device.id);
      try {
        if (!bridge) {
          const display = await this.inputDisplay(device);
          if (display) {
            bridge = new HarmonyBridge(
              this.channel(device),
              display,
              this.options.bridge?.scale ?? 1,
            );
            this.bridges.set(device.id, bridge);
            await bridge.start();
          }
        }
        if (bridge?.frame()) {
          const checked = this.bridgeChecked.get(device.id);
          if (!checked || checked.epoch !== bridge.epoch || Date.now() - checked.at > 5000) {
            await this.inputDisplay(device);
            this.bridgeChecked.set(device.id, { epoch: bridge.epoch, at: Date.now() });
          }
          return bridge.frame();
        }
        if (bridge) throw bridge.failure ?? new Error('Native preview ended.');
      } catch (error) {
        await bridge?.close();
        this.bridges.delete(device.id);
        this.bridgeChecked.delete(device.id);
        this.bridgeRetry.set(
          device.id,
          Date.now() +
            (error instanceof PhoneError && error.code === 'DISPLAY_CHANGED' ? 500 : 60_000),
        );
      }
    }
    if (Date.now() < (this.snapshotRetry.get(device.id) ?? 0)) return;
    try {
      const before = await this.inputDisplay(device);
      if (!before) return;
      const bytes = await this.file(device, 'snapshot');
      const after = await this.inputDisplay(device);
      if (!after || JSON.stringify(before) !== JSON.stringify(after))
        throw new PhoneError('DISPLAY_CHANGED', 'Screen changed during preview capture.');
      const info = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
      if (
        info.format !== 'jpeg' ||
        info.width !== after.inputWidth ||
        info.height !== after.inputHeight
      )
        throw new PhoneError('INVALID_FRAME', 'Preview does not match the current display.');
      return { bytes, mimeType: 'image/jpeg' as const, display: after };
    } catch (error) {
      if (!(error instanceof PhoneError && error.code === 'DISPLAY_CHANGED'))
        this.snapshotRetry.set(device.id, Date.now() + 60_000);
      return;
    }
  }
  async inputDisplay(device: Device): Promise<Display | undefined> {
    const dump = await this.display(device);
    const info = dump.match(/\[DISPLAY INFO\]([\s\S]*?)(?:----|$)/)?.[1];
    const width = Number(info?.match(/\bWidth:\s*(\d+)/)?.[1]);
    const height = Number(info?.match(/\bHeight:\s*(\d+)/)?.[1]);
    if (!(width > 0 && height > 0)) return;
    const display = {
      ...parseDisplayDump(dump),
      width,
      height,
      inputWidth: width,
      inputHeight: height,
    };
    this.bridges.get(device.id)?.remember(display);
    return display;
  }
  stopPreview(device: Device) {
    void this.bridges.get(device.id)?.close();
    this.bridges.delete(device.id);
    this.bridgeChecked.delete(device.id);
    this.previews.get(device.id)?.stop();
    this.encoded.get(device.id)?.stop();
  }
  encodedVideo(device: Device, after: number) {
    return this.encoded.get(device.id)?.read(after);
  }
  async liveFrame(device: Device) {
    const native = this.bridges.get(device.id)?.frame();
    if (native) return native;
    return this.previews.get(device.id)?.frame(
      () => {
        throw new Error('Live frame cannot capture');
      },
      undefined,
      false,
    );
  }
  async close(device: Device) {
    await this.bridges.get(device.id)?.close();
    this.stopPreview(device);
    this.inputModes.delete(device.id);
    this.snapshotRetry.delete(device.id);
    this.bridgeRetry.delete(device.id);
  }
  async tree(device: Device) {
    try {
      return parseHarmonyTree(JSON.parse((await this.file(device, 'dumpLayout')).toString()));
    } catch (e) {
      if (e instanceof SyntaxError)
        throw new PhoneError('INVALID_TREE', 'UITest returned invalid JSON.');
      throw e;
    }
  }
  pointerReady(device: Device) {
    return this.options.bridge?.input !== false && !!this.bridges.get(device.id)?.pointerReady;
  }
  async execute(device: Device, action: DriverAction): Promise<void> {
    // Only use an established bridge. An uncertain acknowledgment never falls back to CLI.
    const bridge = this.bridges.get(device.id);
    if (this.options.bridge?.input !== false && bridge?.connected) {
      if (action.kind !== 'pointer' || action.phase === 'down') await this.inputDisplay(device);
      if (await bridge.execute(action)) return;
    }
    if (action.kind === 'pointer')
      throw new PhoneError('UNSUPPORTED', 'No native pointer channel is available.');
    let args: string[];
    switch (action.kind) {
      case 'tap':
        args = ['uitest', 'uiInput', 'click', String(action.x), String(action.y)];
        break;
      case 'swipe': {
        const velocity = Math.round(
          Math.max(
            200,
            Math.min(
              40000,
              (Math.hypot(action.toX - action.x, action.toY - action.y) * 1000) / action.durationMs,
            ),
          ),
        );
        args = [
          'uitest',
          'uiInput',
          'swipe',
          String(action.x),
          String(action.y),
          String(action.toX),
          String(action.toY),
          String(velocity),
        ];
        break;
      }
      case 'text': {
        const mode = this.inputModes.get(device.id);
        if (mode === 'text') args = ['uitest', 'uiInput', 'text', action.text];
        else if (mode === 'inputText' && action.target)
          args = [
            'uitest',
            'uiInput',
            'inputText',
            String(action.target.x),
            String(action.target.y),
            action.text,
          ];
        else
          throw new PhoneError(
            'UNSUPPORTED',
            'Text input requires a supported UITest command and a verified focused field.',
          );
        break;
      }
      case 'key': {
        const key = ({ home: 'Home', back: 'Back', enter: '2054' } as Record<string, string>)[
          action.key
        ];
        if (!key) throw new PhoneError('UNSUPPORTED', 'Unsupported HarmonyOS key.');
        args = ['uitest', 'uiInput', 'keyEvent', key];
        break;
      }
      case 'launch':
        if (!action.ability)
          throw new PhoneError(
            'INVALID_ARGUMENT',
            'HarmonyOS launch requires an explicit ability, for example EntryAbility.',
          );
        args = ['aa', 'start', '-b', action.appId, '-a', action.ability];
        break;
      case 'fold': {
        if (!(await this.inspect(device)).capabilities.foldControl)
          throw new PhoneError(
            'UNSUPPORTED',
            'Fold simulation needs an opted-in emulator with DMS debug support. Change posture in Device Manager or on the real device.',
          );
        args = [
          'hidumper',
          '-s',
          'DisplayManagerService',
          '-a',
          { folded: '-p', expanded: '-y', 'half-folded': '-z' }[action.posture],
        ];
        break;
      }
    }
    const result = await this.channel(device).shell(args);
    if (isUITestFailure(result))
      throw new PhoneError(
        'ACTION_FAILED',
        'Device reported an action failure. Observe before continuing.',
        true,
      );
  }
}
