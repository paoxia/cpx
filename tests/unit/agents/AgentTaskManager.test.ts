import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawn: spawnMock }));

import { AgentTaskManager, normalizeRepository } from '../../../src/agents/AgentTaskManager';
import { Logger } from '../../../src/utils/Logger';

const TMP_DIR = join(process.cwd(), 'tmp-test-agent-tasks');

interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

let gitStatusOutput = '';
let holdAgent = false;
let agentInput = '';

function fakeProcess(stdout = '', stderr = '', code = 0, hold = false): FakeProcess {
  const child = new EventEmitter() as FakeProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on('data', (chunk) => {
    agentInput += chunk.toString('utf8');
  });
  let closed = false;
  const close = (exitCode: number | null) => {
    if (closed) return;
    closed = true;
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    queueMicrotask(() => child.emit('close', exitCode));
  };
  child.kill = vi.fn(() => {
    close(null);
    return true;
  });
  if (!hold) {
    queueMicrotask(() => close(code));
  }
  return child;
}

describe('AgentTaskManager', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    gitStatusOutput = '';
    holdAgent = false;
    agentInput = '';
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') {
        return fakeProcess(gitStatusOutput);
      }
      if (command === 'gh') {
        return fakeProcess('https://github.com/acme/repo/pull/42\n');
      }
      if (command === 'codex' || command === 'claude' || command === 'codebuddy') {
        return fakeProcess('{"type":"result","result":"done"}\n', '', 0, holdAgent);
      }
      return fakeProcess();
    });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('应规范化受支持的 GitHub 仓库地址', () => {
    expect(normalizeRepository('acme/repo')).toBe('https://github.com/acme/repo.git');
    expect(normalizeRepository('https://github.com/acme/repo')).toBe(
      'https://github.com/acme/repo.git',
    );
    expect(normalizeRepository('git@github.com:acme/repo.git')).toBe(
      'git@github.com:acme/repo.git',
    );
    expect(() => normalizeRepository('https://example.com/acme/repo')).toThrow('仅支持');
  });

  it('应执行 Codex 任务并保留本地工作区', async () => {
    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    manager.setSecrets({ openaiApiKey: 'test-openai-key' });

    const created = manager.create({
      provider: 'codex',
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    expect(created.status).toBe('queued');
    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));

    const task = manager.get(created.id)!;
    expect(task.agentBranch).toMatch(/^cpx\/task-/);
    expect(task.logs.some((entry) => entry.message === 'done')).toBe(true);
    expect(agentInput).toContain('用户任务：修复构建');
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', '--json', '--sandbox', 'workspace-write']),
      expect.objectContaining({
        env: expect.objectContaining({ OPENAI_API_KEY: 'test-openai-key' }),
      }),
    );
    await manager.stop();
  });

  it('有改动且获授权时应提交、推送并创建 Pull Request', async () => {
    gitStatusOutput = ' M README.md\n';
    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    const created = manager.create({
      provider: 'claude',
      repository: 'https://github.com/acme/repo',
      prompt: '更新说明',
      createPullRequest: true,
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));
    expect(manager.get(created.id)?.pullRequestUrl).toBe('https://github.com/acme/repo/pull/42');
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['push', '-u', 'origin', expect.stringMatching(/^cpx\/task-/)],
      expect.any(Object),
    );
    await manager.stop();
  });

  it('应取消正在运行的任务，并在停止后拒绝新任务', async () => {
    holdAgent = true;
    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    const created = manager.create({
      provider: 'codex',
      repository: 'acme/repo',
      prompt: '长任务',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('running'));
    expect(manager.cancel(created.id)).toBe(true);
    expect(manager.get(created.id)?.status).toBe('cancelled');
    await manager.stop();
    expect(() =>
      manager.create({ provider: 'codex', repository: 'acme/repo', prompt: '再次运行' }),
    ).toThrow('任务管理器已停止');
  });

  it('应在启动进程前拒绝无效输入', () => {
    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    expect(() =>
      manager.create({ provider: 'codex', repository: 'acme/repo', prompt: '   ' }),
    ).toThrow('任务指令不能为空');
    expect(() =>
      manager.create({
        provider: 'codex',
        repository: 'acme/repo',
        prompt: 'test',
        baseBranch: '../main',
      }),
    ).toThrow('基础分支名称无效');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('应使用 codebuddy 执行任务并注入 CODEBUDDY_API_KEY', async () => {
    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    manager.setSecrets({ codebuddyApiKey: 'test-codebuddy-key' });

    const created = manager.create({
      provider: 'codebuddy',
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    expect(created.status).toBe('queued');
    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));

    const task = manager.get(created.id)!;
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0]).toMatchObject({ provider: 'codebuddy', status: 'success' });
    expect(spawnMock).toHaveBeenCalledWith(
      'codebuddy',
      expect.arrayContaining(['-p', '-y', '--output-format', 'stream-json']),
      expect.objectContaining({
        env: expect.objectContaining({ CODEBUDDY_API_KEY: 'test-codebuddy-key' }),
      }),
    );
    await manager.stop();
  });

  it('主 Agent rate_limit 时应切换到备选并成功', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'gh') return fakeProcess('https://github.com/acme/repo/pull/42\n');
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') return fakeProcess('', 'Error: rate limit exceeded\n', 1);
      if (command === 'claude') return fakeProcess('{"type":"result","result":"done"}\n');
      return fakeProcess();
    });

    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    const created = manager.create({
      providers: ['codex', 'claude'],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));
    const task = manager.get(created.id)!;
    expect(task.attempts).toHaveLength(2);
    expect(task.attempts[0]).toMatchObject({
      provider: 'codex',
      status: 'failed',
      errorKind: 'rate_limit',
    });
    expect(task.attempts[1]).toMatchObject({ provider: 'claude', status: 'success' });

    const gitCloneCalls = spawnMock.mock.calls.filter(
      ([command, args]) => command === 'git' && args[0] === 'clone',
    );
    expect(gitCloneCalls).toHaveLength(1);
    await manager.stop();
  });

  it('所有 Agent rate_limit 失败时应标记 failed 并提供汇总', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'git') return fakeProcess('');
      if (command === 'codex' || command === 'claude' || command === 'codebuddy') {
        return fakeProcess('', 'HTTP 429 too many requests\n', 1);
      }
      return fakeProcess();
    });

    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    const created = manager.create({
      providers: ['codex', 'claude', 'codebuddy'],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('failed'));
    const task = manager.get(created.id)!;
    expect(task.attempts).toHaveLength(3);
    expect(task.attempts.every((a) => a.errorKind === 'rate_limit')).toBe(true);
    expect(task.error).toContain('Codex');
    expect(task.error).toContain('Claude Code');
    expect(task.error).toContain('CodeBuddy');
    await manager.stop();
  });

  it('非额度类错误应立即失败不 fallback', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') return fakeProcess('', 'syntax error in prompt\n', 2);
      if (command === 'claude') return fakeProcess('{"type":"result","result":"done"}\n');
      return fakeProcess();
    });

    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    const created = manager.create({
      providers: ['codex', 'claude'],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('failed'));
    const task = manager.get(created.id)!;
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].errorKind).toBe('crash');
    const claudeCalls = spawnMock.mock.calls.filter(([command]) => command === 'claude');
    expect(claudeCalls).toHaveLength(0);
    await manager.stop();
  });

  it('fallback 期间用户取消应中断循环', async () => {
    holdAgent = true;
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'gh') return fakeProcess('https://github.com/acme/repo/pull/42\n');
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') return fakeProcess('', '', 0, holdAgent);
      if (command === 'claude') return fakeProcess('{"type":"result","result":"done"}\n');
      return fakeProcess();
    });

    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    const created = manager.create({
      providers: ['codex', 'claude'],
      repository: 'acme/repo',
      prompt: '长任务',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('running'));
    expect(manager.cancel(created.id)).toBe(true);
    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('cancelled'));
    // close 事件异步触发后,attempt 才会被打上 cancelled 标签
    await vi.waitFor(() => {
      const task = manager.get(created.id)!;
      expect(task.attempts[task.attempts.length - 1]?.errorKind).toBe('cancelled');
    });

    const task = manager.get(created.id)!;
    const claudeCalls = spawnMock.mock.calls.filter(([command]) => command === 'claude');
    expect(claudeCalls).toHaveLength(0);
    await manager.stop();
  });

  it('中文额度关键字应被识别为 rate_limit', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') return fakeProcess('', '余额不足,请充值\n', 1);
      if (command === 'claude') return fakeProcess('{"type":"result","result":"done"}\n');
      return fakeProcess();
    });

    const manager = new AgentTaskManager(TMP_DIR, new Logger('error'));
    const created = manager.create({
      providers: ['codex', 'claude'],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));
    const task = manager.get(created.id)!;
    expect(task.attempts[0]).toMatchObject({
      provider: 'codex',
      errorKind: 'rate_limit',
    });
    expect(task.attempts[1]).toMatchObject({ provider: 'claude', status: 'success' });
    await manager.stop();
  });
});
