import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { DeviceSkins } from '../src/core/appearance.js';
import type { Device, Display } from '../src/core/types.js';

test('Android generic guest uses its exact AVD skin and never borrows a physical model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-avd-skin-'));
  try {
    const sdk = join(dir, 'sdk'),
      avds = join(dir, 'avds'),
      skin = join(sdk, 'skins/pixel_test');
    await mkdir(skin, { recursive: true });
    for (const avd of ['Pixel_Test', 'Generic_Test'])
      await mkdir(join(avds, `${avd}.avd`), { recursive: true });
    await writeFile(
      join(avds, 'Pixel_Test.avd/config.ini'),
      `skin.name=pixel_test\nskin.path=${skin}\n`,
    );
    await writeFile(
      join(avds, 'Generic_Test.avd/config.ini'),
      'hw.device.name=medium_phone\nskin.dynamic=yes\n',
    );
    await writeFile(
      join(skin, 'layout'),
      'parts { device { display { width 100 height 200 x 0 y 0 } } } layouts { portrait { width 120 height 240 part1 { name device x 10 y 20 } } }',
    );
    for (const file of ['back.webp', 'mask.webp'])
      await writeFile(
        join(skin, file),
        await sharp({ create: { width: 120, height: 240, channels: 4, background: '#000' } })
          .webp()
          .toBuffer(),
      );
    const skins = new DeviceSkins(undefined, { androidSdk: sdk, avdDirectory: avds });
    const device: Device = {
      id: 'android:emulator-5554',
      platform: 'android',
      model: 'sdk_gphone64_arm64',
      avd: 'Pixel_Test',
      name: 'test',
      transport: 'adb-emulator',
    };
    const display: Display = {
      id: 'default',
      width: 100,
      height: 200,
      inputWidth: 100,
      inputHeight: 200,
      rotation: 0,
      posture: 'unknown',
    };
    const result = await skins.appearance(device, display);
    assert.equal(result.kind, 'native');
    assert.match(result.source!, /pixel_test.*AVD 配置/);
    assert.deepEqual(result.screen, { x: 10, y: 20, width: 100, height: 200 });
    const generic = await skins.appearance({ ...device, avd: 'Generic_Test' }, display);
    assert.equal(generic.kind, 'generic');
    assert.match(generic.reason!, /通用 AVD 不代表真机型号/);
    assert.equal((await skins.appearance(device, { ...display, inputWidth: 150 })).kind, 'generic');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('model skins honor exact model/posture, rotate the touch viewport and reject incompatible displays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-skin-test-'));
  try {
    await writeFile(
      join(dir, 'skin.png'),
      await sharp({ create: { width: 120, height: 240, channels: 4, background: '#000' } })
        .png()
        .toBuffer(),
    );
    await writeFile(
      join(dir, 'skins.json'),
      JSON.stringify([
        {
          platform: 'harmonyos',
          model: 'Test Fold',
          posture: 'folded',
          image: 'skin.png',
          width: 120,
          height: 240,
          screen: { x: 10, y: 20, width: 100, height: 200 },
          source: 'Test fixture',
        },
      ]),
    );
    const skins = new DeviceSkins(dir),
      device: Device = {
        id: 'harmonyos:skin',
        name: 'Test',
        model: 'Test Fold',
        platform: 'harmonyos',
        transport: 'test',
      };
    const display: Display = {
      id: 'default',
      width: 100,
      height: 200,
      inputWidth: 100,
      inputHeight: 200,
      rotation: 0,
      posture: 'folded',
    };
    const portrait = await skins.appearance(device, display);
    assert.equal(portrait.kind, 'native');
    assert.deepEqual(portrait.screen, { x: 10, y: 20, width: 100, height: 200 });
    const landscape = await skins.appearance(device, {
      ...display,
      width: 200,
      height: 100,
      inputWidth: 200,
      inputHeight: 100,
      rotation: 90,
    });
    assert.equal(landscape.kind, 'native');
    assert.deepEqual(landscape.screen, { x: 20, y: 10, width: 200, height: 100 });
    assert.equal(
      (await skins.appearance(device, { ...display, posture: 'expanded' })).kind,
      'generic',
    );
    assert.equal(
      (await skins.appearance({ ...device, model: 'Other Fold' }, display)).kind,
      'generic',
    );
    assert.equal((await skins.appearance(device, { ...display, inputWidth: 200 })).kind, 'generic');
    assert.equal(
      (await skins.appearance({ ...device, model: undefined }, display)).kind,
      'generic',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('foldable AVD selects actual inner/outer artwork by viewport even when posture is unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-use-fold-skin-'));
  try {
    const sdk = join(dir, 'sdk'),
      avds = join(dir, 'avds'),
      skin = join(sdk, 'skins/pixel_test_fold');
    await mkdir(join(avds, 'Fold_Test.avd'), { recursive: true });
    await writeFile(
      join(avds, 'Fold_Test.avd/config.ini'),
      `skin.name=pixel_test_fold\nskin.path=${skin}\n`,
    );
    for (const [folder, width, height] of [
      ['default', 200, 210],
      ['closed', 100, 220],
    ] as const) {
      const path = join(skin, folder);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, 'layout'),
        `parts { device { display { width ${width} height ${height} x 0 y 0 } } } layouts { portrait { width ${width + 20} height ${height + 20} part1 { name device x 10 y 10 } } }`,
      );
      for (const file of ['back.webp', 'mask.webp'])
        await writeFile(
          join(path, file),
          await sharp({
            create: { width: width + 20, height: height + 20, channels: 4, background: '#000' },
          })
            .webp()
            .toBuffer(),
        );
    }
    const skins = new DeviceSkins(undefined, { androidSdk: sdk, avdDirectory: avds });
    const device: Device = {
      id: 'android:emulator-5554',
      platform: 'android',
      model: 'sdk_gphone64_arm64',
      avd: 'Fold_Test',
      name: 'fold',
      transport: 'adb-emulator',
    };
    const display: Display = {
      id: 'default',
      width: 100,
      height: 220,
      inputWidth: 100,
      inputHeight: 220,
      rotation: 0,
      posture: 'unknown',
    };
    const outer = await skins.appearance(device, display);
    assert.equal(outer.kind, 'native');
    assert.deepEqual(outer.screen, { x: 10, y: 10, width: 100, height: 220 });
    const inner = await skins.appearance(device, {
      ...display,
      width: 200,
      height: 210,
      inputWidth: 200,
      inputHeight: 210,
    });
    assert.equal(inner.kind, 'native');
    assert.deepEqual(inner.screen, { x: 10, y: 10, width: 200, height: 210 });
    const rotated = await skins.appearance(device, {
      ...display,
      width: 210,
      height: 200,
      inputWidth: 210,
      inputHeight: 200,
      rotation: 90,
    });
    assert.equal(rotated.kind, 'native');
    assert.deepEqual(rotated.screen, { x: 10, y: 10, width: 210, height: 200 });
    assert.equal((await skins.appearance(device, { ...display, inputWidth: 150 })).kind, 'generic');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
