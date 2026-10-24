import { randomBytes, randomUUID } from 'crypto';
import { mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import {
  AgentTaskManager,
  AgentTask,
  AgentTaskRequest,
  TaskOptions,
  normalizeRepository,
} from '../agents/AgentTaskManager';
import { HttpServer } from '../core/HttpServer';
import { AccessControl, digest, Principal } from './Access';
import { WorkbenchStore } from './Store';
import { nextScheduleAt, Schedule, scheduleDate, scheduleSchema } from './Schedules';
import { newsPrompt } from '../agents/News';

const checkSchema = z.object({
  command: z.string().min(1).max(512),
  args: z.array(z.string().max(4096)).max(100).default([]),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
});
const projectSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().min(1).max(100),
  repository: z.string().min(1).max(512),
  baseBranch: z.string().max(255).default('main'),
  context: z.string().max(20000).default(''),
  policy: z.enum(['local', 'review', 'auto']).default('review'),
  verificationCommands: z.array(checkSchema).max(10).default([]),
  timeoutMs: z.number().int().min(1000).max(86400000).default(1800000),
  executorId: z.string().max(100).optional(),
  extensions: z.array(z.string().max(100)).max(30).default([]),
  independentReview: z.boolean().default(false),
  allowScheduledMerge: z.boolean().default(false),
});
export type Project = z.infer<typeof projectSchema> & { version: number; updatedAt: number };
const runtimeSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(1),
  maxQueue: z.number().int().min(1).max(1000).default(100),
  minFreeBytes: z
    .number()
    .int()
    .nonnegative()
    .default(256 * 1024 * 1024),
  timeoutMs: z.number().int().min(1000).max(86400000).default(1800000),
  schedulesEnabled: z.boolean().default(false),
  remoteEnabled: z.boolean().default(false),
  defaultPolicy: z.enum(['local', 'review', 'auto']).default('review'),
  logLimit: z.number().int().min(100).max(5000).default(800),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  autoCleanup: z.boolean().default(false),
});
interface Notice {
  id: string;
  taskId: string;
  turnId: string;
  attempts: number;
  nextAt: number;
  deliveredAt?: number;
  error?: string;
  snapshot?: AgentTask;
}
export interface ExtensionOperations {
  list(): unknown;
  perform(input: Record<string, unknown>): Promise<unknown>;
  execute?(
    input: { name: string; method?: string; args?: Record<string, unknown> },
    task: AgentTask,
  ): Promise<unknown>;
}
interface WorkbenchOptions {
  dataDir: string;
  createTask: (request: AgentTaskRequest) => AgentTask;
  extensions?: ExtensionOperations;
  integrationStatus?: () => unknown;
}

const templates = [
  { id: 'custom', name: '自定义任务', prompt: '{{input}}' },
  {
    id: 'news',
    name: '新闻日报（实时搜索）',
    prompt: '搜集以下范围的最新新闻，更新仓库中的新闻日报：\n{{input}}',
  },
  {
    id: 'investigate',
    name: '调查问题',
    prompt: '调查以下问题，给出代码依据、原因与实施建议；不要修改代码：\n{{input}}',
  },
  {
    id: 'fix',
    name: '按验收修复',
    prompt: '根据以下复现与验收要求完成修复，运行相关验证并报告未验证内容：\n{{input}}',
  },
  {
    id: 'maintenance',
    name: '维护检查',
    prompt: '检查以下维护范围，产出风险与变更建议；不要自动升级依赖或发布：\n{{input}}',
  },
];

export class Workbench {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopping = false;
  private currentTick?: Promise<void>;
  private notify?: (task: AgentTask) => Promise<void>;
  private extensionTokens = new Map<string, { hash: string; turnId: string }>();

  constructor(
    readonly store: WorkbenchStore,
    readonly access: AccessControl,
    readonly manager: AgentTaskManager,
    readonly options: WorkbenchOptions,
  ) {
    const runtime = this.runtimeSettings();
    this.manager.configure(runtime);
    if (!store.get('migration', 'publication'))
      store.put('migration', 'publication', {
        required: existsSync(join(options.dataDir, 'console-settings.json')),
      });
  }

  runtimeSettings(): z.infer<typeof runtimeSchema> {
    return runtimeSchema.parse(this.store.get('settings', 'runtime') ?? {});
  }

  prepare(input: AgentTaskRequest, principal?: Principal): AgentTaskRequest {
    if (this.store.get<{ required: boolean }>('migration', 'publication')?.required)
      throw new Error('请先由管理员在页面确认旧版本的发布策略迁移');
    const parsed = z
      .object({
        repository: z.string().max(512),
        baseBranch: z.string().max(255).optional(),
        taskBranch: z.string().max(255).optional(),
        prompt: z.string().min(1).max(20000),
        projectId: z.string().max(80).optional(),
        policy: z.enum(['local', 'review', 'auto']).optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      })
      .parse(input);
    const matched = parsed.projectId
      ? undefined
      : this.store
          .list<Project>('project')
          .find(
            (p) =>
              normalizeRepository(p.repository) === normalizeRepository(parsed.repository) &&
              (!principal || this.access.canProject(principal, p.id)),
          );
    const project = parsed.projectId
      ? this.store.get<Project>('project', parsed.projectId)
      : matched;
    if (parsed.projectId && !project) throw new Error('项目不存在');
    if (principal && !this.access.canProject(principal, project?.id, true))
      throw new Error('无权在此项目创建任务');
    if (principal && principal.role !== 'admin' && input.policy && input.policy !== project?.policy)
      throw new Error('不能覆盖项目发布策略');
    if (project?.executorId && !this.runtimeSettings().remoteEnabled)
      throw new Error('远程执行尚未启用');
    if (project?.executorId && project.extensions.length)
      throw new Error('远程执行暂不支持控制端项目扩展，请选择本机执行或移除扩展');
    return {
      ...parsed,
      ...(project
        ? {
            projectId: project.id,
            repository: project.repository,
            baseBranch: project.baseBranch,
            projectVersion: project.version,
            context: project.context,
            verificationCommands: project.verificationCommands,
            timeoutMs: project.timeoutMs,
            executorId: project.executorId,
            extensions: project.extensions,
            independentReview: project.independentReview,
          }
        : {}),
      ownerId: principal?.id ?? input.ownerId ?? 'admin',
      policy: parsed.policy ?? project?.policy ?? this.runtimeSettings().defaultPolicy,
    };
  }

  continuation(id: string): TaskOptions {
    const task = this.manager.get(id);
    const project = task?.projectId
      ? this.store.get<Project>('project', task.projectId)
      : undefined;
    if (!project) return {};
    const schedule = task?.scheduleId
      ? this.store.get<Schedule>('schedule', task.scheduleId)
      : undefined;
    return {
      projectVersion: project.version,
      context: project.context,
      verificationCommands: project.verificationCommands,
      timeoutMs: project.timeoutMs,
      policy:
        task?.scheduleId && (task.policy === 'review' || schedule?.publication === 'review')
          ? 'review'
          : project.policy,
      autoMerge: Boolean(
        task?.autoMerge &&
        project.policy === 'auto' &&
        project.allowScheduledMerge &&
        schedule?.publication === 'merge',
      ),
      executorId: project.executorId,
      extensions: project.extensions,
      independentReview: project.independentReview,
    };
  }

  private scheduleProject(schedule: Schedule): Project {
    const project = this.store.get<Project>('project', schedule.projectId);
    if (!project) throw new Error('项目不存在');
    if (schedule.publication !== 'review' && project.policy !== 'auto')
      throw new Error('自动发布需先在项目中预授权自动发布 PR');
    if (schedule.publication === 'merge' && !project.allowScheduledMerge)
      throw new Error('项目未授权定时任务自动合并');
    return project;
  }

  /** Recheck current project authorization at execution/publication, not just at enqueue. */
  authorizeScheduledTask(action: string, task: AgentTask): void {
    if (!task.scheduleId) return;
    const schedule = this.store.get<Schedule>('schedule', task.scheduleId);
    const owner = task.ownerId ? this.access.account(task.ownerId) : undefined;
    if (
      !schedule ||
      schedule.projectId !== task.projectId ||
      schedule.ownerId !== task.ownerId ||
      !owner ||
      !['admin', 'maintainer'].includes(owner.role) ||
      !this.access.canProject(owner, task.projectId, true)
    )
      throw new Error('定时任务授权已撤销');
    const project = this.store.get<Project>('project', task.projectId!);
    if (!project) throw new Error('项目不存在');
    if (action === 'publish' && (task.policy === 'auto' || task.autoMerge)) {
      if (project.policy !== 'auto' || schedule.publication === 'review')
        throw new Error('定时任务自动发布授权已撤销');
      if (task.autoMerge && (!project.allowScheduledMerge || schedule.publication !== 'merge'))
        throw new Error('定时任务自动合并授权已撤销');
    }
  }

  terminal(task: AgentTask): void {
    if (['cancelled', 'interrupted'].includes(task.status) && !task.stopConfirmed) return;
    if (
      !task.origin ||
      ['queued', 'running', 'preparing', 'verifying', 'publishing'].includes(task.status)
    )
      return;
    const turn = task.turns[task.turns.length - 1];
    const id = `${task.id}:${turn.id}:${task.recoveryCount ?? 0}:${task.status}`;
    if (!this.store.get('notice', id))
      this.store.put<Notice>('notice', id, {
        id,
        taskId: task.id,
        turnId: turn.id,
        attempts: 0,
        nextAt: Date.now(),
      });
  }

  setNotifier(notify: (task: AgentTask) => Promise<void>): void {
    this.notify = notify;
  }

  start(): void {
    this.manager.start();
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.currentTick;
  }

  tick(now = Date.now()): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.currentTick) return this.currentTick.then(() => this.tick(now));
    const pending = this.performTick(now);
    this.currentTick = pending.finally(() => {
      this.currentTick = undefined;
    });
    return this.currentTick;
  }

  private triggerSchedule(
    schedule: Schedule,
    now: number,
    key: string,
    reviewOnly = false,
  ): AgentTask {
    const owner = this.access.account(schedule.ownerId);
    if (
      !owner ||
      !['admin', 'maintainer'].includes(owner.role) ||
      !this.access.canProject(owner, schedule.projectId, true)
    )
      throw new Error('定时任务创建者权限已撤销');
    if (reviewOnly) {
      if (!this.store.get<Project>('project', schedule.projectId)) throw new Error('项目不存在');
    } else this.scheduleProject(schedule);
    if (
      this.manager
        .list()
        .some(
          (task) =>
            task.projectId === schedule.projectId &&
            ['queued', 'preparing', 'running', 'verifying', 'publishing'].includes(task.status),
        )
    )
      throw new Error('项目有活动任务，本次跳过');
    const template = templates.find((item) => item.id === schedule.templateId);
    if (!template) throw new Error('模板不存在');
    const news =
      schedule.templateId === 'news'
        ? {
            directory: schedule.newsDirectory,
            date: scheduleDate(schedule.timeZone, now),
            since: now - 86400000,
            until: now,
            maxItems: schedule.newsMaxItems,
            timeZone: schedule.timeZone,
          }
        : undefined;
    const request = this.prepare(
      {
        projectId: schedule.projectId,
        repository: '',
        provider: 'codex',
        prompt:
          template.prompt.replace('{{input}}', () => schedule.prompt) +
          (news ? newsPrompt(news) : ''),
        idempotencyKey: key,
      },
      owner,
    );
    request.policy = reviewOnly || schedule.publication === 'review' ? 'review' : 'auto';
    request.scheduleId = schedule.id;
    request.autoMerge = !reviewOnly && schedule.publication === 'merge';
    request.news = news;
    if (news) request.webSearch = 'live';
    return this.store.db.transaction(() => {
      const task = this.options.createTask(request);
      schedule.lastTaskId = task.id;
      schedule.lastAt = now;
      schedule.error = undefined;
      this.store.put('schedule', schedule.id, schedule);
      this.store.audit(owner.id, reviewOnly ? 'schedule_test' : 'schedule_trigger', schedule.id);
      return task;
    });
  }

  private async performTick(now: number): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.runtimeSettings().schedulesEnabled) {
        for (const schedule of this.store.list<Schedule>('schedule')) {
          if (!schedule.enabled || schedule.nextAt > now) continue;
          Object.assign(schedule, scheduleSchema.parse(schedule));
          const trigger = schedule.nextAt;
          schedule.nextAt = nextScheduleAt(schedule, now);
          schedule.lastAt = now;
          try {
            this.triggerSchedule(schedule, now, `schedule:${schedule.id}:${trigger}`);
            schedule.error = undefined;
          } catch (error) {
            schedule.error = String(error);
          }
          this.store.put('schedule', schedule.id, schedule);
        }
      }
      if (this.notify) {
        for (const notice of this.store.list<Notice>('notice')) {
          if (notice.deliveredAt || notice.nextAt > now || notice.attempts >= 8) continue;
          const task = notice.snapshot ?? this.manager.get(notice.taskId);
          if (!task) continue;
          notice.attempts++;
          // Persist before sending; delivery is at-least-once across a crash.
          notice.nextAt = now + Math.min(3600000, 5000 * 2 ** notice.attempts);
          this.store.put('notice', notice.id, notice);
          try {
            let timer: NodeJS.Timeout | undefined;
            try {
              await Promise.race([
                this.notify(task),
                new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => reject(new Error('通知超时')), 10000);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
            notice.deliveredAt = Date.now();
            notice.error = undefined;
          } catch {
            notice.error = '原会话投递失败；请检查连接或重新投递';
          }
          this.store.put('notice', notice.id, notice);
        }
      }
      if (this.runtimeSettings().autoCleanup) {
        const cutoff = now - this.runtimeSettings().retentionDays * 86400000;
        const task = this.manager
          .list()
          .find((t) => t.workspace && t.archivedAt && t.archivedAt < cutoff);
        if (task) {
          try {
            const preview = await this.manager.cleanupPreview(task.id);
            if (preview.safe) {
              await this.manager.cleanup(task.id, preview.version);
              this.store.audit('retention-policy', 'cleanup', task.id);
            }
          } catch {
            /* Active or changed workspaces remain intact. */
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  bind(code: string, source: string, userId: string): void {
    const key = digest(code);
    const record = this.store.get<{ userId: string; expiresAt: number }>('binding-code', key);
    if (!record || record.expiresAt < Date.now() || !this.access.account(record.userId))
      throw new Error('绑定码无效或已过期');
    const identityId = `${source}:${userId}`;
    const current = this.store.get<{ userId: string }>('identity', identityId);
    if (current && current.userId !== record.userId) throw new Error('该平台身份已绑定，请先解绑');
    this.store.put('identity', identityId, { id: identityId, userId: record.userId });
    this.store.remove('binding-code', key);
    this.store.audit(record.userId, 'identity_bind', identityId);
  }

  attach(server: HttpServer): void {
    const route = (
      method: string,
      path: string,
      admin: boolean,
      fn: (
        body: Record<string, unknown>,
        principal: Principal,
        query: Record<string, string>,
      ) => Promise<unknown> | unknown,
    ): void => {
      server.register(method, `/api/workbench/${path}`, async (raw, headers, query) => {
        try {
          const principal = this.access.principal(headers);
          if (admin && principal.role !== 'admin')
            return { status: 403, body: { error: '仅管理员可以操作' } };
          const body = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {};
          return {
            status: 200,
            body: await fn(body, principal, query),
            headers: { 'Cache-Control': 'no-store' },
          };
        } catch (error) {
          return {
            status: 400,
            body: { error: error instanceof z.ZodError ? '输入参数无效' : String(error) },
            headers: { 'Cache-Control': 'no-store' },
          };
        }
      });
    };
    route('GET', 'projects', false, (_body, principal) =>
      this.store.list<Project>('project').filter((p) => this.access.canProject(principal, p.id)),
    );
    route('GET', 'migration', false, () => this.store.get('migration', 'publication'));
    route('POST', 'migration', true, (body) => {
      const policy = z.enum(['local', 'review', 'auto']).parse(body.policy);
      this.store.put('settings', 'runtime', { ...this.runtimeSettings(), defaultPolicy: policy });
      this.store.put('migration', 'publication', {
        required: false,
        policy,
        confirmedAt: Date.now(),
      });
      this.store.audit('admin', 'publication_migration', policy);
      return { success: true };
    });
    route('POST', 'projects', false, (body, principal) => {
      const input = projectSchema.parse(body);
      if (input.allowScheduledMerge && input.policy !== 'auto')
        throw new Error('自动合并需要预授权自动发布 PR');
      normalizeRepository(input.repository);
      if (!this.access.canProject(principal, input.id, true) || principal.role === 'requester')
        throw new Error('无权修改项目规则');
      const previous = this.store.get<Project>('project', input.id);
      if (body.version !== (previous?.version ?? 0)) throw new Error('项目版本已更新，请刷新');
      const next: Project = {
        ...input,
        version: (previous?.version ?? 0) + 1,
        updatedAt: Date.now(),
      };
      this.store.db.transaction(() => {
        this.store.put('project-version', `${next.id}:${next.version}`, next);
        this.store.put('project', next.id, next);
      });
      this.store.audit(principal.id, 'project_save', `${next.id}:${next.version}`);
      return next;
    });
    route('GET', 'project-history', false, (_body, principal, query) => {
      if (!this.access.canProject(principal, query.id)) throw new Error('无权查看项目');
      return this.store.list<Project>('project-version').filter((p) => p.id === query.id);
    });
    route('GET', 'runtime', true, () => ({
      ...this.manager.runtime(),
      settings: this.runtimeSettings(),
      integrations: this.options.integrationStatus?.(),
      tasks: this.manager.list().length,
      notices: this.store.list<Notice>('notice').filter((n) => !n.deliveredAt),
      schemaVersion: 1,
    }));
    route('POST', 'runtime', true, (body) => {
      const settings = runtimeSchema.parse({ ...this.runtimeSettings(), ...body });
      this.store.put('settings', 'runtime', settings);
      this.manager.configure(settings);
      return settings;
    });
    route('GET', 'accounts', true, () => this.access.listAccounts());
    route('POST', 'accounts', true, (body, principal) => {
      const account = this.access.saveAccount(body);
      this.store.audit(principal.id, 'account_save', account.id);
      return account;
    });
    route('GET', 'tokens', true, () =>
      this.store
        .list<{ id: string; userId: string; name: string; expiresAt: number; csrf?: string }>(
          'credential',
        )
        .filter((c) => !c.csrf)
        .map(({ id, userId, name, expiresAt }) => ({ id, userId, name, expiresAt })),
    );
    route('POST', 'tokens', true, (body) =>
      this.access.issue(z.string().parse(body.userId), z.string().min(1).max(80).parse(body.name)),
    );
    route('POST', 'token-revoke', true, (body) => {
      this.store.remove('credential', z.string().parse(body.id));
      return { success: true };
    });
    route('GET', 'identities', true, () => this.store.list('identity'));
    route('POST', 'identity-unbind', true, (body) => {
      this.store.remove('identity', z.string().parse(body.id));
      return { success: true };
    });
    route('POST', 'binding-code', false, (_body, principal) => {
      const code = randomBytes(12).toString('hex');
      this.store.put('binding-code', digest(code), {
        userId: principal.id,
        expiresAt: Date.now() + 300000,
      });
      return { code, expiresInSeconds: 300, command: `/bind ${code}` };
    });
    route('GET', 'templates', false, () => templates);
    route('GET', 'schedules', false, (_body, principal) =>
      this.store
        .list<Schedule>('schedule')
        .filter(
          (s) =>
            (principal.role === 'admin' || s.ownerId === principal.id) &&
            this.access.canProject(principal, s.projectId),
        )
        .map((s) => {
          const task = s.lastTaskId ? this.manager.get(s.lastTaskId) : undefined;
          return {
            ...s,
            ...scheduleSchema.parse(s),
            lastTask:
              task && this.access.canTask(principal, task)
                ? {
                    id: task.id,
                    status: task.status,
                    error: task.error,
                    publication: task.publication,
                    pullRequestUrl: task.pullRequestUrl,
                    merge: task.merge,
                  }
                : undefined,
          };
        }),
    );
    route('POST', 'schedules', false, (body, principal) => {
      const input = scheduleSchema.parse(body);
      if (
        !this.access.canProject(principal, input.projectId, true) ||
        principal.role === 'requester'
      )
        throw new Error('无权设置定时任务');
      if (!templates.some((t) => t.id === input.templateId)) throw new Error('模板不存在');
      const old = this.store.get<Schedule>('schedule', input.id);
      if (old && old.ownerId !== principal.id && principal.role !== 'admin')
        throw new Error('无权修改此定时任务');
      const next: Schedule = {
        ...input,
        ownerId: old?.ownerId ?? principal.id,
        nextAt: nextScheduleAt(input, Date.now()),
        lastAt: old?.lastAt,
        lastTaskId: old?.lastTaskId,
      };
      this.scheduleProject(next);
      this.store.put('schedule', input.id, next);
      this.store.audit(principal.id, 'schedule_save', input.id);
      return next;
    });
    route('POST', 'schedule-run', false, (body, principal) => {
      const id = z.string().parse(body.id);
      const runId = z.string().uuid().parse(body.runId);
      const saved = this.store.get<Schedule>('schedule', id);
      if (
        !saved ||
        (principal.role !== 'admin' && saved.ownerId !== principal.id) ||
        !['admin', 'maintainer'].includes(principal.role) ||
        !this.access.canProject(principal, saved.projectId, true)
      )
        throw new Error('无权试运行此定时任务');
      const schedule = { ...saved, ...scheduleSchema.parse(saved) };
      const key = `schedule-test:${id}:${runId}`;
      const existing = this.manager
        .list()
        .find((task) => task.idempotencyKey === key && task.ownerId === saved.ownerId);
      if (existing) return existing;
      return this.triggerSchedule(schedule, Date.now(), key, true);
    });
    route('POST', 'notice-retry', true, (body) => {
      const id = z.string().parse(body.id);
      const notice = this.store.get<Notice>('notice', id);
      if (!notice) throw new Error('通知不存在');
      notice.attempts = 0;
      notice.nextAt = Date.now();
      notice.deliveredAt = undefined;
      return this.store.put('notice', id, notice);
    });
    route('GET', 'extensions', true, () => this.options.extensions?.list() ?? {});
    route('POST', 'extensions', true, (body) => {
      if (!this.options.extensions) throw new Error('扩展服务不可用');
      return this.options.extensions.perform(body);
    });
    route('POST', 'backup', true, async () => {
      const id = randomUUID();
      const directory = join(this.options.dataDir, 'backups');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      await this.store.db.backup(join(directory, `${id}.db`));
      return {
        id,
        file: `backups/${id}.db`,
        note: '一致性数据库快照；完整恢复还需停止服务并备份 config、workspaces 和可选的 Codex 凭据。',
      };
    });
    route('GET', 'diagnostics', true, () => ({
      version: 1,
      runtime: this.manager.runtime(),
      statusCounts: this.manager.list().reduce<Record<string, number>>((all, task) => {
        all[task.status] = (all[task.status] ?? 0) + 1;
        return all;
      }, {}),
      noticesPending: this.store.list<Notice>('notice').filter((n) => !n.deliveredAt).length,
      includesSource: false,
      includesPrompts: false,
      includesCredentials: false,
    }));
    route('GET', 'legacy-workspaces', true, () => {
      const directory = join(this.options.dataDir, 'workspaces');
      if (!existsSync(directory)) return [];
      const known = new Set(this.manager.list().map((t) => t.id));
      return readdirSync(directory)
        .filter(
          (id) =>
            /^[a-f0-9-]{36}$/.test(id) &&
            !known.has(id) &&
            statSync(join(directory, id)).isDirectory(),
        )
        .map((id) => ({ id, note: '遗留工作区，原归属和历史未知；请先备份，再在开发机核对。' }));
    });
    this.attachTaskRoutes(server);
    server.register('POST', '/api/internal/task-extension', async (raw, headers) => {
      try {
        const input = z
          .object({
            taskId: z.string(),
            name: z.string().max(200),
            method: z.string().max(100).optional(),
            args: z.record(z.unknown()).optional(),
          })
          .parse(JSON.parse(raw.toString()));
        const task = this.manager.get(input.taskId);
        const scope = this.extensionTokens.get(input.taskId);
        const project = task?.projectId
          ? this.store.get<Project>('project', task.projectId)
          : undefined;
        const principal = task?.ownerId
          ? this.access.account(
              this.store.get<{ userId: string }>('identity', task.ownerId)?.userId ?? task.ownerId,
            )
          : undefined;
        if (
          !task ||
          task.status !== 'running' ||
          !scope ||
          scope.turnId !== task.turns[task.turns.length - 1].id ||
          scope.hash !== digest(String(headers.authorization ?? '').replace(/^Bearer /, '')) ||
          !principal ||
          !this.access.canTask(principal, task, 'write')
        )
          return { status: 403, body: { error: '扩展调用未授权' } };
        if (
          !task.extensions?.includes(input.name) ||
          !project?.extensions.includes(input.name) ||
          !this.options.extensions?.execute
        )
          return { status: 403, body: { error: '项目未授权此扩展' } };
        const result = await this.options.extensions.execute(input, task);
        this.store.audit(principal.id, 'extension_call', `${task.id}:${input.name}`);
        return { status: 200, body: { result } };
      } catch {
        return { status: 400, body: { error: '扩展请求失败' } };
      }
    });
    for (const file of ['workbench.js', 'workbench.css']) {
      const path = join(__dirname, '../../public', file);
      const compiledPath = join(__dirname, '../../../public', file);
      const data = readFileSync(existsSync(path) ? path : compiledPath);
      server.register('GET', `/${file}`, async () => ({
        status: 200,
        body: data,
        contentType: file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/css; charset=utf-8',
        headers: { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
      }));
    }
  }

  extensionTools(task: AgentTask, endpoint: string): { url: string; token: string } | undefined {
    if (!task.extensions?.length || task.executorId) return undefined;
    const token = randomBytes(32).toString('hex');
    this.extensionTokens.set(task.id, {
      hash: digest(token),
      turnId: task.turns[task.turns.length - 1].id,
    });
    return { url: endpoint, token };
  }

  private attachTaskRoutes(server: HttpServer): void {
    const route = (
      method: string,
      action: string,
      fn: (
        task: AgentTask,
        body: Record<string, unknown>,
        principal: Principal,
      ) => Promise<unknown> | unknown,
    ): void => {
      server.register(method, `/api/console/task/${action}`, async (raw, headers, query) => {
        try {
          const principal = this.access.principal(headers);
          const body = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {};
          const task = this.manager.get(z.string().parse(body.id ?? query.id));
          const operation = action === 'publish' ? 'publish' : method === 'GET' ? 'read' : 'write';
          if (!task || !this.access.canTask(principal, task, operation))
            return { status: 403, body: { error: '无权操作此任务' } };
          const result = await fn(task, body, principal);
          this.store.audit(principal.id, action, task.id);
          return {
            status: 200,
            body: result ?? { success: true },
            headers: { 'Cache-Control': 'no-store' },
          };
        } catch (error) {
          return { status: 409, body: { error: String(error) } };
        }
      });
    };
    route('GET', 'result', (task) => this.manager.result(task.id));
    route('POST', 'publish', (task, body) =>
      this.manager.publish(task.id, z.string().parse(body.version)),
    );
    route('POST', 'resume', (task, body) => {
      if (task.executorId && body.oldExecutionStopped !== true)
        throw new Error('请先确认旧执行已经停止');
      return this.manager.resume(task.id, body.newSession === true);
    });
    route('POST', 'accept', (task) => this.manager.accept(task.id));
    route('POST', 'archive', (task) => this.manager.archive(task.id));
    route('POST', 'input', (task, body) => ({
      inputId: this.manager.queueInput(task.id, z.string().parse(body.prompt)),
    }));
    route('POST', 'input-remove', (task, body) =>
      this.manager.removeInput(task.id, z.string().parse(body.inputId)),
    );
    route('POST', 'input-run', (task, body) => {
      const input = task.pendingInputs?.find((i) => i.id === body.inputId);
      if (!input) throw new Error('待处理消息不存在');
      const next = this.manager.continueTask(task.id, {
        prompt: input.prompt,
        ...this.continuation(task.id),
      });
      this.manager.removeInput(task.id, input.id);
      return next;
    });
    route('GET', 'cleanup-preview', (task) => this.manager.cleanupPreview(task.id));
    route('POST', 'cleanup', (task, body) =>
      this.manager.cleanup(task.id, z.string().parse(body.version)),
    );
    route('GET', 'export', async (task) => {
      const result = await this.manager.result(task.id);
      return {
        ...result,
        response: task.lastAgentResponse,
        verification: task.verification,
        format: 'git binary patch; ignored files and external artifacts excluded',
      };
    });
  }
}
