import { CliExtensionRegistry, cliExecutionFailed } from './CliExtensionRegistry';
import { CliRunInputSchema } from './schema';

export const CLI_EXTENSION_TOOLS = [
  {
    name: 'cli_list',
    description:
      '列出已启用且授权给 Agent 的外部 CLI，以及描述和 allowedPrefixes。每次读取最新配置。先发现能力，再按授权前缀查看 --help；不得猜测命令。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'cli_run',
    description:
      '运行已授权 CLI。args 必须为参数数组，不是 shell 文本；只能使用 cli_list 返回的 allowedPrefixes。命令可能产生外部副作用，必须符合用户要求；凭据和操作对象由 CLI 管理，不自动绑定原聊天会话。检查 exitCode、timedOut 和 outputLimitExceeded 判断成功。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
        args: { type: 'array', items: { type: 'string' }, maxItems: 256 },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
];

export async function executeCliTool(
  registry: CliExtensionRegistry,
  name: string,
  args: unknown,
): Promise<unknown> {
  if (name === 'cli_list') {
    return registry
      .list(true)
      .map(({ name: extensionName, description, allowedPrefixes, timeoutMs, maxOutputBytes }) => ({
        name: extensionName,
        description,
        allowedPrefixes,
        timeoutMs,
        maxOutputBytes,
      }));
  }
  if (name !== 'cli_run') throw new Error(`未知 CLI 工具: ${name}`);
  const input = CliRunInputSchema.parse(args);
  const result = await registry.run(input.name, input.args, true);
  // 返回进程结果以供 Agent 判断，不把 stderr 转为 API 异常或日志。
  return { ...result, success: !cliExecutionFailed(result) };
}
