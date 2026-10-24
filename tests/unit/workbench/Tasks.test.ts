import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  AgentTaskManager,
  AgentTask,
  TaskRuntimeOptions,
} from '../../../src/agents/AgentTaskManager';
import { DatabaseService } from '../../../src/storage/Database';
import { WorkbenchStore } from '../../../src/workbench/Store';
import { Logger } from '../../../src/utils/Logger';

describe('durable tasks with real Git workspaces', () => {
  let root: string;
  let db: DatabaseService;
  let store: WorkbenchStore;
  let manager: AgentTaskManager;
  const logger = new Logger('error');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  function seed(status: AgentTask['status'] = 'completed'): AgentTask {
    const id = randomUUID();
    const workspace = join(root, 'workspaces', id);
    mkdirSync(workspace, { recursive: true });
    git(workspace, 'init', '-b', 'feature/task');
    git(workspace, 'config', 'user.name', 'Test');
    git(workspace, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(workspace, 'tracked.txt'), 'baseline\n');
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-m', 'baseline');
    const task: AgentTask = {
      id,
      ownerId: 'admin',
      provider: 'codex',
      providers: ['codex'],
      configurations: [{ id: 'default', provider: 'codex' }],
      repository: 'https://github.com/acme/repo.git',
      baseBranch: 'main',
      policy: 'review',
      createPullRequest: false,
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspace,
      repositoryPath: workspace,
      agentBranch: 'feature/task',
      baseCommit: git(workspace, 'rev-parse', 'HEAD'),
      threadId: 'old-thread',
      logs: [],
      attempts: [],
      turns: [{ id: randomUUID(), prompt: 'initial', status: 'completed', createdAt: Date.now() }],
      prompt: 'initial',
    };
    store.saveTask(task);
    return task;
  }
  function create(options: TaskRuntimeOptions = {}) {
    manager = new AgentTaskManager(join(root, 'workspaces'), logger, undefined, {
      store,
      ...options,
    });
    manager.start();
    return manager;
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cpx-tasks-'));
    db = new DatabaseService(join(root, 'agent.db'), logger);
    store = new WorkbenchStore(db);
  });
  afterEach(async () => {
    await manager?.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('restores running tasks as interrupted and resumes only on request', async () => {
    const original = seed('running');
    let runs = 0;
    create({
      runAgent: async () => {
        runs++;
      },
    });
    expect(manager.get(original.id)?.status).toBe('interrupted');
    expect(runs).toBe(0);
    manager.resume(original.id, true);
    expect((await manager.waitForTerminal(original.id)).status).toBe('review');
    expect(runs).toBe(1);
    expect(manager.get(original.id)?.threadId).toBeUndefined();
    expect(store.loadTasks()[0].status).toBe('review');
  });

  it('captures committed, uncommitted and untracked changes without modifying the real index', async () => {
    const task = seed();
    create({
      runAgent: async (_task, workspace) => {
        writeFileSync(join(workspace, 'tracked.txt'), 'committed\n');
        git(workspace, 'add', '-A');
        git(workspace, 'commit', '-m', 'agent change');
        writeFileSync(join(workspace, 'new.txt'), 'untracked\n');
      },
    });
    manager.continueTask(task.id, {
      prompt: 'make changes',
      verificationCommands: [{ command: process.execPath, args: ['-e', 'console.log("passed")'] }],
    });
    const completed = await manager.waitForTerminal(task.id);
    expect(completed.result?.diff).toContain('+committed');
    expect(completed.result?.diff).toContain('+untracked');
    expect(completed.verification?.[0].exitCode).toBe(0);
    expect(git(task.workspace!, 'status', '--porcelain')).toContain('?? new.txt');
    const saved = store.loadTasks()[0];
    expect(saved.turns).toHaveLength(2);
    expect(saved.result?.version).toBe(completed.result?.version);
  });

  it('preserves results when verification fails and prevents publication', async () => {
    const task = seed();
    create({
      runAgent: async (_task, workspace) => {
        writeFileSync(join(workspace, 'tracked.txt'), 'changed\n');
      },
    });
    manager.continueTask(task.id, {
      prompt: 'fix',
      verificationCommands: [
        {
          command: process.execPath,
          args: ['-e', 'console.error("failed check");process.exit(2)'],
        },
      ],
    });
    const completed = await manager.waitForTerminal(task.id);
    expect(completed.status).toBe('review');
    expect(completed.verification?.[0].exitCode).toBe(2);
    expect(completed.verification?.[0].output).toContain('failed check');
    expect(readFileSync(join(task.workspace!, 'tracked.txt'), 'utf8')).toBe('changed\n');
    await expect(manager.publish(task.id, completed.result!.version)).rejects.toThrow('验证失败');
  });

  it('rejects publication when the reviewed result has changed', async () => {
    const task = seed();
    create();
    const result = await manager.result(task.id);
    writeFileSync(join(task.workspace!, 'tracked.txt'), 'changed after review\n');
    await expect(manager.publish(task.id, result.version)).rejects.toThrow('成果版本已变化');
    expect(manager.get(task.id)?.publication?.status).toBe('failed');
    expect(manager.get(task.id)?.status).toBe('completed');
  });

  it('rejects repository URL rewrites before starting any privileged publisher process', async () => {
    const task = seed();
    let privileged = 0;
    create({
      runGitHub: async () => {
        privileged++;
        return { stdout: '', stderr: '' };
      },
    });
    writeFileSync(join(task.workspace!, 'tracked.txt'), 'change\n');
    git(
      task.workspace!,
      'config',
      'url.https://attacker.invalid/.insteadOf',
      'https://github.com/',
    );
    const result = await manager.result(task.id);
    await expect(manager.publish(task.id, result.version)).rejects.toThrow('发布认证或目标');
    expect(privileged).toBe(0);
  });

  it('enforces concurrency and deduplicates continuation requests across restart', async () => {
    const tasks = [seed(), seed(), seed()];
    let running = 0;
    let maximum = 0;
    create({
      concurrency: 1,
      runAgent: async () => {
        running++;
        maximum = Math.max(maximum, running);
        await new Promise((resolve) => setTimeout(resolve, 30));
        running--;
      },
    });
    for (const task of tasks)
      manager.continueTask(task.id, { prompt: 'queued', idempotencyKey: `round:${task.id}` });
    await Promise.all(tasks.map((task) => manager.waitForTerminal(task.id)));
    expect(maximum).toBe(1);
    await manager.stop();
    create();
    const duplicate = manager.continueTask(tasks[0].id, {
      prompt: 'queued',
      idempotencyKey: `round:${tasks[0].id}`,
    });
    expect(duplicate.turns).toHaveLength(2);
    expect(manager.runtime().queued).toBe(0);
  });

  it('keeps the original creation idempotency key after later rounds and restart', async () => {
    const task = seed();
    task.idempotencyKey = 'original-create';
    store.saveTask(task);
    create({ runAgent: async () => undefined });
    manager.continueTask(task.id, { prompt: 'later', idempotencyKey: 'later-round' });
    await manager.waitForTerminal(task.id);
    await manager.stop();
    create();
    const duplicate = manager.create({
      provider: 'codex',
      ownerId: 'admin',
      repository: 'acme/repo',
      prompt: 'initial',
      idempotencyKey: 'original-create',
    });
    expect(duplicate.id).toBe(task.id);
    expect(duplicate.turns).toHaveLength(2);
    expect(manager.runtime().queued).toBe(0);
  });

  it('protects unpublished workspaces from cleanup and supports pending input withdrawal', async () => {
    const task = seed();
    create();
    const inputId = manager.queueInput(task.id, 'later change');
    expect(manager.get(task.id)?.pendingInputs).toHaveLength(1);
    manager.removeInput(task.id, inputId);
    expect(manager.get(task.id)?.pendingInputs).toHaveLength(0);
    writeFileSync(join(task.workspace!, 'unpublished.txt'), 'keep me');
    manager.archive(task.id);
    const preview = await manager.cleanupPreview(task.id);
    expect(preview.safe).toBe(false);
    await expect(manager.cleanup(task.id, preview.version)).rejects.toThrow('清理条件');
    expect(readFileSync(join(task.workspace!, 'unpublished.txt'), 'utf8')).toBe('keep me');
  });

  it('generates a dated news report but fails when the agent changes unrelated files', async () => {
    const task = seed();
    create({
      runAgent: async (active, workspace) => {
        active.webSearches = 1;
        mkdirSync(join(workspace, 'news'));
        writeFileSync(
          join(workspace, 'news/2026-10-24.sources.json'),
          JSON.stringify({
            items: [
              {
                title: 'An announcement',
                url: 'https://example.com/announcement',
                publishedAt: '2026-10-24T00:00:00Z',
                summary: '官方公告摘要',
              },
            ],
          }),
        );
        writeFileSync(join(workspace, 'tracked.txt'), 'unrelated change');
      },
    });
    manager.continueTask(task.id, {
      prompt: 'news',
      webSearch: 'live',
      news: {
        directory: 'news',
        date: '2026-10-24',
        since: Date.parse('2026-10-23T01:00:00Z'),
        until: Date.parse('2026-10-24T01:00:00Z'),
        maxItems: 10,
        timeZone: 'Asia/Shanghai',
      },
    });
    const completed = await manager.waitForTerminal(task.id);
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('当天新闻文件以外');
    expect(readFileSync(join(task.workspace!, 'news/2026-10-24.md'), 'utf8')).toContain(
      '官方公告摘要',
    );
    await expect(manager.publish(task.id, completed.result!.version)).rejects.toThrow('先恢复');
  });

  it('validates news output before publishing the generated Markdown and source manifest', async () => {
    const task = seed();
    task.policy = 'auto';
    store.saveTask(task);
    const remoteCalls: string[][] = [];
    create({
      runAgent: async (active, workspace) => {
        active.webSearches = 1;
        mkdirSync(join(workspace, 'news'));
        writeFileSync(
          join(workspace, 'news/2026-10-24.sources.json'),
          JSON.stringify({
            items: [
              {
                title: 'Official news',
                url: 'https://example.com/official',
                publishedAt: '2026-10-24T00:00:00Z',
                summary: '官方新闻摘要',
              },
            ],
          }),
        );
      },
      runGitHub: async (_task, command, args) => {
        remoteCalls.push(args);
        return {
          stdout:
            command === 'gh'
              ? args[1] === 'list'
                ? '[]'
                : 'https://github.com/acme/repo/pull/42'
              : '',
          stderr: '',
        };
      },
    });
    manager.continueTask(task.id, {
      prompt: 'news',
      news: {
        directory: 'news',
        date: '2026-10-24',
        since: Date.parse('2026-10-23T01:00:00Z'),
        until: Date.parse('2026-10-24T01:00:00Z'),
        maxItems: 10,
        timeZone: 'Asia/Shanghai',
      },
    });
    const completed = await manager.waitForTerminal(task.id);
    expect(completed.publication?.status).toBe('published');
    expect(completed.result?.diff).toContain('官方新闻摘要');
    expect(completed.result?.files).toContain('2026-10-24.md');
    expect(completed.result?.files).toContain('2026-10-24.sources.json');
    expect(remoteCalls.some((args) => args[0] === 'push')).toBe(true);
    expect(completed.merge).toBeUndefined();
  });

  it.each(['head', 'base', 'branch', 'repository'])(
    'refuses automatic merging when the PR %s differs',
    async (mismatch) => {
      const task = seed();
      task.autoMerge = true;
      store.saveTask(task);
      let merges = 0;
      create({
        runGitHub: async (_task, command, args) => {
          if (command === 'git') return { stdout: '', stderr: '' };
          if (args[1] === 'list') return { stdout: '[]', stderr: '' };
          if (args[1] === 'create')
            return {
              stdout: `https://github.com/${mismatch === 'repository' ? 'other/repo' : 'acme/repo'}/pull/42`,
              stderr: '',
            };
          if (args[1] === 'view')
            return {
              stdout: JSON.stringify({
                state: 'OPEN',
                headRefOid:
                  mismatch === 'head' ? 'f'.repeat(40) : git(task.workspace!, 'rev-parse', 'HEAD'),
                baseRefName: mismatch === 'base' ? 'other' : 'main',
                headRefName: mismatch === 'branch' ? 'other' : 'feature/task',
              }),
              stderr: '',
            };
          merges++;
          return { stdout: '', stderr: '' };
        },
      });
      writeFileSync(join(task.workspace!, 'tracked.txt'), 'publication\n');
      const result = await manager.result(task.id);
      await expect(manager.publish(task.id, result.version)).rejects.toThrow();
      expect(merges).toBe(0);
      expect(manager.get(task.id)?.merge?.status).toBe('failed');
      expect(manager.get(task.id)?.publication?.status).toBe('failed');
    },
  );

  it('retries a failed merge request on the same PR without rerunning development', async () => {
    const task = seed();
    task.autoMerge = true;
    store.saveTask(task);
    let created = false;
    let fail = true;
    const merges: string[][] = [];
    create({
      runGitHub: async (_task, command, args) => {
        if (command === 'git') return { stdout: '', stderr: '' };
        expect(args).toContain('--repo');
        expect(args).toContain('acme/repo');
        if (args[1] === 'list')
          return {
            stdout: created ? '[{"url":"https://github.com/acme/repo/pull/42"}]' : '[]',
            stderr: '',
          };
        if (args[1] === 'create') {
          created = true;
          return { stdout: 'https://github.com/acme/repo/pull/42', stderr: '' };
        }
        if (args[1] === 'view')
          return {
            stdout: JSON.stringify({
              state: 'OPEN',
              headRefOid: git(task.workspace!, 'rev-parse', 'HEAD'),
              baseRefName: 'main',
              headRefName: 'feature/task',
            }),
            stderr: '',
          };
        merges.push(args);
        if (fail) throw new Error('Auto merge unavailable');
        return { stdout: '', stderr: '' };
      },
    });
    writeFileSync(join(task.workspace!, 'tracked.txt'), 'publication\n');
    const result = await manager.result(task.id);
    await expect(manager.publish(task.id, result.version)).rejects.toThrow('Auto merge');
    expect(manager.get(task.id)?.pullRequestUrl).toContain('/pull/42');
    fail = false;
    const retry = await manager.result(task.id);
    const published = await manager.publish(task.id, retry.version);
    expect(published.merge?.status).toBe('requested');
    expect(published.publication?.status).toBe('published');
    expect(merges[1]).toEqual(
      expect.arrayContaining([
        '42',
        '--auto',
        '--squash',
        '--match-head-commit',
        git(task.workspace!, 'rev-parse', 'HEAD'),
      ]),
    );
    expect(merges[1]).not.toContain('--admin');
  });

  it('reconciles a PR created before interruption and retries publication without rerunning development', async () => {
    const task = seed();
    const remote = join(root, 'remote.git');
    create({
      runGitHub: async (_task, command, args, cwd) => {
        const localArgs =
          command === 'git'
            ? args.map((value) => (value === task.repository ? remote : value))
            : args;
        return {
          stdout: execFileSync(command, localArgs, {
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
          stderr: '',
        };
      },
    });
    mkdirSync(remote);
    git(remote, 'init', '--bare');
    git(task.workspace!, 'remote', 'add', 'origin', remote);
    writeFileSync(join(task.workspace!, 'tracked.txt'), 'publish me\n');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const flag = join(root, 'pr-created');
    const count = join(root, 'create-count');
    writeFileSync(
      join(bin, 'gh'),
      `#!${process.execPath}\nconst fs=require('fs'); const args=process.argv.slice(2); if(args[1]==='list') {console.log(fs.existsSync(${JSON.stringify(flag)}) ? JSON.stringify([{url:'https://github.com/acme/repo/pull/42'}]) : '[]');} else {fs.appendFileSync(${JSON.stringify(count)},'create\\n');fs.writeFileSync(${JSON.stringify(flag)},'created');process.exit(1);}`,
    );
    chmodSync(join(bin, 'gh'), 0o700);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      const reviewed = await manager.result(task.id);
      await expect(manager.publish(task.id, reviewed.version)).rejects.toThrow();
      expect(manager.get(task.id)?.status).toBe('completed');
      expect(manager.get(task.id)?.publication?.status).toBe('failed');
      const head = git(task.workspace!, 'rev-parse', 'HEAD');
      const retry = await manager.result(task.id);
      const published = await manager.publish(task.id, retry.version);
      expect(published.pullRequestUrl).toBe('https://github.com/acme/repo/pull/42');
      expect(published.publication?.status).toBe('published');
      expect(git(task.workspace!, 'rev-parse', 'HEAD')).toBe(head);
      expect(readFileSync(count, 'utf8')).toBe('create\n');
      expect(git(remote, 'show', 'refs/heads/feature/task:tracked.txt')).toBe('publish me');
    } finally {
      process.env.PATH = previous;
    }
  });
});
