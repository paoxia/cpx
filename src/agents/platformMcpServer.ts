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
      '读取当前 cpx 任务绑定的消息平台上下文。只返回当前平台和任务范围，不提供切换目标会话的能力。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'platform_send_message',
    description:
      '向创建当前任务的飞书或钉钉原会话发送一条阶段性文本消息。目标会话由 cpx 锁定，不能由参数指定。最终回复会由 cpx 自动回传，不要重复发送。',
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
        'These tools are scoped to the platform conversation that created the current cpx task. Use platform_send_message only for useful progress updates. The final answer is delivered automatically. Never claim that you can change the target conversation or user.',
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

  const endpoint = env.CPX_PLATFORM_TOOL_URL?.trim();
  const token = env.CPX_PLATFORM_TOOL_TOKEN?.trim();
  const taskId = env.CPX_PLATFORM_TOOL_TASK_ID?.trim();
  if (!endpoint || !token || !taskId) {
    return toolResult(id, '平台工具未绑定到 cpx 任务。', true);
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
