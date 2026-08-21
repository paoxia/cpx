import { describe, expect, it, vi } from 'vitest';
import { handlePlatformMcpRequest } from '../../../src/agents/platformMcpServer';

const ENV = {
  CPX_PLATFORM_TOOL_URL: 'http://127.0.0.1:3000/api/internal/agent-platform-tool',
  CPX_PLATFORM_TOOL_TOKEN: 'task-scoped-token',
  CPX_PLATFORM_TOOL_TASK_ID: 'task-123',
  CPX_PLATFORM_NAME: 'feishu',
};

describe('cpx platform MCP server', () => {
  it('应公布平台、GitHub 与任务协调工具', async () => {
    const initialized = await handlePlatformMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(initialized).toMatchObject({
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
      },
    });

    const listed = await handlePlatformMcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const names = (listed?.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'platform_get_context',
        'platform_send_message',
        'github_list_repositories',
        'github_list_branches',
        'task_create',
        'task_list',
        'task_status',
        'task_continue',
        'task_cancel',
      ]),
    );
  });

  it('应使用任务 Token 调用 cpx 内部端点', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: '消息已发送' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const response = await handlePlatformMcpRequest(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'platform_send_message', arguments: { text: '正在运行测试' } },
      },
      ENV,
      fetchMock,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      ENV.CPX_PLATFORM_TOOL_URL,
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ENV.CPX_PLATFORM_TOOL_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taskId: ENV.CPX_PLATFORM_TOOL_TASK_ID,
          tool: 'platform_send_message',
          args: { text: '正在运行测试' },
        }),
      }),
    );
    expect(response?.result).toMatchObject({
      content: [{ type: 'text', text: '消息已发送' }],
      isError: false,
    });
  });

  it('应拒绝无效文本，且未绑定任务时不调用网络', async () => {
    const fetchMock = vi.fn();
    const invalid = await handlePlatformMcpRequest(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'platform_send_message', arguments: { text: '   ' } },
      },
      ENV,
      fetchMock,
    );
    expect(invalid?.error?.code).toBe(-32602);

    const unbound = await handlePlatformMcpRequest(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'platform_get_context', arguments: {} },
      },
      {},
      fetchMock,
    );
    expect(unbound?.result).toMatchObject({ isError: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('应校验 Codex 提交的仓库和任务参数', async () => {
    const fetchMock = vi.fn();
    const invalidRepository = await handlePlatformMcpRequest(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'task_create',
          arguments: { repository: '../secret', prompt: '修复问题' },
        },
      },
      ENV,
      fetchMock,
    );
    expect(invalidRepository?.error?.code).toBe(-32602);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
