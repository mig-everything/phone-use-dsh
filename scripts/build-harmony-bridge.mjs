/** Maintainer-only. End users install these device binaries, never a host compiler. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = process.env.PHONE_USE_NATIVE_SDK;
if (!sdk) throw new Error('Set PHONE_USE_NATIVE_SDK to the HarmonyOS native SDK directory.');
const output = join(root, 'native/harmony-bridge/bin');
await mkdir(output, { recursive: true });
const hashes = {};
for (const arch of ['aarch64', 'x86_64']) {
  const target = join(output, `phone-use-${arch}.so`);
  execFileSync(
    join(sdk, 'llvm/bin/clang++' + (process.platform === 'win32' ? '.exe' : '')),
    [
      `--target=${arch}-linux-ohos`,
      `--sysroot=${join(sdk, 'sysroot')}`,
      '-std=c++17',
      '-shared',
      '-fPIC',
      '-O2',
      '-fvisibility=hidden',
      '-static-libstdc++',
      '-Wl,--strip-all',
      join(root, 'native/harmony-bridge/phone_use.cpp'),
      '-lnative_display_manager',
      '-lohinput',
      '-o',
      target,
    ],
    { stdio: 'inherit' },
  );
  hashes[`phone-use-${arch}.so`] = createHash('sha256')
    .update(await readFile(target))
    .digest('hex');
}
await writeFile(join(output, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
console.log(JSON.stringify(hashes));
