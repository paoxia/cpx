import { createInterface } from 'readline';
import { CliExtensionRegistry } from './CliExtensionRegistry';
import { CLI_EXTENSION_TOOLS, executeCliTool } from './tools';

interface Request {
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: unknown };
}

export async function handleCliMcpRequest(
  request: Request,
  registry: CliExtensionRegistry,
): Promise<unknown> {
  if (request.id === undefined) return undefined;
  const reply = (result: unknown): unknown => ({ jsonrpc: '2.0', id: request.id, result });
  if (request.method === 'initialize')
    return reply({
      protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cpx-cli', version: '1.0.0' },
      instructions:
        'Use cli_list to discover registered CLIs and their allowed argument prefixes. Use cli_run only for user-authorized operations. CLI credentials belong to the service operator and are not scoped to a chat recipient. Check the returned success field.',
    });
  if (request.method === 'ping') return reply({});
  if (request.method === 'tools/list') return reply({ tools: CLI_EXTENSION_TOOLS });
  if (request.method !== 'tools/call')
    return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: '不支持的方法' } };
  try {
    const result = await executeCliTool(
      registry,
      request.params?.name ?? '',
      request.params?.arguments ?? {},
    );
    return reply({
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: Boolean(
        result && typeof result === 'object' && 'success' in result && !result.success,
      ),
    });
  } catch (error) {
    return reply({ content: [{ type: 'text', text: (error as Error).message }], isError: true });
  }
}

async function run(): Promise<void> {
  const directory = process.env.CPX_CLI_EXTENSIONS_DIR;
  if (!directory) throw new Error('缺少 CPX_CLI_EXTENSIONS_DIR');
  const registry = new CliExtensionRegistry(directory);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = (): void => {
    registry.stop();
    input.close();
    process.stdin.destroy();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  for await (const line of input) {
    if (!line.trim()) continue;
    let response: unknown;
    try {
      const request: unknown = JSON.parse(line);
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new Error('Invalid request');
      response = await handleCliMcpRequest(request as Request, registry);
    } catch {
      response = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: '无效 JSON-RPC 请求' },
      };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  registry.stop();
}

if (require.main === module) {
  void run().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
