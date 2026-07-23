/**
 * Coding Agent 适配器表。
 *
 * 把 codex / claude 两个 CLI 的调用差异集中到一张数据表,
 * AgentTaskManager.runAgent 按表查找并 spawn。这是 ARCHITECTURE.md 约定的
 * 新 Agent 扩展点:新增 provider 只需在此表添加一项,无需改动 runAgent 主体。
 *
 * prompt 通过 stdin 喂入(两个 CLI 都支持),不放在 args 里。
 */

import type { CodingAgentProvider } from './AgentTaskManager';

export interface AgentAdapter {
  /** CLI 可执行文件名 */
  readonly command: string;
  /** 控制台展示名 */
  readonly displayName: string;
  /** API key 注入到子进程的环境变量名 */
  readonly apiKeyEnvVar: 'CODEX_API_KEY' | 'ANTHROPIC_API_KEY';
  /** 构造 CLI 参数(不含 prompt,prompt 通过 stdin 传入) */
  buildArgs(model: string | undefined, baseUrl?: string): string[];
  /** 将 API Key 与网关地址注入当前子进程。 */
  configureEnvironment(
    env: NodeJS.ProcessEnv,
    apiKey: string | undefined,
    baseUrl: string | undefined,
  ): void;
  /** Windows 上 npm CLI 包装脚本需要通过 shell 解析。 */
  readonly useShellOnWindows: boolean;
}

const codexAdapter: AgentAdapter = {
  command: 'codex',
  displayName: 'Codex',
  apiKeyEnvVar: 'CODEX_API_KEY',
  buildArgs: (model, baseUrl) => {
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '--color', 'never'];
    if (model) {
      args.push('--model', model);
    }
    if (baseUrl) {
      args.push('--config', `openai_base_url=${JSON.stringify(baseUrl)}`);
    }
    args.push('-');
    return args;
  },
  configureEnvironment: (env, apiKey) => {
    if (apiKey) {
      env.CODEX_API_KEY = apiKey;
    }
  },
  useShellOnWindows: true,
};

const claudeAdapter: AgentAdapter = {
  command: 'claude',
  displayName: 'Claude Code',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  buildArgs: (model) => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
    ];
    if (model) {
      args.push('--model', model);
    }
    return args;
  },
  configureEnvironment: (env, apiKey, baseUrl) => {
    if (baseUrl) {
      env.ANTHROPIC_BASE_URL = baseUrl;
    }
    const resolvedApiKey =
      apiKey || (baseUrl ? env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY : undefined);
    if (resolvedApiKey) {
      if (baseUrl) {
        env.ANTHROPIC_AUTH_TOKEN = resolvedApiKey;
        delete env.ANTHROPIC_API_KEY;
      } else {
        env.ANTHROPIC_API_KEY = resolvedApiKey;
      }
    }
  },
  useShellOnWindows: true,
};

export const AGENT_ADAPTERS: Readonly<Record<CodingAgentProvider, AgentAdapter>> = {
  codex: codexAdapter,
  claude: claudeAdapter,
};

/** 全部合法 provider 列表,用于校验与归一化。 */
export const ALL_PROVIDERS: readonly CodingAgentProvider[] = ['codex', 'claude'];
