import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { WorkbenchStore } from '../workbench/Store';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  statfsSync,
  realpathSync,
} from 'fs';
import { dirname, join, resolve, sep } from 'path';
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

export type CodingAgentProvider = 'codex';
export type AgentReasoningEffort =
  'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type AgentTaskStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'publishing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'review'
  | 'verifying';

export interface AgentModelConfiguration {
  id: string;
  name?: string;
  provider: CodingAgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  baseUrl?: string;
  apiKey?: string;
}

export type PublicAgentModelConfiguration = Omit<AgentModelConfiguration, 'apiKey'>;

export type PublishPolicy = 'local' | 'review' | 'auto';
export interface VerificationCommand {
  command: string;
  args: string[];
  timeoutMs?: number;
}
export interface TaskResult {
  version: string;
  baseCommit: string;
  head: string;
  tree: string;
  diff: string;
  files: string;
  createdAt: number;
}
export interface VerificationResult {
  command: string;
  args: string[];
  exitCode: number | null;
  output: string;
  startedAt: number;
  endedAt: number;
}
export interface TaskOrigin {
  isGroup?: boolean;
  source: string;
  userId: string;
  userName: string;
  commandId: string;
  replyRouteId?: string;
}
export interface TaskOptions {
  ownerId?: string;
  projectId?: string;
  projectVersion?: number;
  context?: string;
  policy?: PublishPolicy;
  idempotencyKey?: string;
  verificationCommands?: VerificationCommand[];
  timeoutMs?: number;
  executorId?: string;
  startCommit?: string;
  seedPatch?: string;
  extensions?: string[];
  independentReview?: boolean;
}
export interface TaskRuntimeOptions {
  runGitHub?: (
    task: AgentTask,
    command: 'git' | 'gh',
    args: string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string }>;
  store?: WorkbenchStore;
  concurrency?: number;
  maxQueue?: number;
  minFreeBytes?: number;
  timeoutMs?: number;
  onTerminal?: (task: AgentTask) => void;
  extensionTools?: (task: AgentTask) => { url: string; token: string } | undefined;
  guard?: (action: string, task: AgentTask) => void;
  runAgent?: (task: AgentTask, workspace: string) => Promise<void>;
  fence?: () => void;
  protectedBranches?: string[];
  logLimit?: number;
}
export interface AgentTaskRequest extends TaskOptions {
  /** 主 Agent(primary)。若同时提供 providers,以此为首项的语义被 providers 覆盖。 */
  provider?: CodingAgentProvider;
  /** 完整尝试顺序列表(首项为主,余项为备选)。缺省时回退到 [provider]。 */
  providers?: CodingAgentProvider[];
  model?: string;
  /** 有序模型配置。提供时覆盖旧版 provider/providers/model 参数。 */
  configurations?: AgentModelConfiguration[];
  repository: string;
  baseBranch?: string;
  /** 用户指定的新任务分支；未提供时自动生成 cpx/task-*。 */
  taskBranch?: string;
  prompt: string;
  createPullRequest?: boolean;
}

export interface AgentTaskContinuationRequest extends TaskOptions {
  newSession?: boolean;
  prompt: string;
  /** 继续任务时重新读取当前模型配置；未提供时沿用原任务的公开配置。 */
  configurations?: AgentModelConfiguration[];
  /** 设置后可在后续轮次提交或更新同一个 Pull Request。 */
  createPullRequest?: boolean;
}

export interface AgentTaskLog {
  timestamp: number;
  stream: 'system' | 'stdout' | 'stderr';
  message: string;
}

export interface AgentAttempt {
  configurationId?: string;
  provider: CodingAgentProvider;
  model?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'success' | 'failed';
  errorKind?: AgentErrorKind;
  /** 摘要(非完整 stderr),用于 UI 展示。 */
  error?: string;
}

export interface AgentTaskTurn {
  id: string;
  prompt: string;
  /** 当前轮次 Coding Agent 的最终回复，用于会话式界面回放。 */
  response?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface AgentTask extends TaskOptions {
  reviewReport?: {
    status: 'completed' | 'failed';
    response?: string;
    error?: string;
    startedAt: number;
    endedAt: number;
  };
  baseCommit?: string;
  result?: TaskResult;
  verification?: VerificationResult[];
  publication?: {
    status: 'not_requested' | 'pending' | 'publishing' | 'published' | 'failed' | 'unknown';
    version?: string;
    error?: string;
  };
  origin?: TaskOrigin;
  archivedAt?: number;
  acceptedAt?: number;
  stopConfirmed?: boolean;
  recoveryCount?: number;
  pendingInputs?: { id: string; prompt: string }[];
  id: string;
  /** 用户首选(primary)。当前正在尝试的 provider 从 attempts[末尾] 取。 */
  provider: CodingAgentProvider;
  /** 归一化后的完整尝试列表,至少 1 项。 */
  providers: CodingAgentProvider[];
  model?: string;
  /** 实际执行顺序，不包含 API Key。 */
  configurations: PublicAgentModelConfiguration[];
  repository: string;
  baseBranch?: string;
  taskBranch?: string;
  prompt: string;
  createPullRequest: boolean;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  workspace?: string;
  /** 按 GitHub owner/repository 两级目录保存的完整本地仓库。 */
  repositoryPath?: string;
  agentBranch?: string;
  /** Codex JSONL 返回的会话 ID，后续轮次通过 exec resume 继续。 */
  threadId?: string;
  /** 当前轮次 Coding Agent 的最终文本回复，用于 Web 与聊天平台回传。 */
  lastAgentResponse?: string;
  pullRequestUrl?: string;
  error?: string;
  logs: AgentTaskLog[];
  attempts: AgentAttempt[];
  turns: AgentTaskTurn[];
}

export interface AgentRuntimeSecrets {
  openaiApiKey?: string;
  githubToken?: string;
}

/** 仅注入对应任务的消息平台工具，不进入公开任务快照。 */
export interface AgentPlatformToolContext {
  endpoint: string;
  token: string;
  taskId: string;
  platform: 'dingtalk' | 'feishu';
}

const MAX_LOG_ENTRIES = 800;
const MODEL_PATTERN = /^[a-zA-Z0-9._:/-]+$/;
const BRANCH_PATTERN = /^[a-zA-Z0-9._/-]+$/;
const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'production'] as const;

/**
 * 为 Codex 准备隔离工作区并管理非交互任务生命周期。
 * 内存索引与可选 SQLite 持久层管理任务；工作区和 Git 历史保存在受管理目录。
 */
export class AgentTaskManager {
  private tasks = new Map<string, AgentTask>();
  private processes = new Map<string, ChildProcessWithoutNullStreams>();
  private workspaceRoot: string;
  private repositoryRoot: string;
  private logger: Logger;
  private secrets: AgentRuntimeSecrets = {};
  private executionConfigurations = new Map<string, AgentModelConfiguration[]>();
  private platformToolContexts = new Map<string, AgentPlatformToolContext>();
  private terminalWaiters = new Map<string, Set<(task: AgentTask) => void>>();
  private gitAskPassPath?: string;
  private repositoryLocks = new Map<string, Promise<void>>();
  private stopped = false;
  private schedulingStarted: boolean;
  private active = new Set<string>();
  private store?: WorkbenchStore;
  private options: TaskRuntimeOptions;
  private operationLocks = new Set<string>();
  private resumeWorkspace = new Set<string>();
  private executionPromises = new Set<Promise<void>>();
  private deadlines = new Map<string, number>();
  private remoteRunner?: (task: AgentTask) => Promise<{ patch: string; response: string }>;

  constructor(
    workspaceRoot: string,
    logger: Logger,
    repositoryRoot?: string,
    options: TaskRuntimeOptions = {},
  ) {
    this.options = options;
    this.schedulingStarted = !options.store;
    this.store = options.store;
    this.workspaceRoot = resolve(workspaceRoot);
    this.repositoryRoot = resolve(
      repositoryRoot ?? join(dirname(this.workspaceRoot), 'repositories'),
    );
    this.logger = logger.child('AgentTasks');
    mkdirSync(this.workspaceRoot, { recursive: true });
    mkdirSync(this.repositoryRoot, { recursive: true });
    for (const task of this.store?.loadTasks() ?? []) {
      if (!isTerminal(task.status) && task.status !== 'queued') {
        task.status = 'interrupted';
        task.stopConfirmed = true;
        task.error = '服务重启导致执行中断，请检查成果后恢复';
        if (task.turns.length) task.turns[task.turns.length - 1].status = 'failed';
      }
      if (task.publication?.status === 'publishing') task.publication.status = 'unknown';
      this.tasks.set(task.id, task);
      if (task.workspace) this.resumeWorkspace.add(task.id);
      this.persist(task);
    }
  }

  setSecrets(secrets: AgentRuntimeSecrets): void {
    this.secrets = { ...this.secrets, ...secrets };
  }

  setPlatformToolContext(taskId: string, context: AgentPlatformToolContext): void {
    if (!this.tasks.has(taskId)) {
      throw new Error('任务不存在');
    }
    if (context.taskId !== taskId) {
      throw new Error('平台工具任务范围不匹配');
    }
    this.platformToolContexts.set(taskId, { ...context });
  }

  create(request: AgentTaskRequest): AgentTask {
    if (this.stopped) {
      throw new Error('任务管理器已停止');
    }
    if (request.idempotencyKey) {
      const existing = [...this.tasks.values()].find(
        (t) => t.ownerId === request.ownerId && t.idempotencyKey === request.idempotencyKey,
      );
      if (existing) return this.snapshot(existing);
    }
    if (
      [...this.tasks.values()].filter((t) => t.status === 'queued').length >=
      (this.options.maxQueue ?? 100)
    )
      throw new Error('队列已满');
    const normalized = this.validateRequest(request);
    const configurations = normalized.configurations;
    const now = Date.now();
    const task: AgentTask = {
      id: randomUUID(),
      ...this.taskOptions(request),
      provider: configurations[0].provider,
      providers: configurations.map((configuration) => configuration.provider),
      model: configurations[0].model,
      configurations: configurations.map(({ apiKey: _apiKey, ...configuration }) => configuration),
      repository: normalized.repository,
      baseBranch: normalized.baseBranch,
      taskBranch: normalized.taskBranch,
      prompt: normalized.prompt,
      createPullRequest: normalized.createPullRequest,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      logs: [],
      attempts: [],
      turns: [this.createTurn(normalized.prompt, now)],
    };
    this.tasks.set(task.id, task);
    this.executionConfigurations.set(task.id, configurations);
    this.addLog(task, 'system', '任务已创建，正在准备 Git 工作区。');
    this.persist(task);
    queueMicrotask(() => this.drain());
    return this.snapshot(task);
  }

  continueTask(id: string, request: AgentTaskContinuationRequest): AgentTask {
    if (this.stopped) {
      throw new Error('任务管理器已停止');
    }
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error('任务不存在');
    }
    if (task.status === 'interrupted' && task.executorId)
      throw new Error('远程任务中断，请确认旧执行停止后使用恢复入口');
    if (task.archivedAt) throw new Error('任务已归档');
    if (request.idempotencyKey && this.store?.get('continued', `${id}:${request.idempotencyKey}`))
      return this.snapshot(task);
    if (this.active.has(id) || this.operationLocks.has(id) || !isTerminal(task.status)) {
      throw new Error('任务仍在执行，请等待当前轮次结束');
    }
    if (!task.workspace || !task.agentBranch || !existsSync(task.workspace)) {
      throw new Error('任务工作区尚未创建，无法继续');
    }

    if (
      [...this.tasks.values()].filter((t) => t.status === 'queued').length >=
      (this.options.maxQueue ?? 100)
    )
      throw new Error('队列已满');
    const prompt = validatePrompt(request.prompt);
    const configurations: AgentModelConfiguration[] = request.configurations
      ? normalizeConfigurations({
          repository: task.repository,
          prompt,
          configurations: request.configurations,
        })
      : task.configurations.map((configuration) => ({ ...configuration }));
    const now = Date.now();
    const nextOptions = this.taskOptions(request);
    delete nextOptions.idempotencyKey;
    Object.assign(task, nextOptions);
    if (request.newSession) task.threadId = undefined;
    task.result = undefined;
    task.verification = [];
    task.prompt = prompt;
    task.provider = configurations[0].provider;
    task.providers = configurations.map((configuration) => configuration.provider);
    task.model = configurations[0].model;
    task.configurations = configurations.map(
      ({ apiKey: _apiKey, ...configuration }) => configuration,
    );
    task.createPullRequest = request.createPullRequest ?? task.createPullRequest;
    task.status = 'queued';
    task.error = undefined;
    task.lastAgentResponse = undefined;
    task.completedAt = undefined;
    task.updatedAt = now;
    task.turns.push(this.createTurn(prompt, now));
    this.executionConfigurations.set(task.id, configurations);
    this.addLog(task, 'system', `收到第 ${task.turns.length} 轮指令，将继续使用现有工作区。`);
    this.resumeWorkspace.add(id);
    this.persist(task);
    if (request.idempotencyKey)
      this.store?.put('continued', `${id}:${request.idempotencyKey}`, { taskId: id });
    queueMicrotask(() => this.drain());
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

  waitForTerminal(id: string): Promise<AgentTask> {
    const task = this.tasks.get(id);
    if (!task) {
      return Promise.reject(new Error('任务不存在'));
    }
    if (isTerminal(task.status) && !this.active.has(id)) {
      return Promise.resolve(this.snapshot(task));
    }
    return new Promise((resolvePromise) => {
      const waiters = this.terminalWaiters.get(id) ?? new Set<(task: AgentTask) => void>();
      waiters.add(resolvePromise);
      this.terminalWaiters.set(id, waiters);
    });
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminal(task.status) || this.operationLocks.has(id)) {
      return false;
    }
    task.status = 'cancelled';
    task.stopConfirmed = !this.active.has(id);
    task.updatedAt = Date.now();
    task.completedAt = Date.now();
    const turn = this.currentTurn(task);
    turn.status = 'cancelled';
    turn.completedAt = task.completedAt;
    this.addLog(task, 'system', '用户已取消任务。');
    this.killProcess(id);
    this.executionConfigurations.delete(id);
    this.notifyTerminal(task);
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const task of this.tasks.values()) {
      if (!isTerminal(task.status) && task.status !== 'queued') {
        task.status = 'interrupted';
        task.error = '服务停止，执行已中断';
        this.currentTurn(task).status = 'failed';
        this.addLog(task, 'system', task.error);
        this.notifyTerminal(task);
      }
    }
    for (const id of this.processes.keys()) this.killProcess(id);
    await Promise.allSettled([...this.executionPromises]);
    this.platformToolContexts.clear();
  }

  start(): void {
    this.schedulingStarted = true;
    this.drain();
  }

  private taskOptions(request: TaskOptions): TaskOptions {
    const fields = [
      'ownerId',
      'projectId',
      'projectVersion',
      'context',
      'policy',
      'idempotencyKey',
      'verificationCommands',
      'timeoutMs',
      'executorId',
      'startCommit',
      'seedPatch',
      'extensions',
      'independentReview',
    ] as const;
    return Object.fromEntries(
      fields.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]),
    );
  }

  private persist(task: AgentTask): void {
    this.store?.saveTask(task);
  }

  private drain(): void {
    if (this.stopped || !this.schedulingStarted) return;
    for (const task of this.tasks.values()) {
      if (this.active.size >= (this.options.concurrency ?? 1)) break;
      if (task.status !== 'queued' || this.active.has(task.id)) continue;
      this.active.add(task.id);
      const execution = this.execute(task, this.resumeWorkspace.has(task.id)).finally(() => {
        this.active.delete(task.id);
        if (isTerminal(task.status)) this.notifyTerminal(task);
        this.executionPromises.delete(execution);
        this.drain();
      });
      this.executionPromises.add(execution);
    }
  }

  runtime(): { active: number; queued: number; concurrency: number; freeBytes: number } {
    const stat = statfsSync(this.workspaceRoot);
    return {
      active: this.active.size,
      queued: [...this.tasks.values()].filter((t) => t.status === 'queued').length,
      concurrency: this.options.concurrency ?? 1,
      freeBytes: stat.bavail * stat.bsize,
    };
  }

  configure(options: Partial<TaskRuntimeOptions>): void {
    Object.assign(this.options, options);
    this.drain();
  }

  bindOrigin(id: string, origin: TaskOrigin): void {
    const task = this.requireTask(id);
    task.origin = origin;
    task.ownerId = origin.source === 'cli' ? 'admin' : `${origin.source}:${origin.userId}`;
    this.persist(task);
  }

  queueInput(id: string, prompt: string): string {
    const task = this.requireTask(id);
    if ((task.pendingInputs?.length ?? 0) >= 10) throw new Error('待处理消息已满');
    const input = { id: randomUUID(), prompt: validatePrompt(prompt) };
    (task.pendingInputs ??= []).push(input);
    this.persist(task);
    return input.id;
  }

  removeInput(id: string, inputId: string): void {
    const task = this.requireTask(id);
    task.pendingInputs = task.pendingInputs?.filter((input) => input.id !== inputId);
    this.persist(task);
  }

  resume(id: string, newSession = false): AgentTask {
    const task = this.requireTask(id);
    if (
      [...this.tasks.values()].filter((t) => t.status === 'queued').length >=
      (this.options.maxQueue ?? 100)
    )
      throw new Error('队列已满');
    if (task.status !== 'interrupted' || this.active.has(id))
      throw new Error('仅已停止的中断任务可恢复');
    if (task.workspace) {
      this.assertWorkspace(task);
      this.resumeWorkspace.add(id);
    }
    if (newSession) task.threadId = undefined;
    task.recoveryCount = (task.recoveryCount ?? 0) + 1;
    task.stopConfirmed = undefined;
    task.status = 'queued';
    task.error = undefined;
    this.currentTurn(task).status = 'queued';
    this.persist(task);
    queueMicrotask(() => this.drain());
    return this.snapshot(task);
  }

  accept(id: string): void {
    const task = this.requireTask(id);
    task.acceptedAt = Date.now();
    this.persist(task);
  }
  archive(id: string): void {
    const task = this.requireTask(id);
    if (!isTerminal(task.status) || this.active.has(id) || this.operationLocks.has(id))
      throw new Error('活动任务不能归档');
    task.archivedAt = Date.now();
    this.persist(task);
  }

  private requireTask(id: string): AgentTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error('任务不存在');
    return task;
  }

  private assertWorkspace(task: AgentTask): string {
    if (!task.workspace || !existsSync(task.workspace)) throw new Error('工作区不存在');
    const expected = join(this.workspaceRoot, task.id);
    if (
      realpathSync(task.workspace) !== realpathSync(expected) ||
      realpathSync(task.workspace).startsWith(`${realpathSync(this.workspaceRoot)}${sep}`) === false
    )
      throw new Error('工作区路径无效');
    return task.workspace;
  }

  private killProcess(id: string): void {
    const child = this.processes.get(id);
    if (!child) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      child.kill();
    }
    const force = setTimeout(() => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else if (child.pid)
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {
        /* process already exited */
      }
    }, 2000);
    force.unref();
    child.once('close', () => clearTimeout(force));
  }

  setRemoteRunner(runner: (task: AgentTask) => Promise<{ patch: string; response: string }>): void {
    this.remoteRunner = runner;
  }

  private redact(value: string): string {
    let result = value;
    for (const secret of [
      this.secrets.githubToken,
      this.secrets.openaiApiKey,
      process.env.CPX_BOOTSTRAP_TOKEN,
      process.env.AGENT_GITHUB_TOKEN,
      process.env.CODEX_API_KEY,
    ]) {
      if (secret) result = result.split(secret).join('[REDACTED]');
    }
    return result.replace(/\b(?:github_pat_|ghp_)[a-zA-Z0-9_]+/g, '[REDACTED]');
  }

  private safeEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|GIT_|SSH_|CPX_BOOTSTRAP)/i.test(key)) delete env[key];
    }
    env.GIT_TERMINAL_PROMPT = '0';
    return env;
  }

  private async captureResult(task: AgentTask): Promise<TaskResult> {
    const workspace = this.assertWorkspace(task);
    const inspection = { ...task, status: 'completed' as const };
    const head = (
      await this.runProcess(inspection, 'git', ['rev-parse', 'HEAD'], workspace)
    ).stdout.trim();
    const baseCommit = task.baseCommit || head;
    const indexDir = join(this.workspaceRoot, '.indexes');
    mkdirSync(indexDir, { recursive: true, mode: 0o700 });
    const index = join(indexDir, randomUUID());
    const env = { ...this.safeEnvironment(), GIT_INDEX_FILE: index };
    try {
      await this.runProcess(
        inspection,
        'git',
        ['read-tree', 'HEAD'],
        workspace,
        undefined,
        false,
        env,
      );
      await this.runProcess(inspection, 'git', ['add', '-A'], workspace, undefined, false, env);
      const tree = (
        await this.runProcess(inspection, 'git', ['write-tree'], workspace, undefined, false, env)
      ).stdout.trim();
      const diff = (
        await this.runProcess(
          inspection,
          'git',
          ['diff', '--binary', '--full-index', baseCommit, tree, '--'],
          workspace,
        )
      ).stdout;
      const files = (
        await this.runProcess(
          inspection,
          'git',
          ['diff', '--stat', baseCommit, tree, '--'],
          workspace,
        )
      ).stdout;
      return {
        version: createHash('sha256').update(`${baseCommit}:${head}:${tree}`).digest('hex'),
        baseCommit,
        head,
        tree,
        diff,
        files,
        createdAt: Date.now(),
      };
    } finally {
      rmSync(index, { force: true });
    }
  }

  private async importRemoteResult(task: AgentTask, patch: string): Promise<void> {
    const before = task.result!;
    const current = await this.captureResult(task);
    if (before.version !== current.version) throw new Error('远程执行期间本地成果已变化，拒绝覆盖');
    const directory = join(this.workspaceRoot, '.indexes');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const index = join(directory, randomUUID());
    const env = { ...this.safeEnvironment(), GIT_INDEX_FILE: index };
    const workspace = this.assertWorkspace(task);
    try {
      await this.runProcess(
        task,
        'git',
        ['read-tree', before.baseCommit],
        workspace,
        undefined,
        false,
        env,
      );
      if (patch)
        await this.runProcess(
          task,
          'git',
          ['apply', '--cached', '--binary', '-'],
          workspace,
          patch,
          false,
          env,
        );
      const tree = (
        await this.runProcess(task, 'git', ['write-tree'], workspace, undefined, false, env)
      ).stdout.trim();
      const changes = (
        await this.runProcess(task, 'git', ['diff', '--binary', before.tree, tree, '--'], workspace)
      ).stdout;
      if (changes) {
        await this.runProcess(
          task,
          'git',
          ['apply', '--check', '--binary', '-'],
          workspace,
          changes,
        );
        await this.runProcess(task, 'git', ['apply', '--binary', '-'], workspace, changes);
      }
    } finally {
      rmSync(index, { force: true });
    }
  }

  async result(id: string): Promise<TaskResult> {
    const task = this.requireTask(id);
    if (this.active.has(id) || this.operationLocks.has(id)) throw new Error('任务仍在执行');
    this.operationLocks.add(id);
    try {
      task.result = await this.captureResult(task);
      this.persist(task);
      return { ...task.result };
    } finally {
      this.operationLocks.delete(id);
    }
  }

  async publish(id: string, version: string, automatic = false): Promise<AgentTask> {
    const task = this.requireTask(id);
    this.options.guard?.('publish', task);
    if ((!automatic && this.active.has(id)) || this.operationLocks.has(id) || task.archivedAt)
      throw new Error('任务活动中或已归档');
    if (['failed', 'cancelled', 'interrupted'].includes(task.status))
      throw new Error('请先恢复或完成新轮次后再发布');
    if (task.policy === 'local') throw new Error('该任务仅保留本地成果');
    if (task.verification?.some((check) => check.exitCode !== 0))
      throw new Error('验证失败，请修复后再发布');
    if (task.reviewReport?.status === 'failed')
      throw new Error('独立审查执行失败，请继续一轮处理后再发布');
    this.operationLocks.add(id);
    try {
      const current = await this.captureResult(task);
      if (!task.result || version !== current.version || task.result.version !== current.version)
        throw new Error('成果版本已变化，请重新审查');
      task.publication = { status: 'publishing', version };
      this.persist(task);
      const workspace = this.assertWorkspace(task);
      const branch = (
        await this.runProcess(task, 'git', ['branch', '--show-current'], workspace)
      ).stdout.trim();
      if (branch !== task.agentBranch) throw new Error('工作区分支已变化，请先核对');
      const localConfig = await this.runProcess(
        task,
        'git',
        ['config', '--local', '--null', '--list'],
        workspace,
        undefined,
        false,
        this.safeEnvironment(),
      );
      if (
        localConfig.stdout
          .split('\0')
          .some((entry) =>
            /^(url\.|credential\.|http\.|core\.sshcommand\n|remote\.[^\n]+\.pushurl\n)/i.test(
              entry,
            ),
          )
      )
        throw new Error('工作区包含影响发布认证或目标的 Git 配置，请先核对并移除');
      this.assertPushBranchAllowed(task, task.agentBranch!);
      if (current.diff) {
        const headTree = (
          await this.runProcess(task, 'git', ['rev-parse', 'HEAD^{tree}'], workspace)
        ).stdout.trim();
        let commitId = current.head;
        if (headTree !== current.tree) {
          const commit = await this.runProcess(
            task,
            'git',
            [
              '-c',
              'user.name=cpx-agent',
              '-c',
              'user.email=cpx-agent@users.noreply.github.com',
              'commit-tree',
              current.tree,
              '-p',
              current.head,
            ],
            workspace,
            `${buildCommitTitle(task.prompt)}\n`,
          );
          commitId = commit.stdout.trim();
          await this.runProcess(
            task,
            'git',
            ['update-ref', `refs/heads/${task.agentBranch}`, commitId, current.head],
            workspace,
          );
        }
        await this.runProcess(task, 'git', ['read-tree', current.tree], workspace);
        // A second snapshot detects concurrent filesystem changes before any remote write.
        const after = await this.captureResult(task);
        if (after.tree !== current.tree) throw new Error('发布期间工作区发生变化，请重新审查');
        task.result = after;
        await this.runGitHubProcess(
          task,
          'git',
          ['push', 'origin', `${commitId}:refs/heads/${task.agentBranch}`],
          workspace,
        );
        const existing = await this.runGitHubProcess(
          task,
          'gh',
          [
            'pr',
            'list',
            '--state',
            'open',
            '--head',
            task.agentBranch!,
            '--json',
            'url',
            '--limit',
            '1',
          ],
          workspace,
        );
        const found = JSON.parse(existing.stdout || '[]') as { url: string }[];
        if (found[0]?.url) task.pullRequestUrl = found[0].url;
        if (!task.pullRequestUrl) {
          const args = [
            'pr',
            'create',
            '--head',
            task.agentBranch!,
            '--title',
            buildCommitTitle(task.prompt),
            '--body',
            `cpx task: ${task.id}\n\n${task.lastAgentResponse?.slice(0, 8000) || task.prompt.slice(0, 8000)}`,
          ];
          if (task.baseBranch) args.push('--base', task.baseBranch);
          const created = await this.runGitHubProcess(task, 'gh', args, workspace);
          task.pullRequestUrl = created.stdout.match(
            /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
          )?.[0];
          if (!task.pullRequestUrl) throw new Error('PR 创建结果未知，请核对远端后重试');
        }
      }
      task.publication = { status: 'published', version: task.result?.version };
      if (task.status === 'review') task.status = 'completed';
      this.persist(task);
      return this.snapshot(task);
    } catch (error) {
      task.publication = { status: 'failed', version, error: this.redact(String(error)) };
      this.persist(task);
      throw error;
    } finally {
      this.operationLocks.delete(id);
    }
  }

  async cleanupPreview(id: string): Promise<{ version: string; safe: boolean; reason: string }> {
    const task = this.requireTask(id);
    const result = await this.result(id);
    const safe = Boolean(
      task.archivedAt &&
      !this.active.has(id) &&
      (!result.diff ||
        (task.publication?.status === 'published' && task.publication.version === result.version)),
    );
    return {
      version: result.version,
      safe,
      reason: safe
        ? '已归档且没有唯一未交付成果'
        : '请先归档并发布或备份唯一成果；活动任务不能清理',
    };
  }

  async cleanup(id: string, version: string): Promise<void> {
    const task = this.requireTask(id);
    const preview = await this.cleanupPreview(id);
    if (!preview.safe || version !== preview.version) throw new Error('清理条件或成果版本已变化');
    this.operationLocks.add(id);
    try {
      const workspace = this.assertWorkspace(task);
      await this.runProcess(
        { ...task, status: 'completed' },
        'git',
        ['worktree', 'remove', '--force', workspace],
        task.repositoryPath!,
      );
      task.workspace = undefined;
      this.persist(task);
    } finally {
      this.operationLocks.delete(id);
    }
  }

  private validateRequest(request: AgentTaskRequest): {
    configurations: AgentModelConfiguration[];
    repository: string;
    baseBranch?: string;
    taskBranch?: string;
    prompt: string;
    createPullRequest: boolean;
  } {
    const configurations = normalizeConfigurations(request);
    const repository = normalizeRepository(request.repository);
    const prompt = validatePrompt(request.prompt);
    const baseBranch = normalizeBranchName(request.baseBranch, '基础分支');
    const taskBranch = normalizeBranchName(request.taskBranch, '新分支');
    if (taskBranch && taskBranch === baseBranch) {
      throw new Error('新分支不能与基础分支同名');
    }
    return {
      configurations,
      repository,
      baseBranch,
      taskBranch,
      prompt,
      createPullRequest: Boolean(request.createPullRequest),
    };
  }

  private async execute(task: AgentTask, reuseWorkspace = false): Promise<void> {
    const turn = this.currentTurn(task);
    const resumeThreadId = reuseWorkspace ? task.threadId : undefined;
    this.deadlines.set(task.id, Date.now() + (task.timeoutMs ?? this.options.timeoutMs ?? 1800000));
    try {
      this.options.guard?.('execute', task);
      if (this.runtime().freeBytes < (this.options.minFreeBytes ?? 0))
        throw new Error('磁盘可用空间不足');
      task.status = 'preparing';
      this.persist(task);
      task.startedAt ??= Date.now();
      task.updatedAt = Date.now();
      turn.status = 'running';
      turn.startedAt = Date.now();
      const workspace = reuseWorkspace
        ? this.assertWorkspace(task)
        : await this.prepareWorkspace(task);
      if (reuseWorkspace) {
        const branch = await this.runProcess(task, 'git', ['branch', '--show-current'], workspace);
        if (branch.stdout.trim() && branch.stdout.trim() !== task.agentBranch)
          throw new Error('工作区分支已改变，拒绝恢复');
      }

      task.status = 'running';
      task.updatedAt = Date.now();
      this.persist(task);
      if (task.executorId) {
        if (!this.remoteRunner) throw new Error('远程执行器未启用');
        task.result = await this.captureResult(task);
        const remote = await this.remoteRunner(this.snapshot(task));
        this.assertNotCancelled(task);
        await this.importRemoteResult(task, remote.patch);
        task.lastAgentResponse = turn.response = this.redact(remote.response);
      } else if (this.options.runAgent) await this.options.runAgent(task, workspace);
      else await this.runAgentWithFallback(task, workspace, resumeThreadId);
      if (task.policy) {
        task.status = 'verifying';
        this.persist(task);
        task.reviewReport = undefined;
        if (task.independentReview) {
          this.options.guard?.('execute', task);
          const startedAt = Date.now();
          this.addLog(task, 'system', '开始独立只读审查；审查意见不替代验证或用户批准。');
          const reviewer: AgentTask = {
            ...this.snapshot(task),
            turns: [this.createTurn('independent review', Date.now())],
            logs: [],
            threadId: undefined,
            lastAgentResponse: undefined,
          };
          const configuration =
            task.configurations.find(
              (candidate) =>
                candidate.id === task.attempts[task.attempts.length - 1]?.configurationId,
            ) ?? task.configurations[0];
          const adapter = AGENT_ADAPTERS.codex;
          const env = this.safeEnvironment();
          adapter.configureEnvironment(
            env,
            this.secrets.openaiApiKey || process.env.CODEX_API_KEY,
            undefined,
          );
          const args = adapter.buildArgs(
            configuration.model,
            undefined,
            configuration.reasoningEffort,
          );
          args.splice(
            args.length - 1,
            0,
            '--config',
            'sandbox_mode="read-only"',
            '--config',
            'sandbox_workspace_write.network_access=false',
            '--config',
            'approval_policy="never"',
            '--config',
            'mcp_servers.cpx_platform.enabled=false',
            '--config',
            'mcp_servers.cpx_extensions.enabled=false',
          );
          try {
            await this.runProcess(
              reviewer,
              adapter.command,
              args,
              workspace,
              `独立审查当前任务相对基础提交 ${task.baseCommit} 的全部代码改动（包括未提交与新文件）。只读，不修改文件、不推送、不调用外部写工具。指出具体文件、风险、未覆盖的验收与建议；没有证据时明确说明。用户目标：${task.prompt}`,
              true,
              env,
              adapter.useShellOnWindows,
            );
            task.reviewReport = {
              status: 'completed',
              response: reviewer.lastAgentResponse || '审查未返回文本，请人工检查',
              startedAt,
              endedAt: Date.now(),
            };
          } catch (error) {
            this.assertNotCancelled(task);
            task.reviewReport = {
              status: 'failed',
              error: this.redact(String(error)),
              startedAt,
              endedAt: Date.now(),
            };
          }
          this.persist(task);
        }
        task.verification = [];
        for (const check of task.verificationCommands ?? []) {
          const startedAt = Date.now();
          try {
            const output = await this.runProcess(
              task,
              check.command,
              check.args,
              workspace,
              undefined,
              false,
              this.safeEnvironment(),
              false,
              check.timeoutMs ?? 300000,
            );
            task.verification.push({
              ...check,
              exitCode: 0,
              output: this.redact((output.stdout + output.stderr).slice(-65536)),
              startedAt,
              endedAt: Date.now(),
            });
          } catch (error) {
            this.assertNotCancelled(task);
            task.verification.push({
              ...check,
              exitCode: error instanceof AgentProcessError ? error.exitCode : null,
              output: this.redact(
                error instanceof AgentProcessError ? error.stderr + error.stdout : String(error),
              ),
              startedAt,
              endedAt: Date.now(),
            });
          }
          this.persist(task);
        }
        task.result = await this.captureResult(task);
      }
      this.assertNotCancelled(task);

      if (task.createPullRequest && !task.policy) {
        task.status = 'publishing';
        task.updatedAt = Date.now();
        await this.publishPullRequest(task, workspace);
      } else if (
        task.policy === 'auto' &&
        task.reviewReport?.status !== 'failed' &&
        !task.verification?.some((check) => check.exitCode !== 0)
      ) {
        try {
          await this.publish(task.id, task.result!.version, true);
        } catch (error) {
          this.addLog(task, 'system', `成果已保存，发布失败：${String(error)}`);
        }
      }

      task.status = task.policy === 'review' ? 'review' : 'completed';
      task.updatedAt = Date.now();
      task.completedAt = Date.now();
      turn.status = 'completed';
      turn.completedAt = task.completedAt;
      this.addLog(
        task,
        'system',
        task.pullRequestUrl
          ? `任务完成：${task.pullRequestUrl}`
          : '任务完成，改动保留在本地工作区。',
      );
      this.notifyTerminal(task);
    } catch (error) {
      if (task.status === 'cancelled' || task.status === 'interrupted') {
        return;
      }
      const message = this.redact(error instanceof Error ? error.message : String(error));
      task.status =
        error instanceof Error && error.name === 'RemoteExecutionUnknownError'
          ? 'interrupted'
          : 'failed';
      task.error = message;
      task.updatedAt = Date.now();
      task.completedAt = Date.now();
      turn.status = 'failed';
      turn.error = message;
      turn.completedAt = task.completedAt;
      this.addLog(task, 'system', `任务失败：${message}`);
      this.logger.error(`任务 ${task.id} 失败: ${message}`);
      this.notifyTerminal(task);
    } finally {
      this.executionConfigurations.delete(task.id);
      this.deadlines.delete(task.id);
      this.persist(task);
    }
  }

  private async prepareWorkspace(task: AgentTask): Promise<string> {
    const { owner, repository } = repositoryCoordinates(task.repository);
    const repositoryPath = join(this.repositoryRoot, owner, repository);
    const workspace = join(this.workspaceRoot, task.id);
    task.repositoryPath = repositoryPath;

    await this.withRepositoryLock(`${owner}/${repository}`, async () => {
      this.assertNotCancelled(task);
      if (!existsSync(join(repositoryPath, '.git'))) {
        const ownerPath = dirname(repositoryPath);
        mkdirSync(ownerPath, { recursive: true });
        this.addLog(task, 'system', `正在完整克隆仓库缓存：${owner}/${repository}`);
        await this.runGitHubProcess(
          task,
          'git',
          ['clone', '--no-checkout', task.repository, repositoryPath],
          ownerPath,
        );
      } else {
        await this.runGitHubProcess(
          task,
          'git',
          ['remote', 'set-url', 'origin', task.repository],
          repositoryPath,
        );
      }
      this.assertNotCancelled(task);
      this.addLog(task, 'system', `正在同步仓库缓存：${owner}/${repository}`);
      await this.runGitHubProcess(
        task,
        'git',
        ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
        repositoryPath,
      );
      await this.runProcess(task, 'git', ['worktree', 'prune'], repositoryPath);

      const branch = task.taskBranch || `cpx/task-${task.id.slice(0, 8)}`;
      if (task.startCommit && !/^[a-f0-9]{40}$/.test(task.startCommit))
        throw new Error('基础提交无效');
      const startPoint =
        task.startCommit ||
        (task.baseBranch ? `refs/remotes/origin/${task.baseBranch}` : 'refs/remotes/origin/HEAD');
      await this.runProcess(
        task,
        'git',
        ['worktree', 'add', '-b', branch, workspace, startPoint],
        repositoryPath,
      );
      task.workspace = workspace;
      task.agentBranch = branch;
      if (task.policy)
        task.baseCommit = (
          await this.runProcess(task, 'git', ['rev-parse', 'HEAD'], workspace)
        ).stdout.trim();
      if (task.seedPatch)
        await this.runProcess(task, 'git', ['apply', '--binary', '-'], workspace, task.seedPatch);
      task.seedPatch = undefined;
      this.persist(task);
    });
    this.assertNotCancelled(task);
    return workspace;
  }

  /**
   * 按模型配置顺序尝试每个 Agent。额度类(rate_limit/auth)失败才切换;
   * 其他失败立即抛出。workspace 在循环外创建一次,失败时复用(不 reset)。
   */
  private async runAgentWithFallback(
    task: AgentTask,
    workspace: string,
    resumeThreadId?: string,
  ): Promise<void> {
    const configurations = this.executionConfigurations.get(task.id) ?? task.configurations;
    for (let i = 0; i < Math.min(configurations.length, 5); i++) {
      this.assertNotCancelled(task);
      const configuration = configurations[i];
      const provider = configuration.provider;
      const adapter = AGENT_ADAPTERS[provider];

      const attempt: AgentAttempt = {
        configurationId: configuration.id,
        provider,
        model: configuration.model,
        startedAt: Date.now(),
        status: 'running',
      };
      task.attempts.push(attempt);
      this.addLog(
        task,
        'system',
        `${formatConfigurationLabel(configuration)} 开始执行(第 ${i + 1}/${configurations.length} 个模型配置)。`,
      );

      try {
        await this.runAgent(task, workspace, configuration, resumeThreadId);
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
        attempt.error = this.redact(summary);
        this.addLog(task, 'system', `${adapter.displayName} 失败[${kindLabel(kind)}]: ${summary}`);

        const isFallbackEligible = kind === 'rate_limit' || kind === 'auth';
        const isLast = i === configurations.length - 1;

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
        const next = configurations[i + 1];
        this.addLog(task, 'system', `将切换到下一项模型配置: ${formatConfigurationLabel(next)}`);
      }
    }
  }

  private async runAgent(
    task: AgentTask,
    workspace: string,
    configuration: AgentModelConfiguration | PublicAgentModelConfiguration,
    resumeThreadId?: string,
  ): Promise<void> {
    const provider = configuration.provider;
    const adapter = AGENT_ADAPTERS[provider];
    const env = task.policy ? this.safeEnvironment() : this.agentGitHubEnvironment(task);
    const configuredApiKey = 'apiKey' in configuration ? configuration.apiKey : undefined;
    const legacyApiKey = this.secrets.openaiApiKey;
    adapter.configureEnvironment(
      env,
      configuredApiKey || legacyApiKey || process.env.CODEX_API_KEY,
      configuration.baseUrl,
    );
    const args = resumeThreadId
      ? adapter.buildResumeArgs(
          resumeThreadId,
          configuration.model,
          configuration.baseUrl,
          configuration.reasoningEffort,
        )
      : adapter.buildArgs(
          configuration.model,
          configuration.baseUrl,
          configuration.reasoningEffort,
        );
    if (task.policy) {
      args.splice(
        Math.max(2, args.length - (resumeThreadId ? 2 : 1)),
        0,
        '--config',
        'sandbox_mode="workspace-write"',
        '--config',
        'sandbox_workspace_write.network_access=false',
        '--config',
        'approval_policy="never"',
      );
      appendGitConfig(env, 'credential.helper', '');
      appendGitConfig(env, 'core.hooksPath', this.ensurePushGuard(task));
      env.GIT_TERMINAL_PROMPT = '0';
    }
    const platformTools = this.platformToolContexts.get(task.id);
    if (platformTools) {
      this.configurePlatformTools(args, env, platformTools, Boolean(resumeThreadId));
    }
    const extensions = this.options.extensionTools?.(task);
    if (extensions) {
      env.CPX_EXTENSION_URL = extensions.url;
      env.CPX_EXTENSION_TOKEN = extensions.token;
      env.CPX_EXTENSION_TASK = task.id;
      const compiled = join(__dirname, 'extensionMcpServer.js');
      const serverArgs = existsSync(compiled)
        ? [compiled]
        : [require.resolve('tsx/cli'), join(__dirname, 'extensionMcpServer.ts')];
      args.splice(
        Math.max(2, args.length - (resumeThreadId ? 2 : 1)),
        0,
        '--config',
        `mcp_servers.cpx_extensions.command=${JSON.stringify(process.execPath)}`,
        '--config',
        `mcp_servers.cpx_extensions.args=${JSON.stringify(serverArgs)}`,
        '--config',
        'mcp_servers.cpx_extensions.env_vars=["CPX_EXTENSION_URL","CPX_EXTENSION_TOKEN","CPX_EXTENSION_TASK"]',
      );
    }
    await this.runProcess(
      task,
      adapter.command,
      args,
      workspace,
      buildPrompt(task, Boolean(platformTools)),
      true,
      env,
      adapter.useShellOnWindows,
    );
  }

  private configurePlatformTools(
    args: string[],
    env: NodeJS.ProcessEnv,
    context: AgentPlatformToolContext,
    resume: boolean,
  ): void {
    env.CPX_PLATFORM_TOOL_URL = context.endpoint;
    env.CPX_PLATFORM_TOOL_TOKEN = context.token;
    env.CPX_PLATFORM_TOOL_TASK_ID = context.taskId;
    env.CPX_PLATFORM_NAME = context.platform;

    const server = platformMcpServerCommand();
    const config = [
      `mcp_servers.cpx_platform.command=${JSON.stringify(server.command)}`,
      `mcp_servers.cpx_platform.args=${JSON.stringify(server.args)}`,
      'mcp_servers.cpx_platform.env_vars=["CPX_PLATFORM_TOOL_URL","CPX_PLATFORM_TOOL_TOKEN","CPX_PLATFORM_TOOL_TASK_ID","CPX_PLATFORM_NAME"]',
      'mcp_servers.cpx_platform.enabled_tools=["platform_get_context","platform_send_message","github_list_repositories","github_list_branches","task_create","task_list","task_status","task_continue","task_cancel"]',
      'mcp_servers.cpx_platform.default_tools_approval_mode="approve"',
      'mcp_servers.cpx_platform.required=true',
    ];
    const insertionIndex = resume ? Math.max(3, args.length - 2) : Math.max(2, args.length - 1);
    args.splice(insertionIndex, 0, ...config.flatMap((value) => ['--config', value]));
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
    if (status.stdout.trim()) {
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
    }

    const baseRef = task.baseBranch
      ? `refs/remotes/origin/${task.baseBranch}`
      : 'refs/remotes/origin/HEAD';
    const ahead = await this.runProcess(
      task,
      'git',
      ['rev-list', '--count', `${baseRef}..HEAD`],
      workspace,
    );
    if (Number.parseInt(ahead.stdout.trim(), 10) <= 0) {
      this.addLog(task, 'system', 'Agent 没有产生文件改动，无需创建 Pull Request。');
      return;
    }

    this.assertPushBranchAllowed(task, task.agentBranch!);
    await this.runGitHubProcess(
      task,
      'git',
      ['push', '-u', 'origin', task.agentBranch!],
      workspace,
    );
    if (task.pullRequestUrl) {
      this.addLog(task, 'system', `已将新提交推送到现有 Pull Request：${task.pullRequestUrl}`);
      return;
    }
    const prArgs = ['pr', 'create', '--fill', '--head', task.agentBranch!];
    if (task.baseBranch) {
      prArgs.push('--base', task.baseBranch);
    }
    const pr = await this.runGitHubProcess(task, 'gh', prArgs, workspace);
    const url = pr.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (!url) {
      throw new Error('gh 已执行，但没有返回 Pull Request URL');
    }
    task.pullRequestUrl = url;
  }

  /**
   * 仅向需要访问 GitHub 的 git/gh 子进程注入凭据。
   * Token 由 askpass 脚本从环境变量读取，不会出现在 Git URL、命令参数或任务日志中。
   */
  private githubEnvironment(): NodeJS.ProcessEnv {
    const token =
      this.secrets.githubToken?.trim() ||
      process.env.GH_TOKEN?.trim() ||
      process.env.AGENT_GITHUB_TOKEN?.trim();
    if (!token) return process.env;

    return {
      ...process.env,
      GH_TOKEN: token,
      CPX_GITHUB_TOKEN: token,
      GIT_ASKPASS: this.ensureGitAskPass(),
      GIT_ASKPASS_REQUIRE: 'force',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  /** 给 Coding Agent 提供 Git push 认证，同时用 pre-push hook 拦截主分支。 */
  private agentGitHubEnvironment(task: AgentTask): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.githubEnvironment() };
    // Coding Agent 只需要 Git 的 askpass 认证，不直接开放 gh 的隐式认证入口。
    delete env.GH_TOKEN;
    appendGitConfig(env, 'core.hooksPath', this.ensurePushGuard(task));
    return env;
  }

  private ensurePushGuard(task: AgentTask): string {
    const hooksPath = join(this.workspaceRoot, '.git-hooks', task.id);
    const hookPath = join(hooksPath, 'pre-push');
    mkdirSync(hooksPath, { recursive: true, mode: 0o700 });
    const protectedRefs = this.protectedBranches(task)
      .map((branch) => `'refs/heads/${branch.replace(/'/g, "'\\''")}'`)
      .join('|');
    const content = [
      '#!/bin/sh',
      'while read local_ref local_oid remote_ref remote_oid; do',
      '  case "$remote_ref" in',
      `    ${protectedRefs})`,
      '      echo "cpx: 禁止直接推送到主分支 $remote_ref" >&2',
      '      exit 1',
      '      ;;',
      '  esac',
      'done',
      'exit 0',
      '',
    ].join('\n');
    writeFileSync(hookPath, content, { encoding: 'utf8', mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(hookPath, 0o700);
    return hooksPath;
  }

  private protectedBranches(task: AgentTask): string[] {
    return [
      ...new Set(
        [
          ...DEFAULT_PROTECTED_BRANCHES,
          ...(this.options.protectedBranches ?? []),
          task.baseBranch,
        ].filter(Boolean),
      ),
    ] as string[];
  }

  private assertPushBranchAllowed(task: AgentTask, branch: string): void {
    if (this.protectedBranches(task).includes(branch)) {
      throw new Error(`禁止直接推送到主分支 ${branch}`);
    }
  }

  /**
   * 访问 GitHub 的 git/gh 命令必须经过此入口，统一注入 Token 与 AskPass。
   * 本地 Git 操作继续使用 runProcess，避免未来新增远程命令时重复凭据装配逻辑。
   */
  private runGitHubProcess(
    task: AgentTask,
    command: 'git' | 'gh',
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string }> {
    this.options.fence?.();
    const pinned = [...args];
    const env = { ...this.githubEnvironment() };
    if (task.policy) {
      if (command === 'git' && pinned[0] === 'push') {
        const index = pinned.indexOf('origin');
        if (index !== -1) pinned[index] = task.repository;
      }
      if (command === 'gh' && !pinned.includes('--repo')) {
        const coordinates = repositoryCoordinates(task.repository);
        pinned.push('--repo', `${coordinates.owner}/${coordinates.repository}`);
      }
      const hooks = join(this.workspaceRoot, '.publisher-hooks');
      mkdirSync(hooks, { recursive: true, mode: 0o700 });
      appendGitConfig(env, 'core.hooksPath', hooks);
    }
    if (this.options.runGitHub) return this.options.runGitHub(task, command, pinned, cwd);
    return this.runProcess(task, command, pinned, cwd, undefined, false, env);
  }

  private ensureGitAskPass(): string {
    if (this.gitAskPassPath) return this.gitAskPassPath;

    const windows = process.platform === 'win32';
    const path = join(this.workspaceRoot, windows ? '.github-askpass.cmd' : '.github-askpass.sh');
    if (!existsSync(path)) {
      const content = windows
        ? [
            '@echo off',
            'echo %~1 | findstr /I "username" >nul',
            'if not errorlevel 1 (echo x-access-token) else (echo %CPX_GITHUB_TOKEN%)',
            '',
          ].join('\r\n')
        : [
            '#!/bin/sh',
            'case "$1" in',
            '  *Username*|*username*) printf "%s\\n" "x-access-token" ;;',
            '  *) printf "%s\\n" "$CPX_GITHUB_TOKEN" ;;',
            'esac',
            '',
          ].join('\n');
      writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
      if (!windows) chmodSync(path, 0o700);
    }
    this.gitAskPassPath = path;
    return path;
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
    timeoutMs = task.timeoutMs ?? this.options.timeoutMs ?? 1800000,
  ): Promise<{ stdout: string; stderr: string }> {
    this.options.fence?.();
    this.assertNotCancelled(task);
    if (!isTerminal(task.status) && this.deadlines.has(task.id))
      timeoutMs = Math.max(1, Math.min(timeoutMs, this.deadlines.get(task.id)! - Date.now()));
    this.addLog(task, 'system', `$ ${command} ${args.filter((arg) => arg !== '-').join(' ')}`);

    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        shell: useShellOnWindows && process.platform === 'win32',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.processes.set(task.id, child);

      let timeout = false;
      let overflow = false;
      const timer = setTimeout(() => {
        timeout = true;
        this.killProcess(task.id);
      }, timeoutMs);
      timer.unref();
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
          if (captureAgentJson) {
            const threadId = extractAgentThreadId(line);
            if (threadId) task.threadId = threadId;
            const response = extractAgentResponse(line);
            if (response) {
              const finalResponse = this.redact(response.slice(0, 16_384));
              task.lastAgentResponse = finalResponse;
              this.currentTurn(task).response = finalResponse;
            }
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
        if (Buffer.byteLength(stdout) + chunk.length > 8 * 1024 * 1024) {
          overflow = true;
          this.killProcess(task.id);
          return;
        }
        stdout += text;
        stdoutBuffer += text;
        flush('stdout');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) {
          overflow = true;
          this.killProcess(task.id);
          return;
        }
        stderr += text;
        stderrBuffer += text;
        flush('stderr');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        this.processes.delete(task.id);
        reject(new Error(`无法启动 ${command}: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        flush('stdout', true);
        flush('stderr', true);
        this.processes.delete(task.id);
        if (task.status === 'cancelled' || task.status === 'interrupted') {
          reject(new Error('任务已取消或中断'));
          return;
        }
        if (timeout || overflow) {
          reject(new Error(timeout ? '执行超时' : '输出超过 8 MiB 上限'));
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
    if (task.status === 'cancelled' || task.status === 'interrupted') {
      throw new Error('任务已取消或中断');
    }
  }

  private addLog(task: AgentTask, stream: AgentTaskLog['stream'], message: string): void {
    task.logs.push({
      timestamp: Date.now(),
      stream,
      message: this.redact(message).slice(0, 65536),
    });
    const limit = this.options.logLimit ?? MAX_LOG_ENTRIES;
    if (task.logs.length > limit) {
      task.logs.splice(0, task.logs.length - limit);
    }
    task.updatedAt = Date.now();
    this.persist(this.tasks.get(task.id) ?? task);
  }

  private snapshot(task: AgentTask): AgentTask {
    return JSON.parse(JSON.stringify(task)) as AgentTask;
  }

  private createTurn(prompt: string, createdAt: number): AgentTaskTurn {
    return {
      id: randomUUID(),
      prompt,
      status: 'queued',
      createdAt,
    };
  }

  private currentTurn(task: AgentTask): AgentTaskTurn {
    const turn = task.turns[task.turns.length - 1];
    if (!turn) throw new Error('任务轮次不存在');
    return turn;
  }

  private async withRepositoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.repositoryLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.repositoryLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.repositoryLocks.get(key) === tail) {
        this.repositoryLocks.delete(key);
      }
    }
  }

  private notifyTerminal(task: AgentTask): void {
    if (this.active.has(task.id)) return;
    if (task.status === 'cancelled' || task.status === 'interrupted') task.stopConfirmed = true;
    this.persist(task);
    this.options.onTerminal?.(this.snapshot(task));
    const waiters = this.terminalWaiters.get(task.id);
    if (!waiters) {
      return;
    }
    const snapshot = this.snapshot(task);
    this.terminalWaiters.delete(task.id);
    for (const resolvePromise of waiters) {
      resolvePromise(snapshot);
    }
  }
}

function isTerminal(status: AgentTaskStatus): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'review'].includes(status);
}

export function normalizeRepository(input: string): string {
  const value = input?.trim();
  if (!value) {
    throw new Error('GitHub 仓库不能为空');
  }
  const coordinates = value
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');
  const parts = coordinates.split('/');
  if (parts.length !== 2 || parts.some((part) => !/[a-zA-Z0-9]/.test(part)))
    throw new Error('仅支持有效的 GitHub owner/repository 地址');
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

export function repositoryCoordinates(input: string): { owner: string; repository: string } {
  const normalized = normalizeRepository(input);
  const match = normalized.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
  );
  if (!match) {
    throw new Error('无法识别 GitHub 仓库目录');
  }
  return { owner: match[1], repository: match[2] };
}

function validatePrompt(input: string | undefined): string {
  const prompt = input?.trim();
  if (!prompt) {
    throw new Error('任务指令不能为空');
  }
  if (prompt.length > 20_000) {
    throw new Error('任务指令不能超过 20000 个字符');
  }
  return prompt;
}

function normalizeBranchName(input: string | undefined, label: string): string | undefined {
  const value = input?.trim() || undefined;
  if (!value) return undefined;
  const components = value.split('/');
  const invalid =
    value.length > 255 ||
    !BRANCH_PATTERN.test(value) ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    components.some((component) => component.startsWith('.'));
  if (invalid) {
    throw new Error(`${label}名称无效`);
  }
  return value;
}

function buildCommitTitle(prompt: string): string {
  const summary = prompt
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `feat: ${summary || 'complete agent task'}`;
}

function buildPrompt(task: AgentTask, hasPlatformTools = false): string {
  const protectedBranches = [
    ...new Set([...DEFAULT_PROTECTED_BRANCHES, task.baseBranch].filter(Boolean)),
  ].join('、');
  const instructions = [
    '你正在由 cpx 开发控制台执行任务。',
    '请只在当前 Git 仓库中工作，先理解现有代码，再实现用户目标并运行相关验证。',
    task.policy && task.policy !== 'auto'
      ? `只修改当前工作区，不得推送。当前任务分支为 ${task.agentBranch}；严禁向 ${protectedBranches} 推送。`
      : `允许提交并推送非主分支，当前任务分支为 ${task.agentBranch}；严禁向 ${protectedBranches} 直接 push、force push，严禁绕过 pre-push hook。`,
    '不要自行创建 PR 或修改仓库外文件；需要 PR 时由 cpx 在任务完成后创建或更新。',
  ];
  if (hasPlatformTools) {
    instructions.push(
      '这个任务来自消息平台。任务建立后的自然语言要求都由你在当前会话中理解和执行。',
      '你可以使用 cpx_platform MCP 工具读取平台上下文、查询 GitHub 或管理当前用户的 cpx 任务，并在确有必要时向原会话主动发送阶段性消息；不得尝试改变目标会话或用户。',
      'cpx 会自动回传你的最终回复，因此不要用平台工具重复发送最终总结。',
    );
  }
  instructions.push(
    '完成后总结改动、验证结果和仍存在的风险。',
    '',
    ...(task.context ? ['项目上下文（不授予额外权限）：', task.context, ''] : []),
    `用户任务：${task.prompt}`,
  );
  return instructions.join('\n');
}

function appendGitConfig(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const index = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  env[`GIT_CONFIG_KEY_${index}`] = key;
  env[`GIT_CONFIG_VALUE_${index}`] = value;
  env.GIT_CONFIG_COUNT = String(index + 1);
}

function platformMcpServerCommand(): { command: string; args: string[] } {
  const compiled = join(__dirname, 'platformMcpServer.js');
  if (existsSync(compiled)) {
    return { command: process.execPath, args: [compiled] };
  }
  const source = join(__dirname, 'platformMcpServer.ts');
  return { command: process.execPath, args: [require.resolve('tsx/cli'), source] };
}

function normalizeConfigurations(request: AgentTaskRequest): AgentModelConfiguration[] {
  if (request.configurations) {
    if (request.configurations.length === 0) {
      throw new Error('模型配置不能为空');
    }
    if (request.configurations.length > 20) {
      throw new Error('模型配置不能超过 20 条');
    }
    const ids = new Set<string>();
    return request.configurations.map((configuration) => {
      const id = configuration.id?.trim();
      if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
        throw new Error('模型配置 ID 无效');
      }
      if (ids.has(id)) {
        throw new Error(`模型配置 ID 重复: ${id}`);
      }
      ids.add(id);
      if (!ALL_PROVIDERS.includes(configuration.provider)) {
        throw new Error(`provider 必须是 ${ALL_PROVIDERS.join('、')} 之一`);
      }
      const model = configuration.model?.trim() || undefined;
      if (model && !MODEL_PATTERN.test(model)) {
        throw new Error('模型名称包含不支持的字符');
      }
      const apiKey = configuration.apiKey?.trim() || undefined;
      if (apiKey && (apiKey.length > 4096 || /\s/.test(apiKey))) {
        throw new Error('API Key 格式无效');
      }
      const baseUrl = normalizeBaseUrl(configuration.baseUrl);
      const name = configuration.name?.trim() || undefined;
      if (name && (name.length > 60 || /[\r\n\0]/.test(name))) {
        throw new Error('配置名称格式无效');
      }
      const reasoningEffort = normalizeReasoningEffort(configuration.reasoningEffort);
      return {
        id,
        ...(name ? { name } : {}),
        provider: configuration.provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        apiKey,
      };
    });
  }

  const providers = normalizeProviders(request.provider, request.providers);
  const model = request.model?.trim() || undefined;
  if (model && !MODEL_PATTERN.test(model)) {
    throw new Error('模型名称包含不支持的字符');
  }
  return providers.map((provider, index) => ({
    id: `legacy-${index + 1}-${provider}`,
    provider,
    model,
  }));
}

function normalizeReasoningEffort(value?: AgentReasoningEffort): AgentReasoningEffort | undefined {
  if (!value) return undefined;
  const supported: AgentReasoningEffort[] = [
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ];
  if (!supported.includes(value)) {
    throw new Error('Codex 推理强度无效');
  }
  return value;
}

function normalizeBaseUrl(input: string | undefined): string | undefined {
  const value = input?.trim().replace(/\/+$/, '') || undefined;
  if (!value) return undefined;
  if (value.length > 2048) {
    throw new Error('Base URL 不能超过 2048 个字符');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Base URL 必须是有效的 HTTP(S) 地址');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error('Base URL 必须是无内嵌凭据和片段的 HTTP(S) 地址');
  }
  return value;
}

/**
 * 归一化 providers 列表:去重保序,校验每项合法。
 * providers 优先;缺省时回退到 [provider]。两者皆空时抛错。
 */
function normalizeProviders(
  provider: CodingAgentProvider | undefined,
  providers: CodingAgentProvider[] | undefined,
): CodingAgentProvider[] {
  const source = providers && providers.length > 0 ? providers : provider ? [provider] : undefined;
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

function formatConfigurationLabel(
  configuration: PublicAgentModelConfiguration | AgentModelConfiguration,
): string {
  const displayName = AGENT_ADAPTERS[configuration.provider].displayName;
  return configuration.model ? `${displayName} / ${configuration.model}` : displayName;
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

function extractAgentThreadId(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const threadId = event.thread_id ?? event.threadId;
    return typeof threadId === 'string' && threadId.trim() ? threadId.trim() : undefined;
  } catch {
    return undefined;
  }
}

function extractAgentResponse(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === 'result' && typeof event.result === 'string') {
      return event.result.trim() || undefined;
    }
    if (event.type === 'assistant') {
      const message = event.message as
        { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = message?.content
        ?.filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text)
        .join('\n')
        .trim();
      return text || undefined;
    }
    const item = event.item as { type?: string; text?: string } | undefined;
    if (item?.type === 'agent_message' && item.text?.trim()) {
      return item.text.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}
