import { randomBytes, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import { AgentTask, AgentTaskManager } from '../agents/AgentTaskManager';
import { HttpServer } from '../core/HttpServer';
import { Logger } from '../utils/Logger';
import { WorkbenchStore } from './Store';
import { AccessControl, digest } from './Access';

function uncertain(message: string): Error {
  const error = new Error(message);
  error.name = 'RemoteExecutionUnknownError';
  return error;
}

interface Worker {
  id: string;
  name: string;
  tokenHash: string;
  revoked?: boolean;
  lastSeen?: number;
  capabilities?: string[];
}
interface Job {
  id: string;
  taskId: string;
  turnId: string;
  workerId: string;
  task: AgentTask;
  status: 'queued' | 'claimed' | 'completed' | 'failed' | 'unknown' | 'cancelled';
  leaseHash?: string;
  expiresAt?: number;
  result?: { patch: string; response: string; webSearches?: number };
  error?: string;
}
const reportSchema = z.object({
  id: z.string(),
  lease: z.string(),
  patch: z
    .string()
    .max(4 * 1024 * 1024)
    .optional(),
  checksum: z.string().optional(),
  response: z.string().max(16384).optional(),
  error: z.string().max(2000).optional(),
  webSearches: z.number().int().min(0).max(10000).optional(),
});

export class RemoteExecutors {
  constructor(
    readonly store: WorkbenchStore,
    readonly access: AccessControl,
    readonly manager: AgentTaskManager,
    readonly enabled: () => boolean,
  ) {
    for (const job of store.list<Job>('remote-job')) {
      if (['queued', 'claimed'].includes(job.status)) {
        job.status = 'unknown';
        job.error = '控制端重启，需确认旧执行已经停止';
        store.put('remote-job', job.id, job);
      }
    }
    manager.setRemoteRunner((task) => this.run(task));
  }

  async run(task: AgentTask): Promise<{ patch: string; response: string; webSearches?: number }> {
    if (Buffer.byteLength(task.result?.diff ?? '') > 4 * 1024 * 1024)
      throw new Error('成果超过远程补丁 4 MiB 上限，请使用本机执行');
    const worker = this.store.get<Worker>('worker', task.executorId!);
    if (!this.enabled() || !worker || worker.revoked) throw new Error('远程执行器不可用或未启用');
    if (
      this.store
        .list<Job>('remote-job')
        .some((j) => j.workerId === worker.id && j.status === 'unknown')
    )
      throw new Error('该执行器有未核对执行，请确认旧任务停止后解除占用');
    const job: Job = {
      id: randomUUID(),
      taskId: task.id,
      turnId: task.turns[task.turns.length - 1].id,
      workerId: worker.id,
      task,
      status: 'queued',
    };
    this.store.put('remote-job', job.id, job);
    const deadline = Date.now() + (task.timeoutMs ?? 1800000);
    return new Promise((resolvePromise, reject) => {
      const timer = setInterval(() => {
        const current = this.store.get<Job>('remote-job', job.id)!;
        const state = this.manager.get(task.id)?.status;
        if (['cancelled', 'interrupted'].includes(state ?? '')) {
          current.status = 'cancelled';
          this.store.put('remote-job', job.id, current);
          clearInterval(timer);
          reject(new Error('远程任务已取消或中断'));
          return;
        }
        if (current.status === 'completed' && current.result) {
          clearInterval(timer);
          resolvePromise(current.result);
          return;
        }
        if (current.status === 'unknown' || current.status === 'cancelled') {
          clearInterval(timer);
          reject(uncertain(current.error || '执行已中断'));
          return;
        }
        if (current.status === 'failed') {
          clearInterval(timer);
          reject(new Error(current.error || '远程执行失败'));
          return;
        }
        if (
          !this.enabled() ||
          Date.now() > deadline ||
          (current.status === 'claimed' && (current.expiresAt ?? 0) < Date.now()) ||
          this.store.get<Worker>('worker', worker.id)?.revoked
        ) {
          current.status = 'unknown';
          current.error = '执行器失联或租约超时，必须先核对旧执行';
          this.store.put('remote-job', job.id, current);
          clearInterval(timer);
          reject(uncertain(current.error));
        }
      }, 1000);
    });
  }

  attach(server: HttpServer): void {
    server.register('GET', '/api/workbench/workers', async (_body, headers) => {
      if (this.access.principal(headers).role !== 'admin')
        return { status: 403, body: { error: '仅管理员可以操作' } };
      return {
        status: 200,
        body: this.store.list<Worker>('worker').map(({ tokenHash: _hash, ...worker }) => worker),
      };
    });
    server.register('POST', '/api/workbench/workers', async (raw, headers) => {
      if (this.access.principal(headers).role !== 'admin')
        return { status: 403, body: { error: '仅管理员可以操作' } };
      try {
        const { name } = z
          .object({ name: z.string().min(1).max(80) })
          .parse(JSON.parse(raw.toString()));
        const token = randomBytes(32).toString('hex');
        const worker: Worker = { id: randomUUID(), name, tokenHash: digest(token) };
        this.store.put('worker', worker.id, worker);
        return {
          status: 200,
          body: { id: worker.id, name, token },
          headers: { 'Cache-Control': 'no-store' },
        };
      } catch {
        return { status: 400, body: { error: '执行器名称无效' } };
      }
    });
    server.register('POST', '/api/workbench/worker-revoke', async (raw, headers) => {
      if (this.access.principal(headers).role !== 'admin')
        return { status: 403, body: { error: '仅管理员可以操作' } };
      const input = JSON.parse(raw.toString()) as { id: string };
      const worker = this.store.get<Worker>('worker', input.id);
      if (!worker) return { status: 404, body: { error: '执行器不存在' } };
      worker.revoked = true;
      this.store.put('worker', worker.id, worker);
      this.store.audit('admin', 'worker_revoke', worker.id);
      return { status: 200, body: { success: true } };
    });
    server.register('POST', '/api/workbench/worker-release', async (raw, headers) => {
      if (this.access.principal(headers).role !== 'admin')
        return { status: 403, body: { error: '仅管理员可以操作' } };
      const input = z
        .object({ id: z.string(), oldExecutionStopped: z.literal(true) })
        .parse(JSON.parse(raw.toString()));
      for (const job of this.store.list<Job>('remote-job'))
        if (job.workerId === input.id && job.status === 'unknown') {
          job.status = 'cancelled';
          this.store.put('remote-job', job.id, job);
        }
      this.store.audit('admin', 'worker_release', input.id);
      return { status: 200, body: { success: true } };
    });
    for (const action of ['claim', 'heartbeat', 'report']) {
      server.register('POST', `/api/worker/${action}`, async (raw, headers) => {
        const token = String(headers.authorization ?? '').replace(/^Bearer /, '');
        const worker = this.store
          .list<Worker>('worker')
          .find((w) => !w.revoked && w.tokenHash === digest(token));
        if (!worker || !this.enabled())
          return { status: 401, body: { error: '执行器未授权或未启用' } };
        try {
          worker.lastSeen = Date.now();
          this.store.put('worker', worker.id, worker);
          if (action === 'claim') {
            const input = z
              .object({ capabilities: z.array(z.string().max(50)).max(20).optional() })
              .parse(JSON.parse(raw.toString()));
            worker.capabilities = input.capabilities ?? worker.capabilities ?? [];
            this.store.put('worker', worker.id, worker);
            const jobs = this.store.list<Job>('remote-job');
            if (
              jobs.some(
                (j) => j.workerId === worker.id && ['claimed', 'unknown'].includes(j.status),
              )
            )
              return { status: 200, body: { job: null } };
            const job = [...jobs]
              .reverse()
              .find((j) => j.workerId === worker.id && j.status === 'queued');
            if (!job) return { status: 200, body: { job: null } };
            if (!worker.capabilities.includes('git-patch-v1'))
              return { status: 400, body: { error: '执行器未声明 git-patch-v1 能力' } };
            const lease = randomBytes(32).toString('hex');
            job.status = 'claimed';
            job.leaseHash = digest(lease);
            job.expiresAt = Date.now() + 90000;
            this.store.put('remote-job', job.id, job);
            this.store.audit(worker.id, 'remote_claim', job.taskId);
            return {
              status: 200,
              body: {
                job: {
                  id: job.id,
                  lease,
                  repository: job.task.repository,
                  baseBranch: job.task.baseBranch,
                  baseCommit: job.task.baseCommit,
                  seedPatch: job.task.result?.diff ?? '',
                  prompt: job.task.prompt,
                  context: job.task.context,
                  news: job.task.news,
                  webSearch: job.task.webSearch,
                  configurations: job.task.configurations,
                  timeoutMs: job.task.timeoutMs,
                  verificationCommands: job.task.verificationCommands,
                },
              },
            };
          }
          const input = reportSchema.parse(JSON.parse(raw.toString()));
          const job = this.store.get<Job>('remote-job', input.id);
          if (
            !job ||
            job.workerId !== worker.id ||
            job.status !== 'claimed' ||
            job.leaseHash !== digest(input.lease) ||
            (job.expiresAt ?? 0) < Date.now()
          )
            return { status: 409, body: { error: '租约无效或结果已处理' } };
          const state = this.manager.get(job.taskId)?.status;
          if (state !== 'running')
            return { status: 409, body: { error: '任务不再运行，请停止执行' } };
          if (action === 'heartbeat') {
            job.expiresAt = Date.now() + 90000;
            this.store.put('remote-job', job.id, job);
            return { status: 200, body: { success: true } };
          }
          if (input.error) {
            job.status = 'failed';
            job.error = input.error;
          } else {
            if (
              input.patch === undefined ||
              Buffer.byteLength(input.patch) > 4 * 1024 * 1024 ||
              input.checksum !== digest(input.patch)
            )
              throw new Error('成果校验失败');
            job.status = 'completed';
            job.result = {
              patch: input.patch,
              response: input.response ?? '',
              webSearches: input.webSearches,
            };
          }
          this.store.put('remote-job', job.id, job);
          this.store.audit(worker.id, 'remote_report', job.taskId);
          return { status: 200, body: { success: true } };
        } catch {
          return { status: 400, body: { error: '执行器请求无效' } };
        }
      });
    }
  }
}

interface RemoteJob {
  id: string;
  lease: string;
  repository: string;
  baseBranch?: string;
  baseCommit: string;
  seedPatch: string;
  prompt: string;
  context?: string;
  timeoutMs?: number;
  configurations: AgentTask['configurations'];
  news?: AgentTask['news'];
  webSearch?: AgentTask['webSearch'];
}

/** Development-machine worker. Never requires a terminal on the NAS. */
export async function runWorker(serverUrl: string, directory: string): Promise<void> {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('远程执行器要求 HTTPS（本机回环地址可使用 HTTP）');
  const token = process.env.CPX_WORKER_TOKEN;
  if (!token) throw new Error('请通过 CPX_WORKER_TOKEN 提供配对令牌');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'worker.pid');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error('此目录已有执行器运行');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    rmSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let stopping = false;
  let manager: AgentTaskManager | undefined;
  const stop = (): void => {
    stopping = true;
    void manager?.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const request = async (action: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(`/api/worker/${action}`, url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`执行器请求失败：${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  };
  try {
    while (!stopping) {
      let heartbeat: NodeJS.Timeout | undefined;
      let job: RemoteJob | undefined;
      try {
        job = (await request('claim', { capabilities: ['git-patch-v1', 'codex'] })).job as
          RemoteJob | undefined;
        if (!job) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
          continue;
        }
        manager = new AgentTaskManager(
          join(root, 'workspaces'),
          new Logger('warn'),
          join(root, 'repositories'),
        );
        manager.setSecrets({
          githubToken: process.env.AGENT_GITHUB_TOKEN,
          openaiApiKey: process.env.CODEX_API_KEY,
        });
        const task = manager.create({
          provider: 'codex',
          configurations: job.configurations,
          repository: job.repository,
          baseBranch: job.baseBranch,
          startCommit: job.baseCommit,
          seedPatch: job.seedPatch,
          prompt: job.prompt,
          context: job.context,
          news: job.news,
          webSearch: job.webSearch,
          timeoutMs: job.timeoutMs,
          policy: 'local',
        });
        const activeManager = manager;
        const activeJob = job;
        heartbeat = setInterval(() => {
          void request('heartbeat', { id: activeJob.id, lease: activeJob.lease }).catch(() => {
            void activeManager.stop();
          });
        }, 20000);
        const completed = await manager.waitForTerminal(task.id);
        if (!['review', 'completed'].includes(completed.status))
          throw new Error(completed.error ?? completed.status);
        const result = await manager.result(task.id);
        await request('report', {
          id: job.id,
          lease: job.lease,
          patch: result.diff,
          checksum: digest(result.diff),
          response: completed.lastAgentResponse,
          webSearches: completed.webSearches,
        });
      } catch (error) {
        console.error('远程执行失败：', error instanceof Error ? error.message : 'unknown');
        if (job)
          await request('report', {
            id: job.id,
            lease: job.lease,
            error: '远程执行失败，请在执行机检查脱敏日志',
          }).catch(() => undefined);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await manager?.stop();
        manager = undefined;
      }
    }
  } finally {
    rmSync(lock, { force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
