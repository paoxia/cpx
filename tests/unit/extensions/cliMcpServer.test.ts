import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliExtensionRegistry } from '../../../src/extensions/CliExtensionRegistry';
import { handleCliMcpRequest } from '../../../src/extensions/cliMcpServer';
import { configureCliExtensionTools } from '../../../src/extensions/agentTools';

describe('Agent CLI MCP', () => {
  let root: string;
  let registry: CliExtensionRegistry;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cpx-cli-mcp-'));
    registry = new CliExtensionRegistry(join(root, 'config', 'extensions'));
  });
  afterEach(() => {
    registry.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('MCP 可发现动态授权，执行失败应返回 isError', async () => {
    const call = (name: string, args: unknown = {}) =>
      handleCliMcpRequest(
        { id: 1, method: 'tools/call', params: { name, arguments: args } },
        registry,
      );
    expect(await call('cli_list')).toMatchObject({
      result: { content: [{ text: '[]' }], isError: false },
    });
    registry.add({
      name: 'echo',
      command: process.execPath,
      args: ['-e', 'console.log("ok")'],
      agentEnabled: true,
      allowedPrefixes: [['read']],
    });
    expect(JSON.stringify(await call('cli_list'))).toContain('echo');
    expect(await call('cli_run', { name: 'echo', args: ['read'] })).toMatchObject({
      result: { isError: false },
    });
    expect(await call('cli_run', { name: 'echo', args: ['delete'] })).toMatchObject({
      result: { isError: true },
    });
    expect(await call('cli_run', { name: 'echo', args: 'read' })).toMatchObject({
      result: { isError: true },
    });
    registry.add(
      {
        name: 'echo',
        command: process.execPath,
        args: ['-e', 'process.exit(9)'],
        agentEnabled: true,
        allowedPrefixes: [['read']],
      },
      true,
    );
    expect(await call('cli_run', { name: 'echo', args: ['read'] })).toMatchObject({
      result: { isError: true },
    });
    registry.setEnabled('echo', false);
    expect(await call('cli_list')).toMatchObject({ result: { content: [{ text: '[]' }] } });
  });

  it('只提供注册发现和受约束的运行工具，支持 MCP 握手和通知', async () => {
    expect(
      await handleCliMcpRequest(
        { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        registry,
      ),
    ).toMatchObject({ result: { protocolVersion: '2025-06-18', serverInfo: { name: 'cpx-cli' } } });
    const result = await handleCliMcpRequest({ id: 2, method: 'tools/list' }, registry);
    expect(result).toMatchObject({
      result: { tools: [{ name: 'cli_list' }, { name: 'cli_run' }] },
    });
    expect(
      await handleCliMcpRequest({ method: 'notifications/initialized' }, registry),
    ).toBeUndefined();
  });

  it('新任务与 resume 在 prompt 参数之前注入 MCP；注册路径只放环境变量', () => {
    for (const resume of [false, true]) {
      const args = resume ? ['exec', 'resume', '--json', 'session', '-'] : ['exec', '--json', '-'];
      const env: NodeJS.ProcessEnv = { CLI_CREDENTIAL: 'credential-value-hidden-from-args' };
      configureCliExtensionTools(args, env, registry.directory, resume);
      expect(env.CPX_CLI_EXTENSIONS_DIR).toBe(registry.directory);
      expect(args.join(' ')).toContain('mcp_servers.cpx_cli.command');
      expect(args.join(' ')).not.toContain(registry.directory);
      expect(args.join(' ')).toContain('CLI_CREDENTIAL');
      expect(args.join(' ')).not.toContain(env.CLI_CREDENTIAL);
      expect(args.slice(resume ? -2 : -1)).toEqual(resume ? ['session', '-'] : ['-']);
    }
  });
});
