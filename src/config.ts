import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { HarmonyAdapter } from './adapters/harmony.js';
import { AndroidAdapter } from './adapters/android.js';
import { IOSAdapter } from './adapters/ios.js';
import { DemoAdapter } from './adapters/demo.js';
import { PhoneService } from './core/service.js';
import type { DeviceAdapter } from './core/types.js';
import { PhoneError } from './core/errors.js';
import { DeviceSkins } from './core/appearance.js';
import { PortableOcr } from './adapters/ocr-portable.js';
import type { OcrProvider } from './core/ocr.js';
import type { TargetResolver } from './core/targets.js';

export const configSchema = z
  .object({
    harmony: z
      .object({
        enabled: z.boolean().default(true),
        binary: z.string().default('hdc'),
        server: z.string().optional(),
        allowEmulatorFold: z.boolean().default(false),
        bridge: z
          .object({
            enabled: z.boolean().default(true),
            scale: z.number().min(0.25).max(1).default(1),
            input: z.boolean().default(true),
          })
          .strict()
          .optional(),
        video: z
          .object({
            ffmpeg: z.string().default('ffmpeg'),
            devices: z
              .array(
                z
                  .object({
                    deviceId: z.string().startsWith('harmonyos:'),
                    url: z.string().url(),
                    token: z.string().min(32).max(128),
                    allowRemote: z.boolean().default(false),
                  })
                  .strict(),
              )
              .max(8),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ enabled: true, binary: 'hdc', allowEmulatorFold: false }),
    android: z
      .object({
        enabled: z.boolean().default(true),
        binary: z.string().default('adb'),
        video: z
          .object({ scrcpy: z.string().default('bundled'), ffmpeg: z.string().default('ffmpeg') })
          .strict()
          .optional(),
        emulator: z
          .object({
            sdkRoot: z.string().min(1),
            discoveryDirectory: z.string().min(1).optional(),
            ffmpeg: z.string().default('ffmpeg'),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({ enabled: true, binary: 'adb' }),
    ios: z
      .array(
        z
          .object({
            name: z.string().regex(/^[\w-]+$/),
            url: z.string().url(),
            model: z.string().max(120).optional(),
            mjpegUrl: z.string().url().optional(),
            allowRemote: z.boolean().default(false),
            simulator: z
              .object({
                udid: z.string().uuid(),
                simVideo: z.string().min(1),
                deviceSetPath: z
                  .string()
                  .default(join(homedir(), 'Library/Developer/CoreSimulator/Devices')),
                companion: z.string().min(1).optional(),
                inputBridge: z.string().min(1).optional(),
                nativeInput: z.boolean().default(false),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .default([]),
    stateDirectory: z.string().optional(),
    skinsDirectory: z.string().optional(),
    ocr: z
      .object({
        enabled: z.boolean().default(true),
        timeoutMs: z.number().int().min(250).max(10000).default(2500),
        workers: z.number().int().min(1).max(3).default(3),
        languages: z
          .array(z.enum(['chi_sim', 'eng', 'zh-Hans', 'en-US', 'en']))
          .min(1)
          .max(2)
          .default(['chi_sim', 'eng']),
      })
      .strict()
      .optional(),
    preview: z
      .object({
        tls: z.object({ certificate: z.string().min(1), key: z.string().min(1) }).strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
export async function createService(
  demo = false,
  configPath = process.env.PHONE_USE_CONFIG,
  extensions: { ocr?: OcrProvider | false; resolver?: TargetResolver } = {},
) {
  let raw: unknown = {};
  if (configPath) {
    try {
      raw = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      throw new PhoneError('CONFIG_ERROR', 'Cannot read PHONE_USE_CONFIG as JSON.');
    }
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success)
    throw new PhoneError(
      'CONFIG_ERROR',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  const config = parsed.data,
    adapters: DeviceAdapter[] = [];
  if (demo) adapters.push(new DemoAdapter());
  else {
    if (config.harmony.enabled)
      adapters.push(
        new HarmonyAdapter({
          binary: process.env.PHONE_USE_HDC ?? config.harmony.binary,
          ...(config.harmony.server ? { server: config.harmony.server } : {}),
          allowEmulatorFold: config.harmony.allowEmulatorFold,
          bridge: config.harmony.bridge,
          ...(config.harmony.video
            ? {
                video: {
                  ...config.harmony.video,
                  ffmpeg: process.env.PHONE_USE_FFMPEG ?? config.harmony.video.ffmpeg,
                },
              }
            : {}),
        }),
      );
    if (config.android.enabled)
      adapters.push(
        new AndroidAdapter(
          process.env.PHONE_USE_ADB ?? config.android.binary,
          undefined,
          config.android.video
            ? {
                scrcpy: process.env.PHONE_USE_SCRCPY ?? config.android.video.scrcpy,
                ffmpeg: process.env.PHONE_USE_FFMPEG ?? config.android.video.ffmpeg,
              }
            : { scrcpy: 'bundled', ffmpeg: process.env.PHONE_USE_FFMPEG ?? 'ffmpeg' },
          config.android.emulator
            ? {
                ...config.android.emulator,
                ffmpeg: process.env.PHONE_USE_FFMPEG ?? config.android.emulator.ffmpeg,
              }
            : undefined,
        ),
      );
    if (config.ios.length) adapters.push(new IOSAdapter(config.ios));
  }
  const directory =
    process.env.PHONE_USE_STATE_DIR ??
    config.stateDirectory ??
    join(homedir(), '.local', 'state', 'phone-use');
  return new PhoneService(
    adapters,
    join(directory, 'locks'),
    undefined,
    undefined,
    new DeviceSkins(config.skinsDirectory, { androidSdk: config.android.emulator?.sdkRoot }),
    config.preview,
    {
      ocr:
        extensions.ocr === false
          ? undefined
          : (extensions.ocr ??
            (config.ocr?.enabled !== false
              ? new PortableOcr(config.ocr?.languages, config.ocr?.workers)
              : undefined)),
      ocrTimeoutMs: config.ocr?.timeoutMs,
      resolver: extensions.resolver,
    },
  );
}
