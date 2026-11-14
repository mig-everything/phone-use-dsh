import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PhoneError } from '../core/errors.js';

export interface CommandResult {
  stdout: Buffer;
  stderr: Buffer;
}
export interface Runner {
  run(binary: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
}
export class ProcessRunner implements Runner {
  async run(binary: string, args: string[], timeoutMs = 15_000): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let size = 0,
        failure: PhoneError | undefined;
      const timer = setTimeout(() => {
        failure = new PhoneError(
          'COMMAND_TIMEOUT',
          'Device command timed out. Observe before retrying an action.',
          true,
        );
        child.kill('SIGKILL');
      }, timeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > 24 * 1024 * 1024) {
          failure = new PhoneError(
            'OUTPUT_LIMIT',
            'Device output exceeded the 24 MiB limit.',
            true,
          );
          child.kill('SIGKILL');
        } else target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          new PhoneError(
            error.code === 'ENOENT' ? 'TOOL_MISSING' : 'COMMAND_FAILED',
            error.code === 'ENOENT'
              ? `Required executable is unavailable: ${binary}`
              : 'Could not start device command.',
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new PhoneError('COMMAND_FAILED', `Device command exited with status ${code}.`, true),
          );
        else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
  }
}

/** A host argv array does not prevent injection in adb/hdc's *remote* shell. */
export function shellQuote(value: string): string {
  if (value.includes('\0'))
    throw new PhoneError('INVALID_ARGUMENT', 'NUL is not allowed in shell arguments.');
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
export class DeviceShell {
  constructor(
    readonly runner: Runner,
    readonly binary: string,
    readonly prefix: string[] = [],
  ) {}
  async run(args: string[], timeoutMs?: number): Promise<Buffer> {
    return (await this.runner.run(this.binary, [...this.prefix, ...args], timeoutMs)).stdout;
  }
  async shell(args: string[], timeoutMs?: number): Promise<string> {
    const marker = `__PHONE_USE_EXIT_${randomUUID().replaceAll('-', '')}__`;
    const command = `${args.map(shellQuote).join(' ')}; phone_use_rc=$?; printf '\\n${marker}:%s\\n' "$phone_use_rc"`;
    const output = (await this.run(['shell', command], timeoutMs)).toString('utf8');
    const match = output.match(new RegExp(`\\n${marker}:(\\d+)\\s*$`));
    if (!match)
      throw new PhoneError(
        'DEVICE_UNREACHABLE',
        'Device shell did not return a complete response.',
        true,
      );
    if (match[1] !== '0')
      throw new PhoneError('DEVICE_COMMAND_FAILED', `Device shell returned ${match[1]}.`, true);
    return output.slice(0, match.index).trim();
  }
}
