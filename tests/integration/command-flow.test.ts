import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { AgentSystem } from '../../src/core/AgentSystem';
import type { AgentTask } from '../../src/agents/AgentTaskManager';

const TMP_DIR = join(process.cwd(), 'tmp-test-pipeline');
const MCP_TMP_DIR = join(process.cwd(), 'tmp-test-mcp-pipeline');
const MOCK_SERVER = join(process.cwd(), 'tests', 'fixtures', 'mcp', 'mock-server.js');

/** Windows 下 SQLite 文件可能短暂锁定，重试删除 */
function safeRm(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 等待 50ms 后重试
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  // 最后一次尝试，忽略错误
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略 - 测试仍可继续
  }
}

describe('命令管道集成测试', () => {
  let system: AgentSystem;

  beforeEach(() => {
    safeRm(TMP_DIR);
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(
      join(TMP_DIR, 'config.yaml'),
      'server:\n  port: 3999\nstorage:\n  path: ' +
        join(TMP_DIR, 'agent.db').replace(/\\/g, '/') +
        '\n',
    );
    system = new AgentSystem(TMP_DIR);
  });

  afterEach(async () => {
    await system.stop();
    vi.restoreAllMocks();
    safeRm(TMP_DIR);
  });

  it('version 命令应返回版本', async () => {
    const result = await system.processCommand('version', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('1.0.0');
  });

  it('help 命令应返回帮助文本', async () => {
    const result = await system.processCommand('help', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('可用命令');
  });

  it('中文 帮助 命令应被识别', async () => {
    const result = await system.processCommand('帮助', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('可用命令');
  });

  it('修改命令在未配置 GitHub 时返回错误', async () => {
    const result = await system.processCommand('修改 README.md 添加安装说明', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('GitHub 未配置');
  });

  it('@agent 前缀应被剥离', async () => {
    const result = await system.processCommand('@agent-bot version', {
      userId: 'u1',
      userName: 'Tester',
      source: 'dingtalk',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('1.0.0');
  });

  it('/agent 前缀应被剥离（飞书）', async () => {
    const result = await system.processCommand('/agent version', {
      userId: 'u1',
      userName: 'Tester',
      source: 'feishu',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('1.0.0');
  });

  it('执行未安装的 Skill 应返回错误', async () => {
    const result = await system.processCommand('执行 my-skill {"repo":"o/r"}', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Skill 未安装');
  });

  it('确认命令应对不存在的 ID 返回错误', async () => {
    const result = await system.processCommand('确认 cf_00000000', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('确认记录不存在');
  });

  it('未知命令应返回提示', async () => {
    const result = await system.processCommand('nonexistent_cmd', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('未知命令');
  });

  it('列出 skill 在无安装时返回提示', async () => {
    const result = await system.processCommand('列出 skill', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('尚未安装');
  });

  it('列出 mcp 在无连接时返回提示', async () => {
    const result = await system.processCommand('列出 mcp', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('尚未连接 MCP');
  });

  it('help 文本应包含 MCP 命令', async () => {
    const result = await system.processCommand('help', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.message).toContain('调用mcp');
    expect(result.message).toContain('连接mcp');
    expect(result.message).toContain('断开mcp');
  });

  it('help 文本应包含 GitHub 查询与 Coding Agent 开发命令', async () => {
    const result = await system.processCommand('help', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.message).toContain('查看GitHub');
    expect(result.message).toContain('查看分支');
    expect(result.message).toContain('开发 <owner/repo>');
    expect(result.message).toContain('最近任务');
  });

  it('未配置 GitHub Token 时查询仓库应返回明确错误', async () => {
    const result = await system.processCommand('查看GitHub', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('GitHub 查询失败');
    expect(result.message).toContain('GitHub Token');
  });

  it('飞书应能创建 Coding Agent 任务并接收完成通知', async () => {
    const webConsole = system.getWebConsole();
    const taskId = 'abcdef12-3456-7890-abcd-ef1234567890';
    const queuedTask = fakeAgentTask(taskId, 'queued');
    const completedTask = {
      ...fakeAgentTask(taskId, 'completed'),
      agentBranch: 'feature/fix-login',
      pullRequestUrl: 'https://github.com/paoxia/cpx/pull/99',
      completedAt: Date.now(),
    };
    vi.spyOn(webConsole, 'inspectGitHub').mockResolvedValue({
      user: {
        login: 'paoxia',
        name: 'Paoxia',
        avatarUrl: 'https://example.com/avatar.png',
        htmlUrl: 'https://github.com/paoxia',
      },
      repositories: [
        {
          id: 1,
          name: 'cpx',
          fullName: 'paoxia/cpx',
          owner: 'paoxia',
          private: false,
          htmlUrl: 'https://github.com/paoxia/cpx',
          description: null,
          fork: false,
          archived: false,
          language: 'TypeScript',
          stars: 0,
          updatedAt: new Date().toISOString(),
          defaultBranch: 'dev',
        },
      ],
    });
    vi.spyOn(webConsole, 'getGitHubBranches').mockResolvedValue([
      { name: 'dev', protected: false },
    ]);
    vi.spyOn(webConsole, 'createCodingTask').mockReturnValue(queuedTask);
    vi.spyOn(webConsole, 'waitForCodingTask').mockResolvedValue(completedTask);
    vi.spyOn(webConsole, 'getCodingTask').mockReturnValue(completedTask);

    const pushed: unknown[] = [];
    system.setResultPusher(async (_source, message) => {
      pushed.push(message);
    });

    const result = await system.processCommand(
      '/agent 开发 paoxia/cpx#dev -> feature/fix-login 修复登录页面',
      {
        userId: 'feishu-user-1',
        userName: 'Tester',
        source: 'feishu',
      },
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Coding Agent 任务已创建：abcdef12');
    expect(webConsole.createCodingTask).toHaveBeenCalledWith({
      repository: 'paoxia/cpx',
      baseBranch: 'dev',
      taskBranch: 'feature/fix-login',
      prompt: '修复登录页面',
      createPullRequest: true,
      useFallback: true,
    });
    await vi.waitFor(() => expect(pushed).toHaveLength(2));
    expect(JSON.stringify(pushed)).toContain('Coding Agent 开发完成');
    expect(JSON.stringify(pushed)).toContain('https://github.com/paoxia/cpx/pull/99');

    const status = await system.processCommand('/agent 任务 abcdef12', {
      userId: 'feishu-user-1',
      userName: 'Tester',
      source: 'feishu',
    });
    expect(status.success).toBe(true);
    expect(status.message).toContain('已完成');

    const otherUser = await system.processCommand('/agent 任务 abcdef12', {
      userId: 'feishu-user-2',
      userName: 'Other',
      source: 'feishu',
    });
    expect(otherUser.success).toBe(false);
    expect(otherUser.message).toContain('不是你在当前平台创建');
  });
});

describe('MCP 命令管道集成测试', () => {
  let system: AgentSystem;

  beforeEach(() => {
    safeRm(MCP_TMP_DIR);
    mkdirSync(MCP_TMP_DIR, { recursive: true });
    const cfg = [
      'server:',
      '  port: 3999',
      'storage:',
      '  path: ' + join(MCP_TMP_DIR, 'agent.db').replace(/\\/g, '/'),
      'mcp:',
      '  connections:',
      '    - name: mock',
      '      transport: stdio',
      `      command: "${process.execPath.replace(/\\/g, '\\\\')}"`,
      `      args: ["${MOCK_SERVER.replace(/\\/g, '\\\\')}"]`,
    ].join('\n');
    writeFileSync(join(MCP_TMP_DIR, 'config.yaml'), cfg);
    system = new AgentSystem(MCP_TMP_DIR);
  });

  afterEach(async () => {
    await system.stop();
    safeRm(MCP_TMP_DIR);
  });

  it('连接mcp 应成功连接配置中的 MCP', async () => {
    const result = await system.processCommand('连接mcp mock', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(true);
    expect(result.message).toContain('mock');
  });

  it('完整 MCP 调用流程：连接 -> 调用 -> 列出 -> 断开', async () => {
    const userInfo = { userId: 'u1', userName: 'Tester', source: 'cli' as const };

    // 连接
    const connectResult = await system.processCommand('连接mcp mock', userInfo);
    expect(connectResult.success).toBe(true);

    // 调用 echo
    const callResult = await system.processCommand('调用mcp mock echo {"message":"hi"}', userInfo);
    expect(callResult.success).toBe(true);
    expect(callResult.message).toContain('echo');

    // 列出
    const listResult = await system.processCommand('列出 mcp', userInfo);
    expect(listResult.success).toBe(true);
    expect(listResult.message).toContain('mock');

    // 断开
    const discResult = await system.processCommand('断开mcp mock', userInfo);
    expect(discResult.success).toBe(true);
    expect(discResult.message).toContain('mock');
  });

  it('调用mcp 对不存在的连接应返回错误', async () => {
    const result = await system.processCommand('调用mcp nonexistent echo', {
      userId: 'u1',
      userName: 'Tester',
      source: 'cli',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('连接不存在');
  });
});

function fakeAgentTask(id: string, status: AgentTask['status']): AgentTask {
  const now = Date.now();
  return {
    id,
    provider: 'codex',
    providers: ['codex', 'claude'],
    configurations: [
      { id: 'default-codex', provider: 'codex' },
      { id: 'default-claude', provider: 'claude' },
    ],
    repository: 'https://github.com/paoxia/cpx.git',
    baseBranch: 'dev',
    taskBranch: 'feature/fix-login',
    prompt: '修复登录页面',
    createPullRequest: true,
    status,
    createdAt: now,
    updatedAt: now,
    logs: [],
    attempts: [{ provider: 'codex', startedAt: now, status: 'success' }],
  };
}
