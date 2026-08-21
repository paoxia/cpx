import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { MessagingCoordinator } from '../../../src/agents/MessagingCoordinator';
import { Logger } from '../../../src/utils/Logger';

function fakeProcess(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [new PassThrough(), new PassThrough(), new PassThrough()],
    killed: false,
    connected: false,
    exitCode: null,
    signalCode: null,
    pid: 123,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

describe('MessagingCoordinator', () => {
  it('应在只读非 Git 会话中向 Codex 注入受限平台 MCP', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const coordinator = new MessagingCoordinator(process.cwd(), new Logger('error'), spawnMock);

    const resultPromise = coordinator.run({
      scopeId: 'scope-1',
      prompt: '帮我在 cpx 修复登录问题',
      configurations: [{ id: 'default', provider: 'codex', model: 'gpt-test' }],
      platformTools: {
        endpoint: 'http://127.0.0.1:3000/internal',
        token: 'scope-token',
        taskId: 'scope-1',
        platform: 'feishu',
      },
    });
    child.stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n');
    child.stdout.write(
      '{"type":"item.completed","item":{"type":"agent_message","text":"任务已经创建。"}}\n',
    );
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({
      response: '任务已经创建。',
      threadId: 'thread-1',
    });
    const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--model',
        'gpt-test',
      ]),
    );
    expect(args.join(' ')).toContain('mcp_servers.cpx_platform.command');
    const stdin = child.stdin.read()?.toString() ?? '';
    expect(stdin).toContain('协调 Agent');
    expect(stdin).not.toContain('scope-token');
  });

  it('应使用 thread id 恢复同一个协调会话', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const coordinator = new MessagingCoordinator(process.cwd(), new Logger('error'), spawnMock);

    const resultPromise = coordinator.run({
      scopeId: 'scope-2',
      prompt: '就用第一个仓库',
      threadId: 'thread-existing',
      configurations: [{ id: 'default', provider: 'codex' }],
      platformTools: {
        endpoint: 'http://127.0.0.1:3000/internal',
        token: 'scope-token',
        taskId: 'scope-2',
        platform: 'dingtalk',
      },
    });
    child.stdout.write('{"type":"result","result":"好的。"}\n');
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({
      response: '好的。',
      threadId: 'thread-existing',
    });
    const args = (spawnMock as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
    expect(args.slice(0, 5)).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      'resume',
      '--skip-git-repo-check',
    ]);
    expect(args.indexOf('--sandbox')).toBeLessThan(args.indexOf('resume'));
    expect(args).toContain('thread-existing');
    expect(child.stdin.read()?.toString()).toBe('就用第一个仓库');
  });

  it('应向用户保留 Codex CLI 的真实错误而不是末尾帮助提示', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const coordinator = new MessagingCoordinator(process.cwd(), new Logger('error'), spawnMock);

    const resultPromise = coordinator.run({
      scopeId: 'scope-error',
      prompt: '继续',
      threadId: 'thread-existing',
      configurations: [{ id: 'default', provider: 'codex' }],
      platformTools: {
        endpoint: 'http://127.0.0.1:3000/internal',
        token: 'scope-token',
        taskId: 'scope-error',
        platform: 'feishu',
      },
    });
    child.stderr.write(
      "error: unexpected argument '--sandbox' found\n\nUsage: codex exec resume\n\nFor more information, try '--help'.\n",
    );
    child.emit('close', 2);

    await expect(resultPromise).rejects.toThrow("unexpected argument '--sandbox'");
  });
});
