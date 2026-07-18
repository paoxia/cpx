import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { Logger } from '../utils/Logger';
import { AGENT_ADAPTERS, ALL_PROVIDERS } from './agentAdapters';
import {
  AgentErrorKind,
  AgentProcessError,
  classifyAgentError,
  kindLabel,
  lastLine,
} from './errorClassifier';

export type CodingAgentProvider = 'codex' | 'claude' | 'codebuddy';
export type AgentTaskStatus =
  'queued' | 'preparing' | 'running' | 'publishing' | 'completed' | 'failed' | 'cancelled';

export interface AgentTaskRequest {
  /** 主 Agent(primary)。若同时提供 providers,以此为首项的语义被 providers 覆盖。 */
  provider?: CodingAgentProvider;
  /** 完整尝试顺序列表(首项为主,余项为备选)。缺省时回退到 [provider]。 */
  providers?: CodingAgentProvider[];
  model?: string;
  repository: string;
  baseBranch?: string;
  prompt: string;
  createPullRequest?: boolean;
}

export interface AgentTaskLog {
  timestamp: number;
  stream: 'system' | 'stdout' | 'stderr';
  message: string;
}

export interface AgentAttempt {
  provider: CodingAgentProvider;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'success' | 'failed';
  errorKind?: AgentErrorKind;
  /** 摘要(非完整 stderr),用于 UI 展示。 */
  error?: string;
}

export interface AgentTask {
  id: string;
  /** 用户首选(primary)。当前正在尝试的 provider 从 attempts[末尾] 取。 */
  provider: CodingAgentProvider;
  /** 归一化后的完整尝试列表,至少 1 项。 */
  providers: CodingAgentProvider[];
  model?: string;
  repository: string;
  baseBranch?: string;
  prompt: string;
  createPullRequest: boolean;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  workspace?: string;
  agentBranch?: string;
  pullRequestUrl?: string;
  error?: string;
  logs: AgentTaskLog[];
  attempts: AgentAttempt[];
}

export interface AgentRuntimeSecrets {
  openaiApiKey?: string;
  anthropicApiKey?: string;
  codebuddyApiKey?: string;
}

const MAX_LOG_ENTRIES = 800;
const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const BRANCH_PATTERN = /^[a-zA-Z0-9._/-]+$/;

/**
 * 为 Codex/Claude Code 准备隔离工作区并管理非交互任务生命周期。
 * 任务保存在内存中；工作区和 Git 历史保存在 workspaceRoot 下。
 */
export class AgentTaskManager {
  private tasks = new Map<string, AgentTask>();
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private workspaceRoot: string;
  private logger: Logger;
  private secrets: AgentRuntimeSecrets = {};
  private stopped = false;

  constructor(workspaceRoot: string, logger: Logger) {
    this.workspaceRoot = resolve(workspaceRoot);
    this.logger = logger.child('AgentTasks');
    mkdirSync(this.workspaceRoot, { recursive: true });
  }

  setSecrets(secrets: AgentRuntimeSecrets): void {
    this.secrets = { ...this.secrets, ...secrets };
  }

  create(request: AgentTaskRequest): AgentTask {
    if (this.stopped) {
      throw new Error('任务管理器已停止');
    }
    const normalized = this.validateRequest(request);
    const now = Date.now();
    const task: AgentTask = {
      id: randomUUID(),
      ...normalized,
      createPullRequest: normalized.createPullRequest ?? false,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      logs: [],
      attempts: [],
    };
    this.tasks.set(task.id, task);
    this.addLog(task, 'system', '任务已创建，正在准备 Git 工作区。');
    queueMicrotask(() => {
      if (task.status !== 'cancelled') {
        void this.execute(task);
      }
    });
    return this.snapshot(task);
  }

  list(): AgentTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => this.snapshot(task));
  }

  get(id: string): AgentTask | undefined {
    const task = this.tasks.get(id);
    return task ? this.snapshot(task) : undefined;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) {
      return false;
    }
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    task.completedAt = Date.now();
    this.addLog(task, 'system', '用户已取消任务。');
    this.processes.get(id)?.kill();
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.status)) {
        task.status = 'cancelled';
        task.completedAt = Date.now();
        this.addLog(task, 'system', '服务停止，任务已取消。');
      }
    }
    for (const process of this.processes.values()) {
      process.kill();
    }
    this.processes.clear();
  }

  private validateRequest(request: AgentTaskRequest): Omit<AgentTaskRequest, 'providers' | 'provider'> & {
    provider: CodingAgentProvider;
    providers: CodingAgentProvider[];
  } {
    const providers = normalizeProviders(request.provider, request.providers);
    const repository = normalizeRepository(request.repository);
    const prompt = request.prompt?.trim();
    if (!prompt) {
      throw new Error('任务指令不能为空');
    }
    if (prompt.length > 20_000) {
      throw new Error('任务指令不能超过 20000 个字符');
    }
    const model = request.model?.trim() || undefined;
    if (model && !MODEL_PATTERN.test(model)) {
      throw new Error('模型名称包含不支持的字符');
    }
    const baseBranch = request.baseBranch?.trim() || undefined;
    if (
      baseBranch &&
      (!BRANCH_PATTERN.test(baseBranch) || baseBranch.includes('..') || baseBranch.startsWith('/'))
    ) {
      throw new Error('基础分支名称无效');
    }
    return {
      provider: providers[0],
      providers,
      repository,
      baseBranch,
      model,
      prompt,
      createPullRequest: Boolean(request.createPullRequest),
    };
  }

  private async execute(task: AgentTask): Promise<void> {
    try {
      task.status = 'preparing';
      task.startedAt = Date.now();
      task.updatedAt = Date.now();
      const workspace = join(this.workspaceRoot, task.id);
      task.workspace = workspace;

      const cloneArgs = ['clone', '--depth', '1'];
      if (task.baseBranch) {
        cloneArgs.push('--branch', task.baseBranch);
      }
      cloneArgs.push(task.repository, workspace);
      await this.runProcess(task, 'git', cloneArgs, this.workspaceRoot);
      this.assertNotCancelled(task);

      const branch = `cpx/task-${task.id.slice(0, 8)}`;
      task.agentBranch = branch;
      await this.runProcess(task, 'git', ['checkout', '-b', branch], workspace);
      this.assertNotCancelled(task);

      task.status = 'running';
      task.updatedAt = Date.now();
      await this.runAgentWithFallback(task, workspace);
      this.assertNotCancelled(task);

      if (task.createPullRequest) {
        task.status = 'publishing';
        task.updatedAt = Date.now();
        await this.publishPullRequest(task, workspace);
      }

      task.status = 'completed';
      task.updatedAt = Date.now();
      task.completedAt = Date.now();
      this.addLog(
        task,
        'system',
        task.pullRequestUrl
          ? `任务完成：${task.pullRequestUrl}`
          : '任务完成，改动保留在本地工作区。',
      );
    } catch (error) {
      if (task.status === 'cancelled') {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      task.status = 'failed';
      task.error = message;
      task.updatedAt = Date.now();
      task.completedAt = Date.now();
      this.addLog(task, 'system', `任务失败：${message}`);
      this.logger.error(`任务 ${task.id} 失败: ${message}`);
    }
  }

  /**
   * 按 task.providers 顺序尝试每个 Agent。额度类(rate_limit/auth)失败才切换;
   * 其他失败立即抛出。workspace 在循环外创建一次,失败时复用(不 reset)。
   */
  private async runAgentWithFallback(task: AgentTask, workspace: string): Promise<void> {
    const providers = task.providers;
    for (let i = 0; i < providers.length; i++) {
      this.assertNotCancelled(task);
      const provider = providers[i];
      const adapter = AGENT_ADAPTERS[provider];

      const attempt: AgentAttempt = {
        provider,
        startedAt: Date.now(),
        status: 'running',
      };
      task.attempts.push(attempt);
      this.addLog(
        task,
        'system',
        `${adapter.displayName} 开始执行(第 ${i + 1}/${providers.length} 个 Agent)。`,
      );

      try {
        await this.runAgent(task, workspace, provider);
        attempt.status = 'success';
        attempt.endedAt = Date.now();
        return;
      } catch (error) {
        attempt.endedAt = Date.now();
        attempt.status = 'failed';

        if (task.status === 'cancelled') {
          attempt.errorKind = 'cancelled';
          attempt.error = '用户取消';
          throw error;
        }

        const kind = classifyAgentError(error instanceof Error ? error : new Error(String(error)));
        attempt.errorKind = kind;
        const summary =
          error instanceof AgentProcessError
            ? `${error.command} 退出码 ${error.exitCode ?? 'null'}${
                error.stderr.trim() ? `: ${lastLine(error.stderr)}` : ''
              }`
            : error instanceof Error
              ? error.message
              : String(error);
        attempt.error = summary;
        this.addLog(task, 'system', `${adapter.displayName} 失败[${kindLabel(kind)}]: ${summary}`);

        const isFallbackEligible = kind === 'rate_limit' || kind === 'auth';
        const isLast = i === providers.length - 1;

        if (!isFallbackEligible) {
          this.addLog(
            task,
            'system',
            `${adapter.displayName} 发生非额度类错误,不再尝试备选 Agent。`,
          );
          throw error;
        }
        if (isLast) {
          this.addLog(task, 'system', '所有备选 Agent 均失败。');
          throw new Error(buildFailureSummary(task.attempts));
        }
        const next = AGENT_ADAPTERS[providers[i + 1]];
        this.addLog(task, 'system', `将切换到备选 Agent: ${next.displayName}`);
      }
    }
  }

  private async runAgent(
    task: AgentTask,
    workspace: string,
    provider: CodingAgentProvider,
  ): Promise<void> {
    const adapter = AGENT_ADAPTERS[provider];
    const prompt = buildPrompt(task.prompt);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.secrets.openaiApiKey) {
      env.OPENAI_API_KEY = this.secrets.openaiApiKey;
    }
    if (this.secrets.anthropicApiKey) {
      env.ANTHROPIC_API_KEY = this.secrets.anthropicApiKey;
    }
    if (this.secrets.codebuddyApiKey) {
      env.CODEBUDDY_API_KEY = this.secrets.codebuddyApiKey;
    }
    const args = adapter.buildArgs(task.model);
    await this.runProcess(
      task,
      adapter.command,
      args,
      workspace,
      prompt,
      true,
      env,
      adapter.useShellOnWindows,
    );
  }

  private async publishPullRequest(task: AgentTask, workspace: string): Promise<void> {
    this.addLog(task, 'system', '正在提交改动并创建 Pull Request。');
    const status = await this.runProcess(
      task,
      'git',
      ['status', '--porcelain'],
      workspace,
      undefined,
      false,
    );
    if (!status.stdout.trim()) {
      this.addLog(task, 'system', 'Agent 没有产生文件改动，无需创建 Pull Request。');
      return;
    }

    await this.runProcess(task, 'git', ['add', '-A'], workspace);
    const title = buildCommitTitle(task.prompt);
    await this.runProcess(
      task,
      'git',
      [
        '-c',
        'user.name=cpx-agent',
        '-c',
        'user.email=cpx-agent@users.noreply.github.com',
        'commit',
        '-m',
        title,
      ],
      workspace,
    );
    await this.runProcess(task, 'git', ['push', '-u', 'origin', task.agentBranch!], workspace);
    const pr = await this.runProcess(
      task,
      'gh',
      ['pr', 'create', '--fill', '--head', task.agentBranch!],
      workspace,
    );
    const url = pr.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (!url) {
      throw new Error('gh 已执行，但没有返回 Pull Request URL');
    }
    task.pullRequestUrl = url;
  }

  private runProcess(
    task: AgentTask,
    command: string,
    args: string[],
    cwd: string,
    stdin?: string,
    captureAgentJson = false,
    env: NodeJS.ProcessEnv = process.env,
    useShellOnWindows = false,
  ): Promise<{ stdout: string; stderr: string }> {
    this.assertNotCancelled(task);
    this.addLog(task, 'system', `$ ${command} ${args.filter((arg) => arg !== '-').join(' ')}`);

    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        shell: useShellOnWindows && process.platform === 'win32',
        windowsHide: true,
      });
      this.processes.set(task.id, child);

      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const flush = (stream: 'stdout' | 'stderr', final = false) => {
        let buffer = stream === 'stdout' ? stdoutBuffer : stderrBuffer;
        const lines = buffer.split(/\r?\n/);
        if (!final) {
          buffer = lines.pop() ?? '';
        } else {
          buffer = '';
        }
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          const message = captureAgentJson ? formatAgentEvent(line) : line;
          if (message) {
            this.addLog(task, stream, message);
          }
        }
        if (stream === 'stdout') {
          stdoutBuffer = buffer;
        } else {
          stderrBuffer = buffer;
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        stdoutBuffer += text;
        flush('stdout');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        stderrBuffer += text;
        flush('stderr');
      });
      child.on('error', (error) => {
        this.processes.delete(task.id);
        reject(new Error(`无法启动 ${command}: ${error.message}`));
      });
      child.on('close', (code) => {
        flush('stdout', true);
        flush('stderr', true);
        this.processes.delete(task.id);
        if (task.status === 'cancelled') {
          reject(new Error('任务已取消'));
          return;
        }
        if (code !== 0) {
          reject(new AgentProcessError(command, code, stderr, stdout));
          return;
        }
        resolvePromise({ stdout, stderr });
      });

      if (stdin !== undefined) {
        child.stdin.end(stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  private assertNotCancelled(task: AgentTask): void {
    if (task.status === 'cancelled') {
      throw new Error('任务已取消');
    }
  }

  private addLog(task: AgentTask, stream: AgentTaskLog['stream'], message: string): void {
    task.logs.push({ timestamp: Date.now(), stream, message });
    if (task.logs.length > MAX_LOG_ENTRIES) {
      task.logs.splice(0, task.logs.length - MAX_LOG_ENTRIES);
    }
    task.updatedAt = Date.now();
  }

  private snapshot(task: AgentTask): AgentTask {
    return {
      ...task,
      logs: task.logs.map((entry) => ({ ...entry })),
      attempts: task.attempts.map((attempt) => ({ ...attempt })),
    };
  }
}

function isTerminal(status: AgentTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function normalizeRepository(input: string): string {
  const value = input?.trim();
  if (!value) {
    throw new Error('GitHub 仓库不能为空');
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return `https://github.com/${value}.git`;
  }
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(value)) {
    return value.endsWith('.git') ? value : `${value}.git`;
  }
  if (/^git@github\.com:[\w.-]+\/[\w.-]+(?:\.git)?$/.test(value)) {
    return value.endsWith('.git') ? value : `${value}.git`;
  }
  throw new Error('仅支持 owner/repo、GitHub HTTPS 或 GitHub SSH 仓库地址');
}

function buildCommitTitle(prompt: string): string {
  const summary = prompt
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `feat: ${summary || 'complete agent task'}`;
}

function buildPrompt(taskPrompt: string): string {
  return [
    '你正在由 cpx 开发控制台执行任务。',
    '请只在当前 Git 仓库中工作，先理解现有代码，再实现用户目标并运行相关验证。',
    '不要执行 git push、创建 PR 或修改仓库外文件；发布步骤由 cpx 在用户授权后处理。',
    '完成后总结改动、验证结果和仍存在的风险。',
    '',
    `用户任务：${taskPrompt}`,
  ].join('\n');
}

/**
 * 归一化 providers 列表:去重保序,校验每项合法。
 * providers 优先;缺省时回退到 [provider]。两者皆空时抛错。
 */
function normalizeProviders(
  provider: CodingAgentProvider | undefined,
  providers: CodingAgentProvider[] | undefined,
): CodingAgentProvider[] {
  const source =
    providers && providers.length > 0
      ? providers
      : provider
        ? [provider]
        : undefined;
  if (!source || source.length === 0) {
    throw new Error('必须指定 provider 或 providers');
  }
  const seen = new Set<CodingAgentProvider>();
  const result: CodingAgentProvider[] = [];
  for (const item of source) {
    if (!ALL_PROVIDERS.includes(item)) {
      throw new Error(`provider 必须是 ${ALL_PROVIDERS.join('、')} 之一,收到: ${item}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  if (result.length === 0) {
    throw new Error('providers 不能为空');
  }
  return result;
}

function buildFailureSummary(attempts: AgentAttempt[]): string {
  const failed = attempts.filter((a) => a.status === 'failed');
  const parts = failed.map(
    (a) =>
      `${AGENT_ADAPTERS[a.provider].displayName}: ${a.errorKind ?? 'unknown'}${
        a.error ? ` - ${a.error}` : ''
      }`,
  );
  return `所有 Agent 均失败。${parts.join('; ')}`;
}

function formatAgentEvent(line: string): string {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const type = typeof event.type === 'string' ? event.type : 'event';
    if (type === 'result' && typeof event.result === 'string') {
      return event.result;
    }
    if (type === 'assistant') {
      const message = event.message as
        { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = message?.content
        ?.filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text)
        .join('\n');
      if (text) {
        return text;
      }
    }
    const item = event.item as { type?: string; text?: string; command?: string } | undefined;
    if (item?.text) {
      return item.text;
    }
    if (item?.command) {
      return `执行：${item.command}`;
    }
    return `[${type}]`;
  } catch {
    return line;
  }
}
