import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import * as yaml from 'js-yaml';
import { isSecretConfigPath } from '../cliSupport';
import { CliArgumentsSchema, CliExtensionSchema, ExtensionNameSchema } from './schema';
import type { CliExtension } from './schema';

export interface CliExecutionResult {
  name: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export function cliExecutionFailed(result: CliExecutionResult): boolean {
  return result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded;
}

/** 每次读取落盘 manifest，让运行中的 CPX 和 MCP 自动看到变更。 */
export class CliExtensionRegistry {
  readonly directory: string;
  private readonly cancellations = new Set<() => void>();
  private stopped = false;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  list(agentOnly = false): CliExtension[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((name) => name.endsWith('.yaml'))
      .sort()
      .map((file) => this.get(file.slice(0, -5)))
      .filter((extension) => !agentOnly || (extension.enabled && extension.agentEnabled));
  }

  get(name: string): CliExtension {
    const path = this.path(name);
    if (!existsSync(path)) throw new Error(`CLI 扩展不存在: ${name}`);
    const extension = CliExtensionSchema.parse(yaml.load(readFileSync(path, 'utf8')));
    if (extension.name !== name) throw new Error(`CLI 扩展名称与文件名不一致: ${name}`);
    return extension;
  }

  add(input: unknown, replace = false): CliExtension {
    const extension = CliExtensionSchema.parse(input);
    const path = this.path(extension.name);
    if (existsSync(path) && !replace)
      throw new Error(`CLI 扩展已存在: ${extension.name}（可用 --force 替换）`);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, yaml.dump(extension, { noRefs: true, lineWidth: -1 }), {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    return extension;
  }

  setEnabled(name: string, enabled: boolean): void {
    this.add({ ...this.get(name), enabled }, true);
  }

  remove(name: string): void {
    this.get(name);
    rmSync(this.path(name));
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.cancellations) cancel();
  }

  async run(name: string, inputArgs: string[] = [], agent = false): Promise<CliExecutionResult> {
    if (this.stopped) throw new Error('CLI 扩展执行器已停止');
    const args = CliArgumentsSchema.parse(inputArgs);
    const extension = this.get(name);
    if (!extension.enabled) throw new Error(`CLI 扩展已禁用: ${name}`);
    if (agent && !extension.agentEnabled) throw new Error(`CLI 扩展未授权给 Agent: ${name}`);
    if (
      extension.allowedPrefixes.length &&
      !extension.allowedPrefixes.some((prefix) =>
        prefix.every((part, index) => args[index] === part),
      )
    )
      throw new Error(`命令不在 CLI 扩展授权前缀内: ${name}`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [target, source] of Object.entries(extension.env)) {
      if (process.env[source] === undefined) throw new Error(`缺少环境变量: ${source}`);
      env[target] = process.env[source];
    }
    const secrets = [
      ...new Set(
        Object.entries(env)
          .filter(([key, value]) => value && (isSecretConfigPath(key) || key in extension.env))
          .map(([, value]) => value!),
      ),
    ].sort((left, right) => right.length - left.length);
    const redact = (value: string): string =>
      secrets.reduce((text, secret) => text.split(secret).join('***'), value);
    const cwd = extension.cwd
      ? resolve(this.directory, extension.cwd)
      : dirname(dirname(this.directory));
    const command =
      !isAbsolute(extension.command) && /[/\\]/.test(extension.command)
        ? resolve(this.directory, extension.command)
        : extension.command;

    // 在启动进程之前写审计；审计失败时不执行命令。参数与输出可能有密钥，不落盘。
    const executionId = randomUUID();
    this.audit({ executionId, name, agent, event: 'start' });
    let result: CliExecutionResult;
    try {
      result = await this.execute(extension, command, args, cwd, env);
    } catch (error) {
      this.audit({ executionId, name, agent, event: 'failure' });
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === 'ENOENT'
          ? `无法启动 CLI 扩展 ${name}：请检查可执行文件和工作目录`
          : `CLI 扩展启动失败: ${name}${code ? ` (${code})` : ''}`,
      );
    }
    this.audit({
      executionId,
      name,
      agent,
      event: 'finish',
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputLimitExceeded: result.outputLimitExceeded,
    });
    return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
  }

  private execute(
    extension: CliExtension,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<CliExecutionResult> {
    return new Promise((done, reject) => {
      const child: ChildProcessWithoutNullStreams = spawn(command, [...extension.args, ...args], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;
      let outputLimitExceeded = false;
      let killTimer: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* 进程可能已经退出。 */
        }
      };
      const finish = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        error?: Error,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // 不取消已安排的组 SIGKILL：父进程退出后，子孙进程仍可能存活。
        this.cancellations.delete(cancel);
        if (error) reject(error);
        else
          done({
            name: extension.name,
            exitCode,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
            timedOut,
            outputLimitExceeded,
          });
      };
      const terminate = (): void => {
        if (killTimer) return;
        kill('SIGTERM');
        killTimer = setTimeout(() => {
          kill('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, 'SIGKILL');
        }, 300);
      };
      const cancel = (): void => {
        terminate();
      };
      this.cancellations.add(cancel);
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, extension.timeoutMs);
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        const available = Math.max(0, extension.maxOutputBytes - bytes);
        if (available) chunks.push(chunk.subarray(0, available));
        bytes += chunk.length;
        if (bytes > extension.maxOutputBytes) {
          outputLimitExceeded = true;
          terminate();
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
      child.once('error', (error) => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
      child.stdin.on('error', () => {
        /* 部分 CLI 不读取 stdin。 */
      });
      child.stdin.end();
    });
  }

  private path(name: string): string {
    return join(this.directory, `${ExtensionNameSchema.parse(name)}.yaml`);
  }

  private audit(record: Record<string, unknown>): void {
    const path = join(this.directory, '.audit.jsonl');
    appendFileSync(
      path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  }
}
