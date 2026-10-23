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
