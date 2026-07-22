import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Logger } from '../utils/Logger';

export type AgentAuthProvider = 'codex' | 'claude';
export type AgentAuthState =
  | 'idle'
  | 'checking'
  | 'waiting'
  | 'authenticated'
  | 'failed'
  | 'cancelled';

export interface AgentAuthSnapshot {
  provider: AgentAuthProvider;
  displayName: string;
  loginMode: 'device-code' | 'browser';
  state: AgentAuthState;
  authenticated: boolean;
  cliAvailable: boolean;
  authMethod?: string;
  verificationUrl?: string;
  userCode?: string;
  output?: string;
  message?: string;
  startedAt?: number;
  acceptsInput?: boolean;
}

export interface AgentAuthService {
  getStatus(): Promise<AgentAuthSnapshot>;
  startLogin(): Promise<AgentAuthSnapshot>;
  submitInput(input: string): AgentAuthSnapshot;
  cancelLogin(): boolean;
  stop(): Promise<void>;
}

type SpawnCommand = typeof spawn;

interface AgentAuthConfig {
  provider: AgentAuthProvider;
  displayName: string;
  command: string;
  loginMode: AgentAuthSnapshot['loginMode'];
  loginArgs: string[];
  statusArgs: string[];
  parseStatus(output: string, exitCode: number): { authenticated: boolean; authMethod?: string };
}

const AUTH_CONFIGS: Record<AgentAuthProvider, AgentAuthConfig> = {
  codex: {
    provider: 'codex',
    displayName: 'Codex',
    command: 'codex',
    loginMode: 'device-code',
    loginArgs: ['login', '--device-auth'],
    statusArgs: ['login', 'status'],
    parseStatus: (output, exitCode) => ({
      authenticated: exitCode === 0 && /logged in/i.test(output),
      authMethod: /chatgpt/i.test(output)
        ? 'ChatGPT'
        : /api key/i.test(output)
          ? 'API Key'
          : /access token/i.test(output)
            ? 'Access Token'
            : undefined,
    }),
  },
  claude: {
    provider: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    loginMode: 'browser',
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'status', '--json'],
    parseStatus: (output, exitCode) => {
      try {
        const parsed = JSON.parse(output) as { loggedIn?: boolean; authMethod?: string };
        return {
          authenticated: exitCode === 0 && parsed.loggedIn === true,
          authMethod: parsed.authMethod,
        };
      } catch {
        return { authenticated: exitCode === 0 && /logged.?in/i.test(output) };
      }
    },
  },
};

const MAX_OUTPUT_LENGTH = 16 * 1024;

/** 使用官方 CLI 管理 Coding Agent 登录，不接管 OAuth token 的交换与刷新。 */
export class AgentAuthManager implements AgentAuthService {
  private readonly config: AgentAuthConfig;
  private readonly logger: Logger;
  private readonly spawnCommand: SpawnCommand;
  private process?: ChildProcessWithoutNullStreams;
  private snapshot: AgentAuthSnapshot;

  constructor(provider: AgentAuthProvider, logger: Logger, spawnCommand: SpawnCommand = spawn) {
    this.config = AUTH_CONFIGS[provider];
    this.logger = logger.child(`${this.config.displayName}Auth`);
    this.spawnCommand = spawnCommand;
    this.snapshot = this.baseSnapshot('idle');
  }

  async getStatus(): Promise<AgentAuthSnapshot> {
    if (this.process) return { ...this.snapshot };

    this.snapshot = { ...this.snapshot, state: 'checking' };
    const result = await this.run(this.config.statusArgs);
    if (!result.available) {
      this.snapshot = {
        ...this.baseSnapshot('failed'),
        cliAvailable: false,
        message: `未找到 ${this.config.command} CLI，请先安装 ${this.config.displayName}。`,
      };
      return { ...this.snapshot };
    }

    const status = this.config.parseStatus(result.output.trim(), result.code);
    this.snapshot = {
      ...this.baseSnapshot(status.authenticated ? 'authenticated' : 'idle'),
      authenticated: status.authenticated,
      ...(status.authMethod ? { authMethod: status.authMethod } : {}),
      message: status.authenticated
        ? `${this.config.displayName} 已登录。`
        : `${this.config.displayName} 尚未登录。`,
    };
    return { ...this.snapshot };
  }

  async startLogin(): Promise<AgentAuthSnapshot> {
    if (this.process) return { ...this.snapshot };

    this.snapshot = {
      ...this.baseSnapshot('waiting'),
      output: '',
      message:
        this.config.loginMode === 'device-code'
          ? '正在获取设备码…'
          : '正在生成浏览器授权地址…',
      startedAt: Date.now(),
      acceptsInput: this.config.provider === 'claude',
    };

    try {
      this.logger.info(`启动 ${this.config.displayName} 登录`);
      const child = this.spawnCommand(this.config.command, this.config.loginArgs, {
        env: process.env,
        shell: process.platform === 'win32',
        windowsHide: true,
      });
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
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${this.config.displayName} 登录启动失败: ${message}`);
      this.snapshot = {
        ...this.baseSnapshot('failed'),
        cliAvailable: !message.includes('ENOENT'),
        message: `${this.config.displayName} 登录启动失败：${message}`,
      };
    }

    return { ...this.snapshot };
  }

  submitInput(input: string): AgentAuthSnapshot {
    if (!this.process || !this.snapshot.acceptsInput) {
      throw new Error(`${this.config.displayName} 当前不接受授权码`);
    }
    const normalized = normalizeAuthorizationInput(input);
    if (!normalized || normalized.length > 8192 || /[\r\n]/.test(normalized)) {
      throw new Error('授权码或 callback 地址格式无效');
    }
    this.process.stdin.write(`${normalized}\n`);
    this.snapshot = { ...this.snapshot, message: '授权信息已提交，正在验证登录状态…' };
    return { ...this.snapshot };
  }

  cancelLogin(): boolean {
    if (!this.process) return false;
    const child = this.process;
    this.process = undefined;
    child.kill();
    this.snapshot = {
      ...this.baseSnapshot('cancelled'),
      message: `已取消 ${this.config.displayName} 登录。`,
    };
    return true;
  }

  async stop(): Promise<void> {
    this.cancelLogin();
  }

  private baseSnapshot(state: AgentAuthState): AgentAuthSnapshot {
    return {
      provider: this.config.provider,
      displayName: this.config.displayName,
      loginMode: this.config.loginMode,
      state,
      authenticated: state === 'authenticated',
      cliAvailable: true,
    };
  }

  private appendOutput(value: string): void {
    const output = `${this.snapshot.output ?? ''}${stripTerminalControlCharacters(value)}`.slice(
      -MAX_OUTPUT_LENGTH,
    );
    const verificationUrl = extractVerificationUrl(output);
    const userCode =
      this.config.loginMode === 'device-code' ? extractDeviceCode(output) : undefined;
    this.snapshot = {
      ...this.snapshot,
      output,
      message: verificationUrl
        ? '请在可信浏览器完成授权。'
        : this.snapshot.message,
      ...(verificationUrl ? { verificationUrl } : {}),
      ...(userCode ? { userCode } : {}),
    };
  }

  private handleProcessError(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.process !== child) return;
    this.process = undefined;
    this.logger.warn(`${this.config.displayName} 登录启动失败: ${error.message}`);
    this.snapshot = {
      ...this.baseSnapshot('failed'),
      cliAvailable: !error.message.includes('ENOENT'),
      message: error.message.includes('ENOENT')
        ? `未找到 ${this.config.command} CLI，请先安装 ${this.config.displayName}。`
        : `${this.config.displayName} 登录启动失败：${error.message}`,
    };
  }

  private async finishLogin(exitCode: number): Promise<void> {
    const loginOutput = this.snapshot.output;
    if (exitCode !== 0) {
      this.logger.warn(`${this.config.displayName} 登录失败，退出码 ${exitCode}`);
      this.snapshot = {
        ...this.snapshot,
        state: 'failed',
        authenticated: false,
        message:
          lastNonEmptyLine(loginOutput) ||
          `${this.config.displayName} 登录失败（退出码 ${exitCode}）。`,
      };
      return;
    }

    const status = await this.getStatus();
    if (!status.authenticated) {
      this.snapshot = {
        ...status,
        state: 'failed',
        message: `${this.config.displayName} 授权流程已结束，但登录状态验证失败。`,
      };
    } else {
      this.logger.info(`${this.config.displayName} 登录完成`);
    }
  }

  private run(args: string[]): Promise<{ available: boolean; code: number; output: string }> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnCommand(this.config.command, args, {
          env: process.env,
          shell: process.platform === 'win32',
          windowsHide: true,
        });
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
        finish({ available: true, code: 1, output: '登录状态检查超时。' });
      }, 10_000);
      timeout.unref();
      const append = (chunk: Buffer | string): void => {
        output = `${output}${stripTerminalControlCharacters(String(chunk))}`.slice(
          -MAX_OUTPUT_LENGTH,
        );
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) =>
        finish({ available: !error.message.includes('ENOENT'), code: 1, output: error.message }),
      );
      child.once('close', (code) => finish({ available: true, code: code ?? 1, output }));
    });
  }
}

export function isAgentAuthProvider(value: unknown): value is AgentAuthProvider {
  return value === 'codex' || value === 'claude';
}

function normalizeAuthorizationInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes('code=')) return trimmed;
  try {
    const parsed = new URL(
      trimmed.includes('://') ? trimmed : `http://localhost/callback?${trimmed.replace(/^\?/, '')}`,
    );
    return parsed.searchParams.get('code')?.trim() || trimmed;
  } catch {
    const match = trimmed.match(/[?&]code=([^&]+)/);
    return match?.[1] ? decodeURIComponent(match[1]).trim() : trimmed;
  }
}

function extractVerificationUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s<>"'\]]+/i)?.[0].replace(/[),.;]+$/, '');
}

function extractDeviceCode(output: string): string | undefined {
  return output.match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b/i)?.[0].toUpperCase();
}

function stripTerminalControlCharacters(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[^\t\n\r\x20-\x7E\u0080-\uFFFF]/g, '')
  );
}

function lastNonEmptyLine(value?: string): string | undefined {
  return value
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}
