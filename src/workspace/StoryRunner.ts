import { randomUUID } from 'crypto';
import { join } from 'path';
import { AgentModelConfiguration, AgentTask, AgentTaskManager } from '../agents/AgentTaskManager';
import { CodexSandboxMode, configuredCodexSandbox } from '../agents/CodexSandbox';
import { Logger } from '../utils/Logger';
import { localStorySummaries, readLocalStory } from './Story';
import { inspectWorkspace, workspaceGitDirectory } from './Workspace';
import { SessionTurn, WorkspaceSessions, terminalStatuses } from './WorkspaceSessions';

type LocalStory = Awaited<ReturnType<typeof readLocalStory>>;

interface StoryRun extends SessionTurn {
  path: string;
  story?: LocalStory;
  session?: { id: string; title?: string };
  taskId?: string;
}

export class StoryRunner {
  private readonly tasks: AgentTaskManager;
  private readonly runs = new Map<string, StoryRun>();
  private readonly stores = new Map<string, WorkspaceSessions>();
  private readonly executions = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    dataDirectory: string,
    logger: Logger,
    private readonly configurations: () => AgentModelConfiguration[],
    sandboxMode: () => CodexSandboxMode = configuredCodexSandbox,
  ) {
    const runtime = join(dataDirectory, 'story-runs');
    this.tasks = new AgentTaskManager(join(runtime, 'tasks'), logger, undefined, sandboxMode);
  }

  async start(
    path: string,
    description: string,
    storyId?: string,
    messaging?: { routeKey: string; startNew: boolean },
  ) {
    const { root } = await inspectWorkspace(path);
    const store = await this.workspaceStore(root);
    if (this.stopped) throw new Error('Story 执行服务已停止');
    if (messaging) {
      if (!storyId && !messaging.startNew)
        storyId = store.currentMessagingStory(messaging.routeKey);
      if (storyId) this.requireMessagingStory(root, store, storyId);
    }
    const session = storyId ? await this.readSession(root, store, storyId) : {
      id: `session-${randomUUID()}`,
      title: description.split(/\r?\n/, 1)[0].replace(/^#+\s*/, '').trim().slice(0, 100) || '新会话',
    };
    const run: StoryRun = {
      id: randomUUID(),
      path: root,
      status: 'queued',
      createdAt: Date.now(),
      description,
      storyId: session.id,
      session: { id: session.id, title: session.title },
    };
    store.reserve(run, messaging?.routeKey, storyId ? undefined : session.title);
    this.runs.set(run.id, run);
    this.executions.set(
      run.id,
      this.perform(run, store)
        .catch((error: unknown) => {
          run.error = error instanceof Error ? error.message : String(error);
          run.status = 'failed';
        })
        .finally(() => this.executions.delete(run.id)),
    );
    return this.snapshot(run);
  }

  async latest(path: string, storyId?: string, knownRunId?: string) {
    const { root, store } = await this.openWorkspace(path);
    const turn = store.latest(storyId);
    if (!turn || turn.id === knownRunId) return null;
    return this.snapshot(this.runs.get(turn.id) ?? (await this.restore(root, turn)));
  }

  async listSessions(path: string) {
    const { root, store } = await this.openWorkspace(path);
    return this.sessionSummaries(root, store);
  }

  async listMessagingSessions(path: string, routeKey: string) {
    const { root, store } = await this.openWorkspace(path);
    return {
      sessions: this.sessionSummaries(root, store),
      current: store.currentMessagingStory(routeKey),
    };
  }

  async selectMessagingSession(path: string, routeKey: string, storyId?: string) {
    const { root, store } = await this.openWorkspace(path);
    const session = storyId ? this.requireMessagingStory(root, store, storyId) : undefined;
    store.selectMessagingStory(routeKey, storyId);
    return session;
  }

  async session(path: string, id: string) {
    const { root, store } = await this.openWorkspace(path);
    return this.readSession(root, store, id);
  }

  private sessionSummaries(root: string, store: WorkspaceSessions) {
    return store.storyIds().flatMap((id) => {
      const metadata = store.metadata(id);
      return metadata ? [metadata] : localStorySummaries(root, [id]);
    });
  }

  private async readSession(root: string, store: WorkspaceSessions, id: string) {
    const metadata = store.metadata(id);
    if (metadata) return metadata;
    const story = await readLocalStory(root, id);
    return { ...story, title: story.content.match(/^#\s+(.+)$/m)?.[1] };
  }

  async waitForRun(runId: string) {
    this.requireRun(runId);
    await this.executions.get(runId);
    return this.get(runId);
  }

  private requireMessagingStory(root: string, store: WorkspaceSessions, storyId: string) {
    const session = store.metadata(storyId) ?? (store.thread(storyId) && localStorySummaries(root, [storyId])[0]);
    if (!session) throw new Error('会话不存在或已归档。发送 /sessions 查看可用会话。');
    return session;
  }

  get(runId: string) {
    return this.snapshot(this.requireRun(runId));
  }

  async getForWorkspace(path: string, runId: string) {
    const running = this.runs.get(runId);
    if (running?.path === path) return this.snapshot(running);
    const { root } = await inspectWorkspace(path);
    const turn = (await this.workspaceStore(root)).get(runId);
    if (!turn) throw new Error('会话运行记录不存在');
    return this.snapshot(running?.path === root ? running : await this.restore(root, turn));
  }

  cancel(runId: string) {
    const run = this.requireRun(runId);
    if (!terminalStatuses.has(run.status)) {
      run.status = 'cancelled';
      if (run.taskId) this.tasks.cancel(run.taskId);
    }
    return this.snapshot(run);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const id of this.executions.keys()) this.cancel(id);
    await this.tasks.stop();
    await Promise.all(this.executions.values());
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
  }

  private async workspaceStore(root: string): Promise<WorkspaceSessions> {
    const known = this.stores.get(root);
    if (known) return known;
    const directory = await workspaceGitDirectory(root);
    if (this.stopped) throw new Error('Story 执行服务已停止');
    const store = this.stores.get(root) ?? new WorkspaceSessions(directory);
    this.stores.set(root, store);
    return store;
  }

  private async openWorkspace(path: string): Promise<{ root: string; store: WorkspaceSessions }> {
    const cached = this.stores.get(path);
    if (cached) return { root: path, store: cached };
    const { root } = await inspectWorkspace(path);
    return { root, store: await this.workspaceStore(root) };
  }

  private async restore(path: string, turn: SessionTurn): Promise<StoryRun> {
    const story = turn.storyId
      ? await readLocalStory(path, turn.storyId).catch(() => undefined)
      : undefined;
    const store = this.stores.get(path)!;
    const session = turn.storyId ? store.metadata(turn.storyId) ?? { id: turn.storyId } : undefined;
    return { ...turn, path, story, session };
  }

  private async perform(run: StoryRun, store: WorkspaceSessions): Promise<void> {
    try {
      const { description } = run;
      const configurations = this.configurations();
      const sessionId = run.storyId!;
      const metadata = store.metadata(sessionId);
      const story = metadata ? undefined : await readLocalStory(run.path, sessionId);
      run.story = story;
      run.session = metadata ?? { id: sessionId, title: story?.content.match(/^#\s+(.+)$/m)?.[1] };
      if (terminalStatuses.has(run.status)) return;
      const threadId = store.thread(sessionId);
      const prompt = [
        `digital-avatar 工作区根目录：${run.path}`,
        ...(story ? [`已有 Story 目录：${story.directory}`, `需求说明：${join(story.directory, story.file)}`] : []),
        '先读取根 README.md 的项目职能与任务归属、根 AGENTS.md 和目标路径的规约。从整个工作区判断任务归属，可以涉及多个项目。',
        threadId
          ? '延续此 Codex 会话，结合已有对话处理本轮。'
          : '如有已有的需求说明，可读取它了解事项背景。',
        '默认不创建 Story、需求说明或过程记录文件。只有用户明确要求时才创建；已有 Story 可继续使用。保留原有未提交改动，开发位置、分支和 worktree 规则按工作区规约和用户明确指令执行。',
        '会话消息和答复由 cpx 保存，无需写入项目文件。仅在用户明确要求时创建或修改需求说明。',
        '请实际执行需求并运行相关验证。提交、推送、创建 PR 或归档遵照用户授权和工作区规约。最后汇报具体改动、验证结果和待处理项。',
        `本轮用户需求：\n${description}`,
      ].join('\n');
      run.status = 'running';
      store.save(run);
      const task = this.tasks.createPreparedTask(
        {
          directory: story?.directory ?? run.path,
          writableRoot: run.path,
          onThreadStarted: (id) => store.bindThread(sessionId, id),
        },
        prompt,
        configurations,
        threadId,
      );
      run.taskId = task.id;
      const outcome = await this.tasks.waitForTerminal(task.id);
      if (terminalStatuses.has(run.status)) return;
      this.requireSuccess(outcome);
      run.response = outcome.lastAgentResponse;
      if (!store.thread(sessionId)) throw new Error('Codex 未返回线程 ID，无法绑定当前会话');
      run.status = 'completed';
    } catch (error) {
      if (!terminalStatuses.has(run.status)) {
        run.error = error instanceof Error ? error.message : String(error);
        run.status = 'failed';
      }
    } finally {
      store.save(run);
    }
  }

  private requireSuccess(task: AgentTask): void {
    if (task.status !== 'completed') throw new Error(task.error || 'Codex 未完成当前轮次');
  }

  private requireRun(id: string): StoryRun {
    const run = this.runs.get(id);
    if (!run) throw new Error('此会话不在当前服务的运行列表中');
    return run;
  }

  private snapshot(run: StoryRun) {
    const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
    const logs = task?.logs.slice(-40).map(({ message }) => message.slice(0, 2000)) ?? [];
    const stored = run.storyId ? (this.stores.get(run.path)?.turns(run.storyId) ?? []) : [];
    const turns = (
      stored.length ? stored.map((turn) => (turn.id === run.id ? run : turn)) : [run]
    ).map(({ id, description, response, status }) => ({ id, description, response, status }));
    return { ...run, logs, turns };
  }
}
