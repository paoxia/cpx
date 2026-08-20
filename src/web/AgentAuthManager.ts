import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Logger } from '../utils/Logger';

export type AgentAuthProvider = 'codex';
export type AgentAuthState =
  | 'idle'
  | 'checking'
  | 'waiting'
  | 'authenticated'
  | 'failed'
  | 'cancelled';

export interface AgentAuthSnapshot {
  provider: 'codex';
  displayName: 'Codex';
  loginMode: 'device-code';
  state: AgentAuthState;
  authenticated: boolean;
  cliAvailable: boolean;
  authMethod?: string;
  verificationUrl?: string;
  userCode?: string;
  output?: string;
  message?: string;
  startedAt?: number;
}

export interface AgentAuthService {
  getStatus(): Promise<AgentAuthSnapshot>;
  startLogin(): Promise<AgentAuthSnapshot>;
  loginWithApiKey(apiKey: string): Promise<AgentAuthSnapshot>;
  cancelLogin(): boolean;
  stop(): Promise<void>;
}

type SpawnCommand = typeof spawn;
const MAX_OUTPUT_LENGTH = 16 * 1024;

/** 使用 Codex 官方 CLI 完成设备码或 API Key 登录。 */
export class AgentAuthManager implements AgentAuthService {
  private readonly logger: Logger;
  private readonly spawnCommand: SpawnCommand;
  private process?: ChildProcessWithoutNullStreams;
  private snapshot: AgentAuthSnapshot = baseSnapshot('idle');

  constructor(logger: Logger, spawnCommand: SpawnCommand = spawn) {
    this.logger = logger.child('CodexAuth');
    this.spawnCommand = spawnCommand;
  }

  async getStatus(): Promise<AgentAuthSnapshot> {
    if (this.process) return { ...this.snapshot };
    const result = await this.run(['login', 'status'], undefined, 10_000);
    if (!result.available) {
      this.snapshot = {
        ...baseSnapshot('failed'),
        cliAvailable: false,
        message: '未找到 codex CLI，请重新构建包含 Codex 的镜像。',
      };
      return { ...this.snapshot };
    }
    const authenticated = result.code === 0 && /logged in/i.test(result.output);
    const authMethod = /chatgpt/i.test(result.output)
      ? 'ChatGPT'
      : /api key/i.test(result.output)
        ? 'API Key'
        : /access token/i.test(result.output)
          ? 'Access Token'
          : undefined;
    this.snapshot = {
      ...baseSnapshot(authenticated ? 'authenticated' : 'idle'),
      ...(authMethod ? { authMethod } : {}),
      message: authenticated ? 'Codex 已登录。' : 'Codex 尚未登录。',
    };
    return { ...this.snapshot };
  }

  async startLogin(): Promise<AgentAuthSnapshot> {
    if (this.process) return { ...this.snapshot };
    this.snapshot = {
      ...baseSnapshot('waiting'),
      output: '',
      message: '正在获取设备码…',
      startedAt: Date.now(),
    };
    try {
      const child = this.spawnCommand('codex', ['login', '--device-auth'], childOptions());
      this.process = child;
      child.stdout.on('data', (chunk: Buffer | string) => this.appendOutput(String(chunk)));
      child.stderr.on('data', (chunk: Buffer | string) => this.appendOutput(String(chunk)));
      child.once('error', (error) => this.handleProcessError(child, error));
      child.once('close', (code) => {
        if (this.process !== child) return;
        this.process = undefined;
        void this.finishLogin(code ?? 1);
      });
    } catch (error) {
      this.process = undefined;
      this.snapshot = launchFailure(error);
    }
    return { ...this.snapshot };
  }

  async loginWithApiKey(apiKey: string): Promise<AgentAuthSnapshot> {
    if (this.process) throw new Error('已有进行中的 Codex 登录，请先取消或等待完成');
    const normalized = apiKey.trim();
    if (!normalized || normalized.length > 4096 || /[\r\n\0]/.test(normalized)) {
      throw new Error('OpenAI API Key 格式无效');
    }
    const result = await this.run(['login', '--with-api-key'], `${normalized}\n`, 30_000);
    if (!result.available) return launchFailure(new Error('spawn codex ENOENT'));
    if (result.code !== 0) {
      this.snapshot = {
        ...baseSnapshot('failed'),
        message: sanitizeLoginError(result.output) || 'Codex API Key 登录失败。',
      };
      return { ...this.snapshot };
    }
    return this.getStatus();
  }

  cancelLogin(): boolean {
    if (!this.process) return false;
    const child = this.process;
    this.process = undefined;
    child.kill();
    this.snapshot = { ...baseSnapshot('cancelled'), message: '已取消 Codex 登录。' };
    return true;
  }

  async stop(): Promise<void> {
    this.cancelLogin();
  }

  private appendOutput(value: string): void {
    const output = `${this.snapshot.output ?? ''}${stripTerminalControlCharacters(value)}`.slice(
      -MAX_OUTPUT_LENGTH,
    );
    const verificationUrl = output.match(/https:\/\/[^\s<>"'\]]+/i)?.[0].replace(/[),.;]+$/, '');
    const userCode = output.match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b/i)?.[0].toUpperCase();
    this.snapshot = {
      ...this.snapshot,
      output,
      message: verificationUrl ? '请在可信浏览器完成授权。' : this.snapshot.message,
      ...(verificationUrl ? { verificationUrl } : {}),
      ...(userCode ? { userCode } : {}),
    };
  }

  private handleProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.process = undefined;
    this.snapshot = launchFailure(error);
    this.logger.warn(`Codex 登录启动失败: ${error.message}`);
  }

  private async finishLogin(exitCode: number): Promise<void> {
    const output = this.snapshot.output;
    if (exitCode !== 0) {
      this.snapshot = {
        ...this.snapshot,
        state: 'failed',
        authenticated: false,
        message: lastNonEmptyLine(output) || `Codex 登录失败（退出码 ${exitCode}）。`,
      };
      return;
    }
    const status = await this.getStatus();
    if (!status.authenticated) {
      this.snapshot = { ...status, state: 'failed', message: '授权已结束，但状态验证失败。' };
    }
  }

  private run(
    args: string[],
    input?: string,
    timeoutMs = 10_000,
  ): Promise<{ available: boolean; code: number; output: string }> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnCommand('codex', args, childOptions());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({ available: !message.includes('ENOENT'), code: 1, output: message });
        return;
      }
      let output = '';
      let settled = false;
      const finish = (result: { available: boolean; code: number; output: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish({ available: true, code: 1, output: 'Codex 登录命令超时。' });
      }, timeoutMs);
      timeout.unref();
      const append = (chunk: Buffer | string): void => {
        output = `${output}${stripTerminalControlCharacters(String(chunk))}`.slice(-MAX_OUTPUT_LENGTH);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) =>
        finish({ available: !error.message.includes('ENOENT'), code: 1, output: error.message }),
      );
      child.once('close', (code) => finish({ available: true, code: code ?? 1, output }));
      if (input !== undefined) child.stdin.end(input);
    });
  }
}

export function isAgentAuthProvider(value: unknown): value is AgentAuthProvider {
  return value === 'codex';
}

function baseSnapshot(state: AgentAuthState): AgentAuthSnapshot {
  return {
    provider: 'codex',
    displayName: 'Codex',
    loginMode: 'device-code',
    state,
    authenticated: state === 'authenticated',
    cliAvailable: true,
  };
}

function childOptions(): { env: NodeJS.ProcessEnv; shell: boolean; windowsHide: boolean } {
  return { env: process.env, shell: process.platform === 'win32', windowsHide: true };
}

function launchFailure(error: unknown): AgentAuthSnapshot {
  const message = error instanceof Error ? error.message : String(error);
  const missing = message.includes('ENOENT');
  return {
    ...baseSnapshot('failed'),
    cliAvailable: !missing,
    message: missing ? '未找到 codex CLI。' : `Codex 登录启动失败：${message}`,
  };
}

function sanitizeLoginError(value: string): string | undefined {
  return lastNonEmptyLine(value)?.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300);
}

function stripTerminalControlCharacters(value: string): string {
  return value
    // ANSI OSC and CSI sequences intentionally contain ESC/BEL control bytes.
    // eslint-disable-next-line no-control-regex
    .replace(new RegExp('\\x1B\\][^\\x07]*(?:\\x07|\\x1B\\\\)', 'g'), '')
    // eslint-disable-next-line no-control-regex
    .replace(new RegExp('\\x1B\\[[0-?]*[ -/]*[@-~]', 'g'), '')
    .replace(/[^\t\n\r\x20-\x7E\u0080-\uFFFF]/g, '');
}

function lastNonEmptyLine(value?: string): string | undefined {
  return value?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}
