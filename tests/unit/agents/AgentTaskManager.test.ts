import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawn: spawnMock }));

import {
  AgentTaskManager,
  normalizeRepository,
  repositoryCoordinates,
} from '../../../src/agents/AgentTaskManager';
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

function createManager(): AgentTaskManager {
  return new AgentTaskManager(
    join(TMP_DIR, 'workspaces'),
    new Logger('error'),
    join(TMP_DIR, 'repositories'),
  );
}

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
      if (command === 'git' && args[0] === 'clone') {
        mkdirSync(join(args[args.length - 1], '.git'), { recursive: true });
        return fakeProcess();
      }
      if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(args[4], { recursive: true });
        return fakeProcess();
      }
      if (command === 'git' && args[0] === 'status') {
        return fakeProcess(gitStatusOutput);
      }
      if (command === 'gh') {
        return fakeProcess('https://github.com/acme/repo/pull/42\n');
      }
      if (command === 'codex') {
        return fakeProcess(
          '{"type":"thread.started","thread_id":"thread-1"}\n{"type":"result","result":"done"}\n',
          '',
          0,
          holdAgent,
        );
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
    expect(repositoryCoordinates('git@github.com:acme/repo.git')).toEqual({
      owner: 'acme',
      repository: 'repo',
    });
    expect(() => normalizeRepository('https://example.com/acme/repo')).toThrow('仅支持');
  });

  it('应执行 Codex 任务并保留本地工作区', async () => {
    const manager = createManager();
    manager.setSecrets({ openaiApiKey: 'test-openai-key' });

    const created = manager.create({
      provider: 'codex',
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    expect(created.status).toBe('queued');
    const terminal = await manager.waitForTerminal(created.id);
    expect(terminal.status).toBe('completed');

    const task = manager.get(created.id)!;
    expect(task.agentBranch).toMatch(/^cpx\/task-/);
    expect(task.lastAgentResponse).toBe('done');
    expect(task.logs.some((entry) => entry.message === 'done')).toBe(true);
    expect(agentInput).toContain('用户任务：修复构建');
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', '--json', '--color', 'never']),
      expect.objectContaining({
        env: expect.objectContaining({ CODEX_API_KEY: 'test-openai-key' }),
      }),
    );
    await expect(manager.waitForTerminal('missing-task')).rejects.toThrow('任务不存在');
    await manager.stop();
  });

  it('未指定基础分支时更新远端 HEAD 也必须注入 GitHub 凭据', async () => {
    const manager = createManager();
    manager.setSecrets({ githubToken: 'github_pat_head-secret' });
    const created = manager.create({
      provider: 'codex',
      repository: 'acme/repo',
      prompt: '使用默认分支',
    });
    await manager.waitForTerminal(created.id);

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['remote', 'set-head', 'origin', '--auto'],
      expect.objectContaining({
        env: expect.objectContaining({
          GH_TOKEN: 'github_pat_head-secret',
          CPX_GITHUB_TOKEN: 'github_pat_head-secret',
          GIT_ASKPASS: expect.stringContaining('.github-askpass'),
          GIT_TERMINAL_PROMPT: '0',
        }),
      }),
    );
    await manager.stop();
  });

  it('同一 GitHub 仓库的后续任务应 fetch 缓存并创建新的 worktree', async () => {
    const manager = createManager();
    manager.setSecrets({ githubToken: 'github_pat_cache-secret' });
    const first = manager.create({
      provider: 'codex',
      repository: 'acme/repo',
      baseBranch: 'main',
      prompt: '第一项任务',
    });
    await manager.waitForTerminal(first.id);
    const second = manager.create({
      provider: 'codex',
      repository: 'https://github.com/acme/repo',
      baseBranch: 'main',
      prompt: '第二项任务',
    });
    await manager.waitForTerminal(second.id);

    expect(
      spawnMock.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'clone'),
    ).toHaveLength(1);
    expect(
      spawnMock.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'fetch'),
    ).toHaveLength(2);
    expect(
      spawnMock.mock.calls.filter(
        ([command, args]) => command === 'git' && args[0] === 'worktree' && args[1] === 'add',
      ),
    ).toHaveLength(2);
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['remote', 'set-url', 'origin', 'https://github.com/acme/repo.git'],
      expect.objectContaining({
        env: expect.objectContaining({
          CPX_GITHUB_TOKEN: 'github_pat_cache-secret',
          GIT_ASKPASS: expect.stringContaining('.github-askpass'),
        }),
      }),
    );
    await manager.stop();
  });

  it('应在同一 worktree 和 Codex 会话中继续追加指令', async () => {
    const manager = createManager();
    const created = manager.create({
      provider: 'codex',
      repository: 'acme/repo',
      baseBranch: 'main',
      prompt: '先完成第一轮',
    });
    const first = await manager.waitForTerminal(created.id);
    expect(first.threadId).toBe('thread-1');
    expect(first.repositoryPath).toBe(join(TMP_DIR, 'repositories', 'acme', 'repo'));
    const cloneCalls = spawnMock.mock.calls.filter(
      ([command, args]) => command === 'git' && args[0] === 'clone',
    ).length;

    const continued = manager.continueTask(created.id, { prompt: '继续补充测试' });
    expect(continued.status).toBe('queued');
    const second = await manager.waitForTerminal(created.id);

    expect(second.status).toBe('completed');
    expect(second.workspace).toBe(first.workspace);
    expect(second.turns.map((turn) => turn.prompt)).toEqual(['先完成第一轮', '继续补充测试']);
    expect(
      spawnMock.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'clone'),
    ).toHaveLength(cloneCalls);
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', 'resume', '--json', 'thread-1', '-']),
      expect.objectContaining({ cwd: first.workspace }),
    );
    expect(agentInput).toContain('用户任务：继续补充测试');
    await manager.stop();
  });

  it('有改动且获授权时应提交、推送并创建 Pull Request', async () => {
    gitStatusOutput = ' M README.md\n';
    const manager = createManager();
    manager.setSecrets({ githubToken: 'github_pat_task-secret' });
    const created = manager.create({
      provider: 'codex',
      repository: 'https://github.com/acme/repo',
      prompt: '更新说明',
      baseBranch: 'develop',
      taskBranch: 'feature/update-docs',
      createPullRequest: true,
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));
    expect(manager.get(created.id)?.pullRequestUrl).toBe('https://github.com/acme/repo/pull/42');
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        '--no-checkout',
        'https://github.com/acme/repo.git',
        join(TMP_DIR, 'repositories', 'acme', 'repo'),
      ],
      expect.objectContaining({
        env: expect.objectContaining({ GH_TOKEN: 'github_pat_task-secret' }),
      }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      expect.objectContaining({
        env: expect.objectContaining({
          GH_TOKEN: 'github_pat_task-secret',
          CPX_GITHUB_TOKEN: 'github_pat_task-secret',
          GIT_ASKPASS: expect.stringContaining('.github-askpass'),
          GIT_TERMINAL_PROMPT: '0',
        }),
      }),
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'git',
      ['remote', 'set-head', 'origin', '--auto'],
      expect.anything(),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      [
        'worktree',
        'add',
        '-b',
        'feature/update-docs',
        expect.any(String),
        'refs/remotes/origin/develop',
      ],
      expect.objectContaining({ cwd: join(TMP_DIR, 'repositories', 'acme', 'repo') }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['push', '-u', 'origin', 'feature/update-docs'],
      expect.objectContaining({
        env: expect.objectContaining({
          GH_TOKEN: 'github_pat_task-secret',
          CPX_GITHUB_TOKEN: 'github_pat_task-secret',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: '',
          GIT_ASKPASS: expect.stringContaining('.github-askpass'),
        }),
      }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'gh',
      ['pr', 'create', '--fill', '--head', 'feature/update-docs', '--base', 'develop'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_TOKEN: 'github_pat_task-secret' }),
      }),
    );
    expect(JSON.stringify(manager.get(created.id)?.logs)).not.toContain('github_pat_task-secret');
    expect(manager.get(created.id)?.agentBranch).toBe('feature/update-docs');
    await manager.stop();
  });

  it('应取消正在运行的任务，并在停止后拒绝新任务', async () => {
    holdAgent = true;
    const manager = createManager();
    const created = manager.create({
      provider: 'codex',
      repository: 'acme/repo',
      prompt: '长任务',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('running'));
    const terminalPromise = manager.waitForTerminal(created.id);
    expect(manager.cancel(created.id)).toBe(true);
    expect(manager.get(created.id)?.status).toBe('cancelled');
    await expect(terminalPromise).resolves.toMatchObject({ status: 'cancelled' });
    await manager.stop();
    expect(() =>
      manager.create({ provider: 'codex', repository: 'acme/repo', prompt: '再次运行' }),
    ).toThrow('任务管理器已停止');
  });

  it('应在启动进程前拒绝无效输入', () => {
    const manager = createManager();
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
    expect(() =>
      manager.create({
        provider: 'codex',
        repository: 'acme/repo',
        prompt: 'test',
        baseBranch: 'main',
        taskBranch: 'main',
      }),
    ).toThrow('新分支不能与基础分支同名');
    expect(() =>
      manager.create({
        provider: 'codex',
        repository: 'acme/repo',
        prompt: 'test',
        taskBranch: 'feature//bad',
      }),
    ).toThrow('新分支名称无效');
    expect(() =>
      manager.create({
        repository: 'acme/repo',
        prompt: 'test',
        configurations: [
          {
            id: 'unsafe-gateway',
            provider: 'codex',
            baseUrl: 'https://secret@example.com/v1#token',
          },
        ],
      }),
    ).toThrow('Base URL');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('主 Agent rate_limit 时应切换到备选并成功', async () => {
    let codexCalls = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'gh') return fakeProcess('https://github.com/acme/repo/pull/42\n');
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') {
        codexCalls += 1;
        return codexCalls === 1
          ? fakeProcess('', 'Error: rate limit exceeded\n', 1)
          : fakeProcess('{"type":"result","result":"done"}\n');
      }
      return fakeProcess();
    });

    const manager = createManager();
    const created = manager.create({
      configurations: [
        { id: 'primary', provider: 'codex' },
        { id: 'backup', provider: 'codex' },
      ],
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
    expect(task.attempts[1]).toMatchObject({
      configurationId: 'backup',
      provider: 'codex',
      status: 'success',
    });

    const gitCloneCalls = spawnMock.mock.calls.filter(
      ([command, args]) => command === 'git' && args[0] === 'clone',
    );
    expect(gitCloneCalls).toHaveLength(1);
    await manager.stop();
  });

  it('应按模型配置顺序使用各自的模型与 API Key，并允许同一 Agent 重复出现', async () => {
    let codexCalls = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') {
        codexCalls += 1;
        return codexCalls === 1
          ? fakeProcess('', 'HTTP 429 too many requests\n', 1)
          : fakeProcess('{"type":"result","result":"done"}\n');
      }
      return fakeProcess();
    });

    const manager = createManager();
    const created = manager.create({
      configurations: [
        {
          id: 'codex-fast',
          provider: 'codex',
          model: 'gpt-fast',
          reasoningEffort: 'low',
          baseUrl: 'https://gateway.example.com/v1/',
          apiKey: 'key-fast',
        },
        {
          id: 'codex-deep',
          provider: 'codex',
          model: 'gpt-deep',
          reasoningEffort: 'ultra',
          baseUrl: 'https://backup.example.com/v1',
          apiKey: 'key-deep',
        },
      ],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    expect(JSON.stringify(created)).not.toContain('key-fast');
    expect(created.configurations).toEqual([
      {
        id: 'codex-fast',
        provider: 'codex',
        model: 'gpt-fast',
        reasoningEffort: 'low',
        baseUrl: 'https://gateway.example.com/v1',
      },
      {
        id: 'codex-deep',
        provider: 'codex',
        model: 'gpt-deep',
        reasoningEffort: 'ultra',
        baseUrl: 'https://backup.example.com/v1',
      },
    ]);
    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));

    const task = manager.get(created.id)!;
    expect(task.attempts).toMatchObject([
      { configurationId: 'codex-fast', provider: 'codex', model: 'gpt-fast', status: 'failed' },
      { configurationId: 'codex-deep', provider: 'codex', model: 'gpt-deep', status: 'success' },
    ]);
    const calls = spawnMock.mock.calls.filter(([command]) => command === 'codex');
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual(expect.arrayContaining(['--model', 'gpt-fast']));
    expect(calls[0][1]).toEqual(
      expect.arrayContaining(['--config', 'openai_base_url="https://gateway.example.com/v1"']),
    );
    expect(calls[0][1]).toEqual(
      expect.arrayContaining(['--config', 'model_reasoning_effort="low"']),
    );
    expect(calls[0][2]).toEqual(
      expect.objectContaining({ env: expect.objectContaining({ CODEX_API_KEY: 'key-fast' }) }),
    );
    expect(calls[1][1]).toEqual(expect.arrayContaining(['--model', 'gpt-deep']));
    expect(calls[1][1]).toEqual(
      expect.arrayContaining(['--config', 'model_reasoning_effort="ultra"']),
    );
    expect(calls[1][2]).toEqual(
      expect.objectContaining({ env: expect.objectContaining({ CODEX_API_KEY: 'key-deep' }) }),
    );
    await manager.stop();
  });

  it('所有 Agent rate_limit 失败时应标记 failed 并提供汇总', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') {
        return fakeProcess('', 'HTTP 429 too many requests\n', 1);
      }
      return fakeProcess();
    });

    const manager = createManager();
    const created = manager.create({
      configurations: [
        { id: 'primary', provider: 'codex' },
        { id: 'backup', provider: 'codex' },
      ],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('failed'));
    const task = manager.get(created.id)!;
    expect(task.attempts).toHaveLength(2);
    expect(task.attempts.every((a) => a.errorKind === 'rate_limit')).toBe(true);
    expect(task.error).toContain('Codex');
    expect(task.attempts.map((attempt) => attempt.configurationId)).toEqual(['primary', 'backup']);
    await manager.stop();
  });

  it('非额度类错误应立即失败不 fallback', async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') return fakeProcess('', 'syntax error in prompt\n', 2);
      return fakeProcess();
    });

    const manager = createManager();
    const created = manager.create({
      configurations: [
        { id: 'primary', provider: 'codex' },
        { id: 'backup', provider: 'codex' },
      ],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('failed'));
    const task = manager.get(created.id)!;
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0].errorKind).toBe('crash');
    const codexCalls = spawnMock.mock.calls.filter(([command]) => command === 'codex');
    expect(codexCalls).toHaveLength(1);
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
      return fakeProcess();
    });

    const manager = createManager();
    const created = manager.create({
      configurations: [
        { id: 'primary', provider: 'codex' },
        { id: 'backup', provider: 'codex' },
      ],
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
    const codexCalls = spawnMock.mock.calls.filter(([command]) => command === 'codex');
    expect(codexCalls).toHaveLength(1);
    await manager.stop();
  });

  it('中文额度关键字应被识别为 rate_limit', async () => {
    let codexCalls = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'status') return fakeProcess(gitStatusOutput);
      if (command === 'git') return fakeProcess('');
      if (command === 'codex') {
        codexCalls += 1;
        return codexCalls === 1
          ? fakeProcess('', '余额不足,请充值\n', 1)
          : fakeProcess('{"type":"result","result":"done"}\n');
      }
      return fakeProcess();
    });

    const manager = createManager();
    const created = manager.create({
      configurations: [
        { id: 'primary', provider: 'codex' },
        { id: 'backup', provider: 'codex' },
      ],
      repository: 'acme/repo',
      prompt: '修复构建',
    });

    await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe('completed'));
    const task = manager.get(created.id)!;
    expect(task.attempts[0]).toMatchObject({
      provider: 'codex',
      errorKind: 'rate_limit',
    });
    expect(task.attempts[1]).toMatchObject({ provider: 'codex', status: 'success' });
    await manager.stop();
  });
});
