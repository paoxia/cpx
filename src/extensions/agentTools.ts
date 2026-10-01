import { existsSync } from 'fs';
import { join } from 'path';

/** 与现有平台 MCP 相同的 Codex 参数注入方式；不修改用户全局配置。 */
export function configureCliExtensionTools(
  args: string[],
  env: NodeJS.ProcessEnv,
  directory: string,
  resume: boolean,
): void {
  const compiled = join(__dirname, 'cliMcpServer.js');
  const serverArgs = existsSync(compiled)
    ? [compiled]
    : [require.resolve('tsx/cli'), join(__dirname, 'cliMcpServer.ts')];
  env.CPX_CLI_EXTENSIONS_DIR = directory;
  const config = [
    `mcp_servers.cpx_cli.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.cpx_cli.args=${JSON.stringify(serverArgs)}`,
    // MCP 子进程也需要服务环境：新 manifest 的环境变量引用无需等待下一轮重建。
    // 只在参数中传变量名，凭据值仍由环境传递。
    `mcp_servers.cpx_cli.env_vars=${JSON.stringify(Object.keys(env))}`,
    'mcp_servers.cpx_cli.default_tools_approval_mode="approve"',
    'mcp_servers.cpx_cli.required=true',
  ];
  const insertionIndex = resume ? Math.max(3, args.length - 2) : Math.max(2, args.length - 1);
  args.splice(insertionIndex, 0, ...config.flatMap((value) => ['--config', value]));
}
