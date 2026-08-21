interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

type FetchLike = typeof fetch;

const TOOLS = [
  {
    name: 'platform_get_context',
    description:
      '读取当前 cpx 协调会话或开发任务绑定的平台上下文，不提供切换目标会话的能力。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'platform_send_message',
    description:
      '向当前范围绑定的飞书或钉钉原会话发送一条阶段性文本消息。目标会话由 cpx 锁定，不能由参数指定。最终回复会由 cpx 自动回传，不要重复发送。',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 6000,
          description: '要发送到原会话的文本。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'github_list_repositories',
    description:
      '列出当前 cpx GitHub Token 可访问的仓库。用户没有明确仓库，或仓库名称可能有歧义时先调用此工具。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'github_list_branches',
    description: '列出指定 GitHub 仓库的分支，用于选择开发任务的基础分支。',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'owner/repository 格式的仓库全名。' },
      },
      required: ['repository'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'task_create',
    description:
      '为当前用户创建隔离 Coding Agent 开发任务。只有仓库已明确且用户确实要求修改、检查或开发代码时才调用。',
    inputSchema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'owner/repository 格式的仓库全名。' },
        prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
        baseBranch: { type: 'string', description: '可选基础分支；省略时使用默认分支。' },
        taskBranch: { type: 'string', description: '可选新分支；省略时由 cpx 自动生成。' },
        createPullRequest: {
          type: 'boolean',
          description: '完成后是否提交、推送并创建 Pull Request；默认 true。',
        },
      },
      required: ['repository', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'task_list',
    description: '列出当前用户通过当前消息平台创建的最近开发任务。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'task_status',
    description: '查询当前用户拥有的开发任务状态。任务 ID 可以使用唯一前缀。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'task_continue',
    description: '向当前用户拥有的已结束任务追加一轮自然语言要求，复用原工作区和 Codex 会话。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
      },
      required: ['taskId', 'prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'task_cancel',
    description: '停止当前用户拥有且正在执行的开发任务。',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

export async function handlePlatformMcpRequest(
  request: JsonRpcRequest,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<JsonRpcResponse | undefined> {
  const id = request.id ?? null;
  if (request.method === 'notifications/initialized' || request.id === undefined) {
    return undefined;
  }
  if (request.method === 'initialize') {
    const requestedVersion = (request.params as { protocolVersion?: unknown } | undefined)
      ?.protocolVersion;
    return success(id, {
      protocolVersion: typeof requestedVersion === 'string' ? requestedVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'cpx-platform', version: '1.0.0' },
      instructions:
        'These tools are scoped to one cpx platform conversation or coding task. Use GitHub and task tools instead of guessing platform state. Use platform_send_message only for useful progress updates. The final answer is delivered automatically. Never claim that you can change the target conversation or user.',
    });
  }
  if (request.method === 'ping') {
    return success(id, {});
  }
  if (request.method === 'tools/list') {
    return success(id, { tools: TOOLS });
  }
  if (request.method !== 'tools/call') {
    return failure(id, -32601, `不支持的方法：${request.method ?? 'unknown'}`);
  }

  const params = request.params as
    { name?: unknown; arguments?: Record<string, unknown> } | undefined;
  const name = typeof params?.name === 'string' ? params.name : '';
  if (!TOOLS.some((tool) => tool.name === name)) {
    return failure(id, -32602, `不支持的工具：${name || 'unknown'}`);
  }
  if (name === 'platform_send_message') {
    const text = params?.arguments?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) {
      return failure(id, -32602, 'text 必须是 1 到 6000 字符的非空字符串');
    }
  }
  if (name === 'github_list_branches' || name === 'task_create') {
    const repository = params?.arguments?.repository;
    if (typeof repository !== 'string' || !validRepository(repository)) {
      return failure(id, -32602, 'repository 必须使用 owner/repository 格式');
    }
  }
  if (name === 'task_create' || name === 'task_continue') {
    const prompt = params?.arguments?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) {
      return failure(id, -32602, 'prompt 必须是 1 到 20000 字符的非空字符串');
    }
  }
  if (name === 'task_status' || name === 'task_continue' || name === 'task_cancel') {
    const taskId = params?.arguments?.taskId;
    if (typeof taskId !== 'string' || !/^[a-f0-9-]{6,36}$/i.test(taskId)) {
      return failure(id, -32602, 'taskId 格式无效');
    }
  }
  if (name === 'task_list' && params?.arguments?.limit !== undefined) {
    const limit = params.arguments.limit;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 10) {
      return failure(id, -32602, 'limit 必须是 1 到 10 的整数');
    }
  }

  const endpoint = env.CPX_PLATFORM_TOOL_URL?.trim();
  const token = env.CPX_PLATFORM_TOOL_TOKEN?.trim();
  const taskId = env.CPX_PLATFORM_TOOL_TASK_ID?.trim();
  if (!endpoint || !token || !taskId) {
    return toolResult(id, '平台工具未绑定到 cpx 会话或任务。', true);
  }

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ taskId, tool: name, args: params?.arguments ?? {} }),
    });
    const payload = (await response.json()) as { result?: unknown; error?: unknown };
    if (!response.ok) {
      return toolResult(id, String(payload.error ?? `平台接口返回 ${response.status}`), true);
    }
    return toolResult(
      id,
      typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result ?? {}),
      false,
    );
  } catch (error) {
    return toolResult(id, `平台工具调用失败：${errorMessage(error)}`, true);
  }
}

function validRepository(value: string): boolean {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(normalized)) return false;
  const [owner, repository] = normalized.split('/');
  return /[a-zA-Z0-9]/.test(owner) && /[a-zA-Z0-9]/.test(repository);
}

function success(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(id: string | number | null, text: string, isError: boolean): JsonRpcResponse {
  return success(id, { content: [{ type: 'text', text }], isError });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(): Promise<void> {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  let queue = Promise.resolve();
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      queue = queue.then(async () => {
        let request: JsonRpcRequest;
        try {
          request = JSON.parse(line) as JsonRpcRequest;
        } catch {
          process.stdout.write(
            `${JSON.stringify(failure(null, -32700, '无效的 JSON-RPC 请求'))}\n`,
          );
          return;
        }
        const response = await handlePlatformMcpRequest(request);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}

if (require.main === module) {
  void run();
}
