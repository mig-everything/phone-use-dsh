import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../native/', import.meta.url);
const hashes = JSON.parse(await readFile(new URL('harmony-bridge/bin/sha256.json', root), 'utf8'));
for (const [name, hash] of Object.entries(hashes)) {
  if (!/^phone-use-(aarch64|x86_64)\.so$/.test(name)) throw new Error('Unexpected native artifact');
  const bytes = await readFile(new URL(`harmony-bridge/bin/${name}`, root));
  if (
    bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
    bytes[4] !== 2 ||
    bytes.readUInt16LE(18) !== (name.includes('aarch64') ? 183 : 62)
  )
    throw new Error(`Invalid ELF architecture: ${name}`);
  if (createHash('sha256').update(bytes).digest('hex') !== hash)
    throw new Error(`Integrity check failed: ${name}`);
  console.log(`${name}: ELF64 verified (${bytes.length} bytes)`);
}
if (Object.keys(hashes).length !== 2)
  throw new Error('Both HarmonyOS device architectures are required');
const server = await readFile(new URL('android-server/scrcpy-server-v4.0', root));
if (
  createHash('sha256').update(server).digest('hex') !==
  '84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a'
)
  throw new Error('Android server integrity check failed');
console.log(`Android server 4.0: upstream SHA-256 verified (${server.length} bytes)`);
const iosDirectory = new URL('ios-simulator-input/', root);
const iosManifest = JSON.parse(await readFile(new URL('bin/sha256.json', iosDirectory), 'utf8'));
const iosBinary = await readFile(new URL('bin/phone-use-ios-input', iosDirectory));
const iosSource = await readFile(new URL('phone_use.mm', iosDirectory));
if (
  iosManifest.protocol !== 1 ||
  iosBinary.readUInt32BE(0) !== 0xcafebabe ||
  iosBinary.readUInt32BE(4) !== 2 ||
  createHash('sha256').update(iosBinary).digest('hex') !== iosManifest.binary ||
  createHash('sha256').update(iosSource).digest('hex') !== iosManifest.source
)
  throw new Error('iOS input bridge or its source integrity check failed');
const iosArchitectures = [iosBinary.readUInt32BE(8), iosBinary.readUInt32BE(28)].sort();
if (iosArchitectures.join(',') !== [0x01000007, 0x0100000c].sort().join(','))
  throw new Error('iOS input bridge must contain both macOS architectures');
console.log(`iOS input bridge: universal Mach-O and source verified (${iosBinary.length} bytes)`);
