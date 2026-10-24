import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseService } from '../../../src/storage/Database';
import { Logger } from '../../../src/utils/Logger';
import { WorkbenchStore } from '../../../src/workbench/Store';
import { AccessControl } from '../../../src/workbench/Access';
import { Workbench } from '../../../src/workbench/Workbench';
import { AgentTaskManager, AgentTask } from '../../../src/agents/AgentTaskManager';
import { HttpServer } from '../../../src/core/HttpServer';

describe('projects, automation and operational controls', () => {
  let root: string;
  let db: DatabaseService;
  let store: WorkbenchStore;
  let access: AccessControl;
  let manager: AgentTaskManager;
  let workbench: Workbench;
  let server: HttpServer;
  let base: string;
  let authorization: string;
  const create = vi.fn();
  const project = {
    id: 'demo',
    name: 'Demo',
    repository: 'acme/repo',
    baseBranch: 'main',
    context: 'Project policy',
    policy: 'auto',
    verificationCommands: [{ command: 'npm', args: ['test'], timeoutMs: 1000 }],
    timeoutMs: 30000,
    extensions: [],
  };
  const request = async (path: string, body?: unknown, auth = authorization) => {
    const response = await fetch(`${base}/api/workbench/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cpx-workbench-'));
    db = new DatabaseService(join(root, 'agent.db'), new Logger('error'));
    store = new WorkbenchStore(db);
    store.put('account', 'admin', { id: 'admin', name: 'Admin', role: 'admin', projects: [] });
    access = new AccessControl(store, root);
    authorization = `Bearer ${access.issue('admin', 'test').token}`;
    manager = new AgentTaskManager(join(root, 'workspaces'), new Logger('error'), undefined, {
      store,
    });
    create.mockReset();
    create.mockReturnValue({ id: 'generated-task' } as AgentTask);
    workbench = new Workbench(store, access, manager, { dataDir: root, createTask: create });
    server = new HttpServer(0, '127.0.0.1', new Logger('error'));
    access.attach(server, (id) => manager.get(id));
    workbench.attach(server);
    await server.start();
    base = `http://127.0.0.1:${server.getPort()}`;
  });
  afterEach(async () => {
    await workbench.stop();
    await manager.stop();
    await server.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('versions project rules and rejects stale saves', async () => {
    expect((await request('projects', { ...project, version: 0 })).status).toBe(200);
    expect((await request('projects', { ...project, context: 'changed', version: 0 })).status).toBe(
      400,
    );
    expect(
      (await request('projects', { ...project, context: 'changed', version: 1 })).body.version,
    ).toBe(2);
    const history = await request('project-history?id=demo');
    expect(history.body.map((v: { context: string }) => v.context).sort()).toEqual([
      'Project policy',
      'changed',
    ]);
  });

  it('rejects project and policy escalation and ignores untrusted execution settings', async () => {
    await request('projects', { ...project, version: 0 });
    const alice = access.saveAccount({
      id: 'alice',
      name: 'Alice',
      role: 'requester',
      projects: ['demo'],
    });
    const input = {
      provider: 'codex' as const,
      projectId: 'demo',
      repository: '',
      prompt: 'fix',
      verificationCommands: [{ command: 'malicious', args: [] }],
      seedPatch: 'bad',
      executorId: 'attacker',
      ownerId: 'admin',
    };
    const prepared = workbench.prepare(input, alice);
    expect(prepared.ownerId).toBe('alice');
    expect(prepared.verificationCommands).toEqual(project.verificationCommands);
    expect(prepared.executorId).toBeUndefined();
    expect(prepared.seedPatch).toBeUndefined();
    expect(() => workbench.prepare({ ...input, policy: 'local' }, alice)).toThrow('不能覆盖');
    expect(() =>
      workbench.prepare({ ...input, projectId: undefined, repository: 'other/private' }, alice),
    ).toThrow('无权');
  });

  it('triggers schedules once, forces review and applies revocation before execution', async () => {
    await request('projects', { ...project, version: 0 });
    await request('runtime', { schedulesEnabled: true });
    await request('schedules', {
      id: 'daily',
      projectId: 'demo',
      templateId: 'maintenance',
      prompt: 'dependency report',
      intervalMinutes: 5,
      enabled: true,
      timeZone: 'Asia/Shanghai',
    });
    const schedule = store.get<{ nextAt: number }>('schedule', 'daily')!;
    await workbench.tick(schedule.nextAt);
    await workbench.tick(schedule.nextAt);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].policy).toBe('review');
    expect(create.mock.calls[0][0].projectVersion).toBe(1);
    const updated = store.get<{ nextAt: number }>('schedule', 'daily')!;
    store.put('account', 'admin', {
      id: 'admin',
      name: 'Admin',
      role: 'admin',
      projects: [],
      disabled: true,
    });
    await workbench.tick(updated.nextAt);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.get<{ error: string }>('schedule', 'daily')?.error).toContain('权限已撤销');
  });

  it('binds identities only with an expiring one-time code and supports unlinking', async () => {
    const issued = await request('binding-code', {});
    workbench.bind(issued.body.code, 'feishu', 'actual-sdk-user');
    expect(access.chat('feishu', 'actual-sdk-user')?.id).toBe('admin');
    expect(() => workbench.bind(issued.body.code, 'dingtalk', 'another-user')).toThrow();
    await request('identity-unbind', { id: 'feishu:actual-sdk-user' });
    expect(access.chat('feishu', 'actual-sdk-user')).toBeUndefined();
  });

  it('creates daily news tasks with live search and fresh dated output, and does not replay downtime', async () => {
    await request('projects', { ...project, version: 0 });
    await request('runtime', { schedulesEnabled: true });
    const saved = await request('schedules', {
      id: 'news',
      projectId: 'demo',
      templateId: 'news',
      prompt: '孵化器相关的 AI 创业新闻，优先官方公告',
      cadence: 'daily',
      dailyTime: '09:00',
      timeZone: 'Asia/Shanghai',
      enabled: true,
    });
    expect(saved.status).toBe(200);
    const now = saved.body.nextAt + 3 * 86400000;
    await workbench.tick(now);
    await workbench.tick(now);
    expect(create).toHaveBeenCalledTimes(1);
    const task = create.mock.calls[0][0];
    expect(task.webSearch).toBe('live');
    expect(task.policy).toBe('review');
    expect(task.news.until - task.news.since).toBe(86400000);
    expect(task.prompt).toContain(`${task.news.date}.sources.json`);
    expect(task.prompt).toContain('孵化器');
    expect(store.get<{ nextAt: number }>('schedule', 'news')!.nextAt).toBe(now + 86400000);
  });

  it('requires explicit project and schedule authorization for automatic PRs and merging', async () => {
    await request('projects', { ...project, policy: 'review', version: 0 });
    const input = {
      id: 'daily',
      projectId: 'demo',
      templateId: 'custom',
      prompt: 'Update notes',
      publication: 'pull_request',
      enabled: true,
    };
    expect((await request('schedules', input)).status).toBe(400);
    await request('projects', { ...project, version: 1 });
    expect((await request('schedules', { ...input, publication: 'merge' })).status).toBe(400);
    await request('projects', { ...project, allowScheduledMerge: true, version: 2 });
    expect((await request('schedules', { ...input, publication: 'merge' })).status).toBe(200);
    await request('runtime', { schedulesEnabled: true });
    await workbench.tick(store.get<{ nextAt: number }>('schedule', 'daily')!.nextAt);
    const task = create.mock.calls[0][0] as AgentTask;
    expect(task.policy).toBe('auto');
    expect(task.autoMerge).toBe(true);
    expect(task.prompt).toBe('Update notes');
    expect(() => workbench.authorizeScheduledTask('publish', task)).not.toThrow();
    await request('projects', { ...project, allowScheduledMerge: false, version: 3 });
    expect(() => workbench.authorizeScheduledTask('publish', task)).toThrow('合并授权已撤销');
    await request('projects', { ...project, policy: 'review', version: 4 });
    expect(() => workbench.authorizeScheduledTask('publish', task)).toThrow('发布授权已撤销');
  });

  it('permits immediate review-only tests while disabled without moving the schedule', async () => {
    await request('projects', { ...project, allowScheduledMerge: true, version: 0 });
    const saved = await request('schedules', {
      id: 'daily',
      projectId: 'demo',
      templateId: 'news',
      prompt: 'AI news',
      publication: 'merge',
    });
    const tested = await request('schedule-run', {
      id: 'daily',
      runId: 'a7f20d3e-262b-4b24-9afa-d3348e9d1422',
    });
    expect(tested.status).toBe(200);
    expect(create.mock.calls[0][0].policy).toBe('review');
    expect(create.mock.calls[0][0].autoMerge).toBe(false);
    expect(store.get<{ nextAt: number }>('schedule', 'daily')!.nextAt).toBe(saved.body.nextAt);
    const queued = {
      ...create.mock.calls[0][0],
      id: 'generated-task',
      status: 'queued',
    } as AgentTask;
    vi.spyOn(manager, 'list').mockReturnValue([queued]);
    expect(
      (
        await request('schedule-run', {
          id: 'daily',
          runId: 'a7f20d3e-262b-4b24-9afa-d3348e9d1422',
        })
      ).status,
    ).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
    vi.spyOn(manager, 'get').mockReturnValue(queued);
    expect(workbench.continuation(queued.id).policy).toBe('review');
    expect(workbench.continuation(queued.id).autoMerge).toBe(false);
    const other = access.saveAccount({
      id: 'other',
      name: 'Other',
      role: 'maintainer',
      projects: ['demo'],
    });
    const token = `Bearer ${access.issue(other.id, 'test').token}`;
    expect(
      (
        await request(
          'schedule-run',
          { id: 'daily', runId: 'a7f20d3e-262b-4b24-9afa-d3348e9d1422' },
          token,
        )
      ).status,
    ).toBe(400);
  });

  it('rejects invalid schedules and skips a project that already has active work', async () => {
    await request('projects', { ...project, version: 0 });
    const input = {
      id: 'daily',
      projectId: 'demo',
      templateId: 'news',
      prompt: 'AI news',
      enabled: true,
    };
    for (const invalid of [
      { timeZone: 'invalid' },
      { dailyTime: '25:30' },
      { projectId: 'missing' },
      { newsDirectory: '../config' },
    ])
      expect((await request('schedules', { ...input, ...invalid })).status).toBe(400);
    await request('schedules', input);
    await request('runtime', { schedulesEnabled: true });
    vi.spyOn(manager, 'list').mockReturnValue([
      { projectId: 'demo', status: 'running' } as AgentTask,
    ]);
    await workbench.tick(store.get<{ nextAt: number }>('schedule', 'daily')!.nextAt);
    expect(create).not.toHaveBeenCalled();
    expect(store.get<{ error: string }>('schedule', 'daily')!.error).toContain('活动任务');
  });

  it('persists failed notifications and retries independently without running the agent', async () => {
    const task = {
      id: 'task',
      status: 'completed',
      origin: { source: 'feishu', userId: 'owner', userName: 'Owner', commandId: 'cmd' },
      turns: [{ id: 'turn' }],
    } as AgentTask;
    vi.spyOn(manager, 'get').mockReturnValue(task);
    const notify = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    workbench.setNotifier(notify);
    workbench.terminal(task);
    workbench.terminal(task);
    await workbench.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    const notice = store.list<{ nextAt: number; attempts: number; deliveredAt?: number }>(
      'notice',
    )[0];
    expect(notice.attempts).toBe(1);
    expect(notice.deliveredAt).toBeUndefined();
    await workbench.tick(notice.nextAt);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(store.list<{ deliveredAt: number }>('notice')[0].deliveredAt).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a readable, consistent SQLite backup without exporting credentials in diagnostics', async () => {
    await request('projects', { ...project, version: 0 });
    const backup = await request('backup', {});
    expect(backup.status).toBe(200);
    const restored = new DatabaseService(join(root, backup.body.file), new Logger('error'));
    expect(new WorkbenchStore(restored).get('project', 'demo')).toMatchObject({ version: 1 });
    restored.close();
    const diagnostics = await request('diagnostics');
    expect(diagnostics.body.includesCredentials).toBe(false);
    expect(JSON.stringify(diagnostics.body)).not.toContain(authorization.slice(7));
  });

  it('requires an explicit legacy publication migration choice', async () => {
    store.remove('migration', 'publication');
    writeFileSync(join(root, 'console-settings.json'), '{}');
    await workbench.stop();
    workbench = new Workbench(store, access, manager, { dataDir: root, createTask: create });
    expect(() =>
      workbench.prepare(
        { provider: 'codex', repository: 'acme/repo', prompt: 'fix' },
        access.account('admin'),
      ),
    ).toThrow('发布策略迁移');
    expect((await request('migration', { policy: 'auto' })).status).toBe(200);
    expect(
      workbench.prepare(
        { provider: 'codex', repository: 'acme/repo', prompt: 'fix' },
        access.account('admin'),
      ).policy,
    ).toBe('auto');
  });

  it('keeps interruption and later recovery completion as distinct atomic notice events', () => {
    const task = {
      id: 'recovered',
      provider: 'codex',
      providers: ['codex'],
      configurations: [],
      repository: 'acme/repo',
      prompt: 'fix',
      createPullRequest: false,
      status: 'interrupted',
      stopConfirmed: true,
      ownerId: 'admin',
      recoveryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      logs: [],
      attempts: [],
      turns: [{ id: 'same-turn', prompt: 'fix', status: 'failed', createdAt: Date.now() }],
      origin: { source: 'feishu', userId: 'owner', userName: 'Owner', commandId: 'cmd' },
    } as AgentTask;
    store.saveTask(task);
    task.status = 'review';
    task.recoveryCount = 1;
    task.turns[0].status = 'completed';
    store.saveTask(task);
    store.saveTask(task);
    const events = store.list<{ snapshot: AgentTask }>('notice');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.snapshot.status).sort()).toEqual(['interrupted', 'review']);
  });
});
