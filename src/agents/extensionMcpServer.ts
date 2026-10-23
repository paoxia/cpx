import { createInterface } from 'readline';

/** Minimal, task-scoped bridge; the controller rechecks permissions on every call. */
const tools = [
  {
    name: 'extension_call',
    description:
      '调用当前项目显式授权的 Skill 或 MCP。扩展名使用 skill:名称 或 mcp:名称；只读任务不允许外部写操作。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        method: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request: {
      id?: string | number;
      method?: string;
      params?: { name?: string; arguments?: unknown };
    };
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.id === undefined) continue;
    let result: unknown;
    if (request.method === 'initialize')
      result = {
        protocolVersion:
          (request.params as { protocolVersion?: string })?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'cpx-project-extensions', version: '1' },
      };
    else if (request.method === 'tools/list') result = { tools };
    else if (request.method === 'ping') result = {};
    else if (request.method === 'tools/call' && request.params?.name === 'extension_call') {
      try {
        const response = await fetch(process.env.CPX_EXTENSION_URL!, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.CPX_EXTENSION_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            taskId: process.env.CPX_EXTENSION_TASK,
            ...(request.params.arguments as Record<string, unknown>),
          }),
          signal: AbortSignal.timeout(120000),
        });
        const value = await response.json();
        result = {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          isError: !response.ok,
        };
      } catch {
        result = { content: [{ type: 'text', text: '扩展调用失败' }], isError: true };
      }
    } else result = { content: [{ type: 'text', text: '不支持的工具' }], isError: true };
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }
}
if (require.main === module) void main();
