/**
 * Coding Agent 适配器表。
 *
 * 把 codex / claude / codebuddy 三个 CLI 的调用差异集中到一张数据表,
 * AgentTaskManager.runAgent 按表查找并 spawn。这是 ARCHITECTURE.md 约定的
 * 新 Agent 扩展点:新增 provider 只需在此表添加一项,无需改动 runAgent 主体。
 *
 * prompt 通过 stdin 喂入(三个 CLI 都支持),不放在 args 里。
 */

import type { CodingAgentProvider } from './AgentTaskManager';

export interface AgentAdapter {
  /** CLI 可执行文件名 */
  readonly command: string;
  /** 控制台展示名 */
  readonly displayName: string;
  /** API key 注入到子进程的环境变量名 */
  readonly apiKeyEnvVar: 'CODEX_API_KEY' | 'ANTHROPIC_API_KEY' | 'CODEBUDDY_API_KEY';
  /** 构造 CLI 参数(不含 prompt,prompt 通过 stdin 传入) */
  buildArgs(model: string | undefined): string[];
  /** Windows 上 npm CLI 包装脚本需要通过 shell 解析。 */
  readonly useShellOnWindows: boolean;
}

const codexAdapter: AgentAdapter = {
  command: 'codex',
  displayName: 'Codex',
  apiKeyEnvVar: 'CODEX_API_KEY',
  buildArgs: (model) => {
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '--color', 'never'];
    if (model) {
      args.push('--model', model);
    }
    args.push('-');
    return args;
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
  useShellOnWindows: true,
};

const codebuddyAdapter: AgentAdapter = {
  command: 'codebuddy',
  displayName: 'CodeBuddy',
  apiKeyEnvVar: 'CODEBUDDY_API_KEY',
  buildArgs: (model) => {
    const args = [
      '-p',
      '-y',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'acceptEdits',
    ];
    if (model) {
      args.push('--model', model);
    }
    return args;
  },
  useShellOnWindows: true,
};

export const AGENT_ADAPTERS: Readonly<Record<CodingAgentProvider, AgentAdapter>> = {
  codex: codexAdapter,
  claude: claudeAdapter,
  codebuddy: codebuddyAdapter,
};

/** 全部合法 provider 列表,用于校验与归一化。 */
export const ALL_PROVIDERS: readonly CodingAgentProvider[] = ['codex', 'claude', 'codebuddy'];
