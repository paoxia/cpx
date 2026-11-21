import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { AgentModelConfiguration, AgentTask, AgentTaskManager } from '../agents/AgentTaskManager';
import { Logger } from '../utils/Logger';
import { createLocalStory, localStorySummaries, readLocalStory } from './Story';
import { inspectWorkspace, workspaceGitDirectory } from './Workspace';
import { SessionTurn, WorkspaceSessions, terminalStatuses } from './WorkspaceSessions';

type LocalStory = Awaited<ReturnType<typeof readLocalStory>>;

interface StoryRun extends SessionTurn {
  path: string;
  story?: LocalStory;
  taskId?: string;
}

const namingResult = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((title) => !/[\r\n]/.test(title)),
});

export class StoryRunner {
  private readonly tasks: AgentTaskManager;
  private readonly namingDirectory: string;
  private readonly runs = new Map<string, StoryRun>();
  private readonly stores = new Map<string, WorkspaceSessions>();
  private readonly executions = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    dataDirectory: string,
    logger: Logger,
    private readonly configurations: () => AgentModelConfiguration[],
  ) {
    const runtime = join(dataDirectory, 'story-runs');
    this.tasks = new AgentTaskManager(join(runtime, 'tasks'), logger);
    this.namingDirectory = join(runtime, 'naming');
    mkdirSync(this.namingDirectory, { recursive: true });
  }

  async start(path: string, description: string, storyId?: string) {
    const { root } = await inspectWorkspace(path);
    const store = await this.workspaceStore(root);
    if (this.stopped) throw new Error('Story 执行服务已停止');
    const run: StoryRun = {
      id: randomUUID(),
      path: root,
      status: 'queued',
      createdAt: Date.now(),
      description,
      storyId,
    };
    store.reserve(run);
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

  async latest(path: string, storyId?: string) {
    const { root } = await inspectWorkspace(path);
    const turn = (await this.workspaceStore(root)).latest(storyId);
    return turn ? this.snapshot(this.runs.get(turn.id) ?? (await this.restore(root, turn))) : null;
  }

  async listSessions(path: string) {
    const { root } = await inspectWorkspace(path);
    const store = await this.workspaceStore(root);
    return localStorySummaries(root, store.storyIds());
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

  private async restore(path: string, turn: SessionTurn): Promise<StoryRun> {
    const story = turn.storyId
      ? await readLocalStory(path, turn.storyId).catch(() => undefined)
      : undefined;
    return { ...turn, path, story };
  }

  private async perform(run: StoryRun, store: WorkspaceSessions): Promise<void> {
    try {
      const { description } = run;
      const configurations = this.configurations();
      let story: LocalStory;
      if (run.storyId) {
        story = await readLocalStory(run.path, run.storyId);
      } else {
        run.status = 'naming';
        store.save(run);
        const naming = this.tasks.createPreparedTask(
          { directory: this.namingDirectory, readOnly: true },
          [
            '你负责为一个 digital-avatar Story 起名。直接返回单行 JSON，不调用工具。',
            '字段 name：简短、可辨识的小写英文 kebab-case 标识（2 到 64 字符），不要加日期。',
            '字段 title：与用户需求同语言的简短标题。用户明确给出标识或标题时优先沿用。',
            '输出示例：{"name":"improve-task-console","title":"改进任务控制台"}',
            `用户需求：\n${description}`,
          ].join('\n'),
          configurations,
        );
        run.taskId = naming.id;
        const named = await this.tasks.waitForTerminal(naming.id);
        if (terminalStatuses.has(run.status)) return;
        this.requireSuccess(named);
        const answer = named.lastAgentResponse?.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
        let proposal: z.infer<typeof namingResult>;
        try {
          proposal = namingResult.parse(JSON.parse(answer ?? ''));
        } catch {
          throw new Error('Codex 没有返回有效的 Story 名称，请重新提交');
        }
        run.status = 'creating';
        store.save(run);
        story = await createLocalStory(
          run.path,
          description,
          proposal.name,
          new Date(run.createdAt),
          proposal.title,
        );
      }
      run.story = story;
      run.storyId = story.id;
      if (terminalStatuses.has(run.status)) return;

      const threadId = store.thread(story.id);
      const prompt = [
        `digital-avatar 工作区根目录：${run.path}`,
        `本轮 Story 目录：${story.directory}`,
        `需求说明：${join(story.directory, story.file)}`,
        '先读取根 README.md 的项目职能与任务归属、根 AGENTS.md 和目标路径的规约。从整个工作区判断任务归属，可以涉及多个项目。',
        threadId
          ? '延续此 Codex 会话，结合已有对话处理本轮。'
          : '如有已有的需求说明，可读取它了解事项背景。',
        '使用当前 Story，保留原有未提交改动。开发位置、分支和 worktree 规则按该工作区的 AGENTS.md 和用户明确指令执行。',
        '会话消息和答复由 cpx 保存。仅在用户明确要求编辑需求说明时修改该文件。',
        '请实际执行需求并运行相关验证。提交、推送、创建 PR 或归档遵照用户授权和工作区规约。最后汇报具体改动、验证结果和待处理项。',
        `本轮用户需求：\n${description}`,
      ].join('\n');
      run.status = 'running';
      store.save(run);
      const task = this.tasks.createPreparedTask(
        {
          directory: story.directory,
          writableRoot: run.path,
          onThreadStarted: (id) => store.bindThread(story.id, id),
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
      if (!store.thread(story.id)) throw new Error('Codex 未返回线程 ID，无法绑定当前会话');
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
