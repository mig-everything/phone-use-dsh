export type Platform = 'harmonyos' | 'android' | 'ios' | 'demo';
export type Posture = 'unknown' | 'folded' | 'half-folded' | 'expanded';
export type PreviewTransport =
  | 'wda-mjpeg'
  | 'scrcpy'
  | 'harmony-native'
  | 'harmony-uitest'
  | 'android-emulator'
  | 'ios-simulator';
export interface Device {
  id: string;
  platform: Platform;
  name: string;
  model?: string;
  /** Local Android AVD name, reported by the emulator console; not a physical model. */
  avd?: string;
  transport: string;
}

export interface PanelTransportOptions {
  tls?: { certificate: string; key: string };
}
export interface Capabilities {
  screenshot: boolean;
  tree: boolean;
  tap: boolean;
  swipe: boolean;
  text: 'unicode' | 'ascii' | 'unsupported';
  keys: string[];
  launch: boolean;
  displayState: boolean;
  foldControl: boolean;
  stream: 'snapshots' | PreviewTransport;
}
export interface DeviceInfo extends Device {
  version: string;
  apiLevel?: string;
  capabilities: Capabilities;
}
export interface Display {
  id: string;
  width: number;
  height: number;
  inputWidth: number;
  inputHeight: number;
  rotation: number | null;
  posture: Posture;
}
export interface Frame {
  bytes: Buffer;
  mimeType: 'image/png' | 'image/jpeg';
  capturedAt?: string;
  transport?: PreviewTransport;
  display: Display;
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface UINode {
  id: string;
  parentId?: string;
  text: string;
  description?: string;
  value?: string;
  hint?: string;
  type: string;
  resourceId: string;
  packageName?: string;
  bounds: Bounds;
  enabled: boolean;
  focused: boolean;
  clickable: boolean;
  editable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  selected?: boolean;
  scrollable?: boolean;
  longClickable?: boolean;
  password?: boolean;
  /** Derived from the accessibility tree; never from a model or OCR. */
  semantic?: import('./perception.js').NodeSemantics;
}
export type DriverAction =
  | { kind: 'pointer'; phase: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x: number; y: number; toX: number; toY: number; durationMs: number }
  | { kind: 'text'; text: string; target?: { x: number; y: number } }
  | { kind: 'key'; key: string }
  | { kind: 'launch'; appId: string; ability?: string }
  | { kind: 'fold'; posture: Exclude<Posture, 'unknown'> };

/** Implementations own platform details. Input/tree coordinates are in driver units. */
export interface DeviceAdapter {
  readonly platform: Platform;
  discover(): Promise<Device[]>;
  inspect(device: Device): Promise<DeviceInfo>;
  capture(device: Device): Promise<Frame>;
  /** Read authoritative input geometry without encoding/transferring a screenshot. */
  inputDisplay?(device: Device): Promise<Display | undefined>;
  preview?(device: Device): Promise<Frame | undefined>;
  /** Memory-only video read; must never issue driver commands or capture a screenshot. */
  liveFrame?(device: Device): Promise<Frame | undefined>;
  /** Native encoded video, with bounded dependency-preserving history for direct players. */
  encodedVideo?(
    device: Device,
    after: number,
  ): import('../transport/encoded-video.js').EncodedBatch | undefined;
  stopPreview?(device: Device): void;
  tree(device: Device): Promise<UINode[]>;
  execute(device: Device, action: DriverAction): Promise<void>;
  /** Memory-only readiness; continuous manual input must never silently replay via CLI. */
  pointerReady?(device: Device): boolean;
  /** Edge band, in driver units, whose gestures need the complete-gesture channel. */
  pointerInset?(device: Device): number;
  close?(device: Device): Promise<void>;
}
