import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseService } from '../../../src/storage/Database';
import { Logger } from '../../../src/utils/Logger';
import { WorkbenchStore } from '../../../src/workbench/Store';
import { AccessControl, digest } from '../../../src/workbench/Access';
import { RemoteExecutors } from '../../../src/workbench/Remote';
import { AgentTaskManager, AgentTask } from '../../../src/agents/AgentTaskManager';
import { HttpServer } from '../../../src/core/HttpServer';

describe('remote executor pairing and fenced leases', () => {
  let root: string;
  let db: DatabaseService;
  let store: WorkbenchStore;
  let server: HttpServer;
  let base: string;
  let remote: RemoteExecutors;
  let adminToken: string;
  let task: AgentTask;
  const post = async (path: string, token: string, body = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cpx-remote-'));
    db = new DatabaseService(join(root, 'agent.db'), new Logger('error'));
    store = new WorkbenchStore(db);
    store.put('account', 'admin', { id: 'admin', name: 'Admin', role: 'admin', projects: [] });
    const access = new AccessControl(store, root);
    adminToken = access.issue('admin', 'test').token;
    task = {
      id: 'task',
      status: 'running',
      turns: [{ id: 'turn' }],
      configurations: [{ id: 'default', provider: 'codex' }],
      prompt: 'fix',
      repository: 'https://github.com/acme/repo.git',
      baseCommit: 'a'.repeat(40),
      timeoutMs: 10000,
    } as AgentTask;
    const manager = {
      setRemoteRunner: () => undefined,
      get: () => task,
    } as unknown as AgentTaskManager;
    remote = new RemoteExecutors(store, access, manager, () => true);
    server = new HttpServer(0, '127.0.0.1', new Logger('error'));
    access.attach(server, () => task);
    remote.attach(server);
    await server.start();
    base = `http://127.0.0.1:${server.getPort()}`;
  });
  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('issues one-time worker tokens, checks result hashes and rejects duplicate reports', async () => {
    const paired = await post('/api/workbench/workers', adminToken, { name: 'Dev machine' });
    task.executorId = paired.body.id;
    expect(JSON.stringify(store.list('worker'))).not.toContain(paired.body.token);
    const result = remote.run(task);
    expect((await post('/api/worker/claim', 'invalid')).status).toBe(401);
    const claim = await post('/api/worker/claim', paired.body.token, {
      capabilities: ['git-patch-v1'],
    });
    const job = claim.body.job;
    expect(job.baseCommit).toBe(task.baseCommit);
    expect(JSON.stringify(job)).not.toContain(adminToken);
    expect((await post('/api/worker/claim', paired.body.token)).body.job).toBeNull();
    expect(
      (
        await post('/api/worker/report', paired.body.token, {
          id: job.id,
          lease: job.lease,
          patch: '',
          checksum: 'wrong',
        })
      ).status,
    ).toBe(400);
    const body = {
      id: job.id,
      lease: job.lease,
      patch: '',
      checksum: digest(''),
      response: 'done',
    };
    expect((await post('/api/worker/report', paired.body.token, body)).status).toBe(200);
    expect((await post('/api/worker/report', paired.body.token, body)).status).toBe(409);
    expect(await result).toEqual({ patch: '', response: 'done' });
  });

  it('fences expired executions, refuses late results and requires explicit release', async () => {
    const paired = await post('/api/workbench/workers', adminToken, { name: 'Dev' });
    task.executorId = paired.body.id;
    const result = remote.run(task);
    const failure = expect(result).rejects.toThrow('租约超时');
    const job = (
      await post('/api/worker/claim', paired.body.token, { capabilities: ['git-patch-v1'] })
    ).body.job;
    const saved = store.get<Record<string, unknown>>('remote-job', job.id)!;
    saved.expiresAt = Date.now() - 1;
    store.put('remote-job', job.id, saved);
    expect(
      (await post('/api/worker/heartbeat', paired.body.token, { id: job.id, lease: job.lease }))
        .status,
    ).toBe(409);
    await failure;
    expect(
      (
        await post('/api/worker/report', paired.body.token, {
          id: job.id,
          lease: job.lease,
          patch: '',
          checksum: digest(''),
        })
      ).status,
    ).toBe(409);
    await expect(remote.run(task)).rejects.toThrow('未核对执行');
    expect(
      (
        await post('/api/workbench/worker-release', adminToken, {
          id: paired.body.id,
          oldExecutionStopped: true,
        })
      ).status,
    ).toBe(200);
    await post('/api/workbench/worker-revoke', adminToken, { id: paired.body.id });
    expect((await post('/api/worker/claim', paired.body.token)).status).toBe(401);
  });
});
