import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { Device, Display } from './types.js';

const exec = promisify(execFile);
const rect = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();
const skinSchema = z
  .object({
    platform: z.enum(['ios', 'android', 'harmonyos']),
    model: z.string(),
    posture: z.enum(['folded', 'half-folded', 'expanded', 'unknown']).optional(),
    image: z.string(),
    mask: z.string().optional(),
    overlay: z.string().optional(),
    width: z.number().int().min(100).max(6000),
    height: z.number().int().min(100).max(6000),
    screen: rect,
    source: z.string().max(200),
  })
  .strict();
interface NativeSkin {
  width: number;
  height: number;
  screen: { x: number; y: number; width: number; height: number };
  image: Buffer;
  mask?: Buffer;
  overlay?: Buffer;
  source: string;
}
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
/** Native SDK artwork stays on the user's computer; it is never bundled in releases. */
export class DeviceSkins {
  private readonly cache = new Map<string, Promise<NativeSkin | undefined>>();
  constructor(
    private readonly directory?: string,
    private readonly local: { androidSdk?: string; avdDirectory?: string } = {},
  ) {}
  async appearance(device: Device, display: Display) {
    if (!device.model && !device.avd)
      return { kind: 'generic' as const, reason: '设备未提供可验证型号；显示中性边框' };
    const key = `${device.platform}:${device.model}:${device.avd}:${display.posture}:${Math.min(display.inputWidth, display.inputHeight)}:${Math.max(display.inputWidth, display.inputHeight)}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.load(device, display).catch(() => undefined);
      this.cache.set(key, pending);
    }
    const skin = await pending;
    if (!skin)
      return {
        kind: 'generic' as const,
        reason: device.avd
          ? `${device.avd} 未配置可匹配的模拟器外框；通用 AVD 不代表真机型号`
          : `本地没有 ${device.model} 的匹配素材；显示中性边框`,
      };
    const screen = { ...skin.screen };
    const angle = display.rotation ?? (display.inputWidth > display.inputHeight ? 90 : 0);
    let width = skin.width,
      height = skin.height;
    const swap = angle === 90 || angle === 270;
    if (angle === 90)
      Object.assign(screen, {
        x: height - screen.y - screen.height,
        y: skin.screen.x,
        width: skin.screen.height,
        height: skin.screen.width,
      });
    if (angle === 180)
      Object.assign(screen, {
        x: width - screen.x - screen.width,
        y: height - screen.y - screen.height,
      });
    if (angle === 270)
      Object.assign(screen, {
        x: skin.screen.y,
        y: width - skin.screen.x - skin.screen.width,
        width: skin.screen.height,
        height: skin.screen.width,
      });
    if (swap) [width, height] = [height, width];
    if (Math.abs(screen.width / screen.height - display.inputWidth / display.inputHeight) > 0.015)
      return { kind: 'generic' as const, reason: '当前屏幕比例与已安装外框不匹配' };
    const rotate = async (bytes: Buffer) =>
      dataUrl(await sharp(bytes).rotate(angle).png().toBuffer());
    return {
      kind: 'native' as const,
      model: device.model,
      source: skin.source,
      width,
      height,
      screen,
      image: await rotate(skin.image),
      ...(skin.mask ? { mask: await rotate(skin.mask) } : {}),
      ...(skin.overlay ? { overlay: await rotate(skin.overlay) } : {}),
    };
  }
  private async png(path: string) {
    if ((await stat(path)).size > 20 * 1024 * 1024) throw new Error('Skin asset too large');
    return sharp(await readFile(path), { limitInputPixels: 40_000_000 })
      .png()
      .toBuffer();
  }
  private async load(device: Device, display: Display): Promise<NativeSkin | undefined> {
    if (this.directory) {
      const manifest = z
        .array(skinSchema)
        .max(128)
        .parse(JSON.parse(await readFile(join(this.directory, 'skins.json'), 'utf8')));
      const candidates = manifest.filter(
        (item) =>
          item.platform === device.platform &&
          item.model === device.model &&
          (!item.posture || item.posture === display.posture),
      );
      const entry =
        candidates.find((item) => item.posture === display.posture) ??
        candidates.find((item) => !item.posture);
      if (entry) {
        const read = (file: string) => {
          const path = resolve(this.directory!, file);
          if (relative(resolve(this.directory!), path).startsWith('..'))
            throw new Error('Invalid skin path');
          return this.png(path);
        };
        if (
          entry.screen.x + entry.screen.width > entry.width ||
          entry.screen.y + entry.screen.height > entry.height
        )
          throw new Error('Invalid skin viewport');
        return {
          ...entry,
          image: await read(entry.image),
          mask: entry.mask ? await read(entry.mask) : undefined,
          overlay: entry.overlay ? await read(entry.overlay) : undefined,
        };
      }
    }
    if (device.platform === 'android') return this.android(device, display);
    if (!/^[\w .()+-]{1,100}$/.test(device.model!)) return;
    if (device.platform === 'ios' && process.platform === 'darwin')
      return this.apple(device, display);
  }
  private async apple(device: Device, display: Display): Promise<NativeSkin> {
    const resources = join(
      '/Library/Developer/CoreSimulator/Profiles/DeviceTypes',
      `${device.model}.simdevicetype`,
      'Contents/Resources',
    );
    const { stdout } = await exec('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(resources, 'profile.plist'),
    ]);
    const profile = JSON.parse(stdout);
    const chromeName = String(profile.chromeIdentifier).split('.').at(-1)!;
    if (!/^[\w-]+$/.test(chromeName)) throw new Error('Invalid native chrome');
    const chromeDir = join(
      '/Library/Developer/DeviceKit/Chrome',
      `${chromeName}.devicechrome/Contents/Resources`,
    );
    const chrome = JSON.parse(await readFile(join(chromeDir, 'chrome.json'), 'utf8'));
    const dir = await mkdtemp(join(tmpdir(), 'phone-use-skin-'));
    try {
      let n = 0;
      const pdf = async (folder: string, name: string): Promise<Buffer> => {
        if (!/^[\w .-]+$/.test(name)) throw new Error('Invalid native asset');
        const destination = join(dir, `${n++}.png`);
        await exec(
          '/usr/bin/sips',
          ['-s', 'format', 'png', join(folder, `${name}.pdf`), '--out', destination],
          { timeout: 5000 },
        );
        return this.png(destination);
      };
      const mask = await pdf(resources, profile.framebufferMask);
      const maskInfo = await sharp(mask).metadata();
      const inputWidth = Math.min(display.inputWidth, display.inputHeight),
        inputHeight = Math.max(display.inputWidth, display.inputHeight);
      if (Math.abs(maskInfo.width! / maskInfo.height! - inputWidth / inputHeight) > 0.005)
        throw new Error('Model geometry mismatch');
      // Native chrome uses logical points; WDA's viewport is already in points.
      const sizing = chrome.images.sizing;
      const width = inputWidth + sizing.leftWidth + sizing.rightWidth;
      const height = inputHeight + sizing.topHeight + sizing.bottomHeight;
      // The SDK composite has the native corner/edge joins already aligned.
      const image = await sharp(await pdf(chromeDir, chrome.images.composite))
        .resize(width, height, { fit: 'fill' })
        .png()
        .toBuffer();
      const sensor = profile.sensorBarImage
        ? await pdf(resources, profile.sensorBarImage)
        : undefined;
      const overlay = sensor
        ? await sharp({
            create: {
              width: inputWidth,
              height: inputHeight,
              channels: 4,
              background: '#00000000',
            },
          })
            .composite([
              {
                input: await sharp(sensor).resize({ width: inputWidth }).toBuffer(),
                top: 0,
                left: 0,
              },
            ])
            .png()
            .toBuffer()
        : undefined;
      return {
        width,
        height,
        screen: {
          x: sizing.leftWidth,
          y: sizing.topHeight,
          width: inputWidth,
          height: inputHeight,
        },
        image,
        mask,
        overlay,
        source: `Apple Simulator · ${device.model}`,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  private async android(device: Device, display: Display): Promise<NativeSkin | undefined> {
    const sdk =
      this.local.androidSdk ??
      process.env.ANDROID_HOME ??
      process.env.ANDROID_SDK_ROOT ??
      join(homedir(), 'Library/Android/sdk');
    let name = device.model?.toLowerCase().replaceAll(' ', '_'),
      dir: string | undefined;
    let source = `Android SDK · ${device.model}`;
    if (
      device.avd &&
      /^[\w .()-]{1,120}$/.test(device.avd) &&
      /^android:emulator-\d+$/.test(device.id)
    ) {
      const avdRoot =
        this.local.avdDirectory ?? process.env.ANDROID_AVD_HOME ?? join(homedir(), '.android/avd');
      const ini = (text: string) =>
        Object.fromEntries(
          text.split(/\r?\n/).flatMap((line) => {
            const m = line.match(/^([\w.]+)\s*=\s*(.*?)\s*$/);
            return m ? [[m[1], m[2]]] : [];
          }),
        );
      const location = ini(
        await readFile(join(avdRoot, `${device.avd}.ini`), 'utf8').catch(() => ''),
      );
      const config = ini(
        await readFile(
          join(location.path || join(avdRoot, `${device.avd}.avd`), 'config.ini'),
          'utf8',
        ),
      );
      name = config['skin.name'] || config['hw.device.name'];
      dir = config['skin.path'];
      if (!dir && name && /^[\w-]+$/.test(name)) dir = join(sdk, 'skins', name);
      source = `Android Emulator · ${name || device.avd}（AVD 配置）`;
      // Generic AVDs are not a physical Pixel model, even if the guest image
      // reports a generic SDK product name. Only the configured skin is used.
      if (!dir) return;
    } else {
      if (!name || !/^pixel_[\w]+$/.test(name)) return;
      dir = join(sdk, 'skins', name);
    }
    // Newer SDK foldables ship separate inner/outer layouts. Choose by actual
    // viewport, including when Android cannot report a reliable hinge posture.
    for (const assetDir of [dir, join(dir, 'default'), join(dir, 'closed')]) {
      const layout = await readFile(join(assetDir, 'layout'), 'utf8').catch(() => '');
      const screen = layout.match(/display\s*\{\s*width\s+(\d+)\s+height\s+(\d+)/);
      const offset = layout.match(/name device\s+x\s+(\d+)\s+y\s+(\d+)/);
      const canvas = layout.match(
        /layouts\s*\{\s*(?:portrait|landscape)\s*\{\s*width\s+(\d+)\s+height\s+(\d+)/,
      );
      if (!screen || !offset || !canvas) continue;
      const ratio =
        Math.min(display.inputWidth, display.inputHeight) /
        Math.max(display.inputWidth, display.inputHeight);
      if (
        Math.abs(
          Math.min(Number(screen[1]), Number(screen[2])) /
            Math.max(Number(screen[1]), Number(screen[2])) -
            ratio,
        ) > 0.005
      )
        continue;
      const image = await this.png(join(assetDir, 'back.webp'));
      const overlay = await this.png(join(assetDir, 'mask.webp'));
      return {
        width: Number(canvas[1]),
        height: Number(canvas[2]),
        screen: {
          x: Number(offset[1]),
          y: Number(offset[2]),
          width: Number(screen[1]),
          height: Number(screen[2]),
        },
        image,
        overlay,
        source,
      };
    }
  }
}
