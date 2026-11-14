import { randomUUID } from 'node:crypto';
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
import { parseAndroidTree } from './parsers.js';
import { LatestVideo, VideoPreview } from '../transport/video.js';
import { scrcpyVideo, scrcpyEncoded } from '../transport/process-video.js';
import { EncodedVideo, VideoChoice } from '../transport/encoded-video.js';
import { scrcpyAction } from '../transport/scrcpy-control.js';
import type { Socket } from 'node:net';
import { AndroidEmulator, type AndroidEmulatorOptions } from '../transport/android-emulator.js';

interface InputChannel {
  width: number;
  height: number;
  geometry: () => { width: number; height: number } | undefined;
  send: (action: DriverAction) => Promise<boolean>;
}

// Our scrcpy streams mirror the whole default display, without crop or orientation
// transforms. Encoders may downscale and round their output to codec alignment.
function matchesScrcpyDisplay(size: { width: number; height: number }, display: Display) {
  return (
    [size.width, size.height, display.inputWidth, display.inputHeight].every(
      (n) => Number.isInteger(n) && n > 1 && n <= 65535,
    ) &&
    display.rotation !== null &&
    Math.abs((size.width * display.inputHeight) / (size.height * display.inputWidth) - 1) < 0.015
  );
}

function scrcpyCoordinates(
  action: DriverAction,
  display: Display,
  size: { width: number; height: number },
): DriverAction {
  if (action.kind !== 'tap' && action.kind !== 'swipe' && action.kind !== 'pointer') return action;
  // scrcpy expects coordinates in its encoded video, then maps them to the device.
  const x = (value: number) => (value * size.width) / display.inputWidth;
  const y = (value: number) => (value * size.height) / display.inputHeight;
  return {
    ...action,
    x: x(action.x),
    y: y(action.y),
    ...(action.kind === 'swipe' ? { toX: x(action.toX), toY: y(action.toY) } : {}),
  };
}

export class AndroidAdapter implements DeviceAdapter {
  readonly platform = 'android' as const;
  private readonly previews = new Map<string, VideoPreview>();
  private readonly encoded = new Map<string, EncodedVideo>();
  private readonly nativeControls = new Map<string, Socket>();
  private readonly previewControls = new Map<string, Socket>();
  private readonly previewGeometry = new Map<string, { width: number; height: number }>();
  private readonly nativeGeometry = new Map<string, { width: number; height: number }>();
  private readonly simulators = new Map<string, AndroidEmulator>();
  private readonly simulatorVideo = new Map<string, EncodedVideo>();
  private readonly videoChoices = new Map<string, VideoChoice>();
  private readonly inputGeometry = new Map<string, { display: Display; at: number }>();
  private readonly pointerChannels = new Map<string, InputChannel>();
  constructor(
    private readonly binary = 'adb',
    private readonly runner: Runner = new ProcessRunner(),
    private readonly video?: { scrcpy: string; ffmpeg: string },
    private readonly emulator?: AndroidEmulatorOptions,
  ) {}
  private channel(device?: Device) {
    return new DeviceShell(this.runner, this.binary, device ? ['-s', device.id.slice(8)] : []);
  }
  async discover(): Promise<Device[]> {
    const text = (await this.channel().run(['devices', '-l'], 6000)).toString();
    return text.split(/\r?\n/).flatMap((line) => {
      const m = line.match(/^(\S+)\s+device\s*(.*)$/);
      if (!m) return [];
      return [
        {
          id: `android:${m[1]!}`,
          platform: this.platform,
          name: m[2]?.match(/model:(\S+)/)?.[1] ?? m[1]!,
          transport: m[1]!.startsWith('emulator-') ? 'adb-emulator' : 'adb',
        },
      ];
    });
  }
  async inspect(device: Device): Promise<DeviceInfo> {
    if (
      this.emulator &&
      /^android:emulator-\d+$/.test(device.id) &&
      !this.simulators.has(device.id)
    ) {
      const simulator = new AndroidEmulator(device.id.slice(8), this.emulator);
      this.simulators.set(device.id, simulator);
      this.simulatorVideo.set(device.id, new EncodedVideo(simulator.video));
    }
    const version = await this.channel(device).shell(['getprop', 'ro.build.version.release']);
    const model = await this.channel(device)
      .shell(['getprop', 'ro.product.model'])
      .catch(() => '');
    const avd = /^android:emulator-\d+$/.test(device.id)
      ? (
          await this.channel(device)
            .run(['emu', 'avd', 'name'], 3000)
            .catch(() => Buffer.alloc(0))
        )
          .toString()
          .split(/\r?\n/)
          .find((line) => line !== 'OK' && /^[\w .()-]{1,120}$/.test(line))
      : undefined;
    if (this.video && !this.previews.has(device.id))
      this.previews.set(
        device.id,
        new VideoPreview(
          new LatestVideo(
            scrcpyVideo(
              this.video.scrcpy,
              this.binary,
              this.video.ffmpeg,
              device.id.slice(8),
              (socket) => {
                this.previewControls.set(device.id, socket);
                this.previewGeometry.delete(device.id);
                socket.once('close', () => {
                  if (this.previewControls.get(device.id) === socket) {
                    this.previewControls.delete(device.id);
                    this.previewGeometry.delete(device.id);
                  }
                });
              },
            ),
          ),
          'scrcpy',
        ),
      );
    return {
      ...device,
      version,
      ...(model ? { model } : {}),
      ...(avd ? { avd } : {}),
      capabilities: {
        screenshot: true,
        tree: true,
        tap: true,
        swipe: true,
        text: 'ascii',
        keys: ['home', 'back', 'enter'],
        launch: true,
        displayState: false,
        foldControl: false,
        stream: this.simulators.has(device.id)
          ? 'android-emulator'
          : this.video
            ? 'scrcpy'
            : 'snapshots',
      },
    };
  }
  async capture(device: Device): Promise<Frame> {
    const before = await this.inputDisplay(device).catch(() => undefined);
    const bytes = await this.channel(device).run(['exec-out', 'screencap', '-p']);
    const size = pngSize(bytes);
    const after = await this.inputDisplay(device).catch(() => undefined);
    if (before && after && JSON.stringify(before) !== JSON.stringify(after))
      throw new PhoneError('DISPLAY_CHANGED', 'Android viewport changed during capture.');
    const frame: Frame = {
      bytes,
      mimeType: 'image/png',
      display: {
        id: 'default',
        ...size,
        inputWidth: size.width,
        inputHeight: size.height,
        rotation: after?.rotation ?? null,
        posture: 'unknown',
      },
    };
    this.previews.get(device.id)?.remember(frame.display);
    return frame;
  }
  async inputDisplay(device: Device): Promise<Display | undefined> {
    const input = await this.channel(device).shell(['dumpsys', 'input']);
    const viewport = input
      .split('\n')
      .find((line) => /Viewport.*displayId=0\b/.test(line) && /isActive=\[1\]/.test(line));
    const bounds = viewport?.match(/logicalFrame=\[0,\s*0,\s*(\d+),\s*(\d+)\]/);
    const rotation = viewport?.match(/orientation=(\d)/)?.[1];
    if (!bounds || !rotation || Number(bounds[1]) <= 0 || Number(bounds[2]) <= 0) {
      this.inputGeometry.delete(device.id);
      return;
    }
    const display: Display = {
      id: 'default',
      width: Number(bounds[1]),
      height: Number(bounds[2]),
      inputWidth: Number(bounds[1]),
      inputHeight: Number(bounds[2]),
      rotation: Number(rotation) * 90,
      posture: 'unknown',
    };
    this.inputGeometry.set(device.id, { display, at: Date.now() });
    return display;
  }
  async preview(device: Device) {
    const frame = await this.previews.get(device.id)?.frame(
      () => this.capture(device),
      () => this.inputDisplay(device),
    );
    if (frame?.transport === 'scrcpy') this.previewGeometry.set(device.id, frame.display);
    return frame;
  }
  stopPreview(device: Device) {
    this.previews.get(device.id)?.stop();
    this.encoded.get(device.id)?.stop();
    this.simulatorVideo.get(device.id)?.stop();
  }
  encodedVideo(device: Device, after: number) {
    let stream = this.encoded.get(device.id);
    if (!stream && this.video)
      this.encoded.set(
        device.id,
        (stream = new EncodedVideo(
          scrcpyEncoded(this.video.scrcpy, this.binary, device.id.slice(8), (socket) => {
            this.nativeControls.set(device.id, socket);
            this.nativeGeometry.delete(device.id);
            socket.once('close', () => {
              if (this.nativeControls.get(device.id) === socket) {
                this.nativeControls.delete(device.id);
                this.nativeGeometry.delete(device.id);
              }
            });
          }),
        )),
      );
    let choice = this.videoChoices.get(device.id);
    if (!choice) this.videoChoices.set(device.id, (choice = new VideoChoice()));
    // Guest-forced rotation may disagree with the emulator's sensor-based framebuffer.
    // Use the verified device-side path for rotated displays until that mapping is supported.
    const native =
      (this.inputGeometry.get(device.id)?.display.rotation ?? 0) === 0
        ? this.simulatorVideo.get(device.id)
        : undefined;
    const batch = choice.read(
      [
        ...(native ? [{ name: 'android-emulator' as const, video: native }] : []),
        ...(stream ? [{ name: 'scrcpy' as const, video: stream }] : []),
      ],
      after,
    );
    if (batch?.source === 'scrcpy')
      this.nativeGeometry.set(device.id, { width: batch.width, height: batch.height });
    return batch;
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
  async close(device: Device) {
    this.pointerChannels.delete(device.id);
    this.stopPreview(device);
    this.previews.delete(device.id);
    this.encoded.delete(device.id);
    this.nativeGeometry.delete(device.id);
    this.previewGeometry.delete(device.id);
    this.simulators.get(device.id)?.close();
    this.simulators.delete(device.id);
    this.simulatorVideo.delete(device.id);
    this.videoChoices.delete(device.id);
    this.inputGeometry.delete(device.id);
  }
  async tree(device: Device) {
    const path = `/data/local/tmp/phone-use-${randomUUID()}.xml`,
      shell = this.channel(device);
    try {
      await shell.shell(['uiautomator', 'dump', path]);
      return parseAndroidTree(await shell.shell(['cat', path]));
    } finally {
      await shell.shell(['rm', '-f', path], 3000).catch(() => {});
    }
  }
  pointerReady(device: Device) {
    return (
      this.pointerChannels.has(device.id) ||
      !!this.inputChannel(device, this.inputGeometry.get(device.id)?.display)
    );
  }
  private async currentInputDisplay(device: Device) {
    const cached = this.inputGeometry.get(device.id);
    return cached && Date.now() - cached.at <= 100 ? cached.display : this.inputDisplay(device);
  }
  /** Readiness and execution use the same geometry and live-connection checks. */
  private inputChannel(device: Device, display: Display | undefined): InputChannel | undefined {
    if (!display) return;
    const simulator = this.simulators.get(device.id),
      image = simulator?.imageGeometry;
    if (
      simulator?.pointerReady &&
      display.rotation === 0 &&
      image?.rotation === 0 &&
      image.width === display.inputWidth &&
      image.height === display.inputHeight
    ) {
      return {
        width: image.width,
        height: image.height,
        geometry: () =>
          simulator.imageGeometry?.rotation === 0 ? simulator.imageGeometry : undefined,
        send: (event) => simulator.execute(event),
      };
    }
    for (const [controls, sizes] of [
      [this.nativeControls, this.nativeGeometry],
      [this.previewControls, this.previewGeometry],
    ] as const) {
      const socket = controls.get(device.id),
        size = sizes.get(device.id);
      if (!socket?.writable || socket.destroyed || !size || !matchesScrcpyDisplay(size, display))
        continue;
      // A replacement socket cannot donate its geometry to an already-held finger.
      const geometry = () =>
        controls.get(device.id) === socket ? sizes.get(device.id) : undefined;
      return {
        ...size,
        geometry,
        send: (event) => {
          const current = geometry() ?? size;
          return scrcpyAction(
            socket,
            scrcpyCoordinates(event, display, current),
            current.width,
            current.height,
          );
        },
      };
    }
  }
  private async pointer(device: Device, action: Extract<DriverAction, { kind: 'pointer' }>) {
    let channel = this.pointerChannels.get(device.id);
    if (action.phase === 'down') {
      if (channel) throw new PhoneError('DEVICE_BUSY', 'A native finger is already active.');
      channel = this.inputChannel(device, await this.currentInputDisplay(device));
      if (!channel)
        throw new PhoneError(
          'UNSUPPORTED',
          'Native touch is not ready for the current display. No touch was submitted. Refresh the preview and start a new gesture.',
        );
      this.pointerChannels.set(device.id, channel);
    }
    if (!channel) {
      if (action.phase === 'cancel') return;
      throw new PhoneError('STALE_POINTER', 'Start a new native gesture.');
    }
    try {
      const current = channel.geometry();
      if (
        action.phase === 'move' &&
        (!current || current.width !== channel.width || current.height !== channel.height)
      )
        throw new PhoneError('DISPLAY_CHANGED', 'Display changed during native input.');
      // A held finger must stay on its original backend/socket. Up/cancel still
      // release it after a resize; never reroute a partial gesture to ADB.
      if (!(await channel.send(action)))
        throw new PhoneError(
          'ACTION_UNCERTAIN',
          'The active native input channel ended. Inspect before continuing.',
          true,
        );
    } finally {
      if (action.phase === 'up' || action.phase === 'cancel')
        this.pointerChannels.delete(device.id);
    }
  }
  async execute(device: Device, action: DriverAction): Promise<void> {
    if (action.kind === 'pointer') return this.pointer(device, action);
    const simulator = this.simulators.get(device.id);
    const pointer = action.kind === 'tap' || action.kind === 'swipe';
    if (pointer) {
      const channel = this.inputChannel(device, await this.currentInputDisplay(device));
      if (channel && (await channel.send(action))) return;
    } else {
      if (simulator && (await simulator.execute(action))) return;
      for (const controls of [this.nativeControls, this.previewControls]) {
        const socket = controls.get(device.id);
        if (socket && (await scrcpyAction(socket, action, 0, 0))) return;
      }
    }
    let args: string[];
    switch (action.kind) {
      case 'tap':
        args = ['input', 'tap', String(action.x), String(action.y)];
        break;
      case 'swipe':
        args = [
          'input',
          'swipe',
          String(action.x),
          String(action.y),
          String(action.toX),
          String(action.toY),
          String(action.durationMs),
        ];
        break;
      case 'text':
        if (!/^[\x20-\x7e]+$/.test(action.text) || action.text.includes('%s'))
          throw new PhoneError(
            'UNSUPPORTED',
            'ADB text supports printable ASCII only; literal %s is ambiguous. Use an IME adapter for Unicode.',
          );
        args = ['input', 'text', action.text.replaceAll(' ', '%s')];
        break;
      case 'key': {
        const key = ({ home: '3', back: '4', enter: '66' } as Record<string, string>)[action.key];
        if (!key) throw new PhoneError('UNSUPPORTED', 'Unsupported Android key.');
        args = ['input', 'keyevent', key];
        break;
      }
      case 'launch':
        if (!action.ability)
          throw new PhoneError('INVALID_ARGUMENT', 'Android launch requires an activity name.');
        args = ['am', 'start', '-n', `${action.appId}/${action.ability}`];
        break;
      case 'fold':
        throw new PhoneError('UNSUPPORTED', 'Android fold simulation is not implemented.');
    }
    const text = await this.channel(device).shell(args);
    if (/^(?:Error|Exception)/m.test(text))
      throw new PhoneError('ACTION_FAILED', 'Android reported an action failure.', true);
  }
}
