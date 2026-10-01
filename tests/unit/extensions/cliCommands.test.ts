import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../src/cli';
import { CliExtensionRegistry } from '../../../src/extensions/CliExtensionRegistry';

describe('cpx cli 扩展命令', () => {
  let root: string;
  let registry: CliExtensionRegistry;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cpx-cli-command-'));
    registry = new CliExtensionRegistry(join(root, 'config', 'extensions'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    registry.stop();
    rmSync(root, { recursive: true, force: true });
    process.exitCode = 0;
    vi.restoreAllMocks();
  });
  const run = async (root: string, args: string[]): Promise<void> => {
    await createProgram()
      .exitOverride()
      .parseAsync(['node', 'cpx', '--home', root, 'cli', ...args]);
  };

  it('不依赖 config init 即可注册钉钉、飞书与自定义 CLI', async () => {
    await run(root, ['add', 'dingtalk']);
    await run(root, ['add', 'feishu']);
    await run(root, ['add', 'custom', '--command', process.execPath]);
    expect(registry.list().map((item) => item.command)).toEqual(
      ['node', 'dws', 'lark-cli'].map((command) =>
        command === 'node' ? process.execPath : command,
      ),
    );
    expect(registry.list(true)).toEqual([]);
    await run(root, ['disable', 'dingtalk']);
    expect(registry.get('dingtalk').enabled).toBe(false);
    await run(root, ['enable', 'dingtalk']);
    await run(root, ['remove', 'custom']);
    expect(registry.list()).toHaveLength(2);
  });

  it('必须为 Agent 明确授权，可重复指定 JSON 前缀', async () => {
    await expect(run(root, ['add', 'dingtalk', '--agent'])).rejects.toThrow('授权');
    await run(root, [
      'add',
      'dingtalk',
      '--agent',
      '--allow',
      '["--help"]',
      '--allow',
      '["calendar","list"]',
    ]);
    expect(registry.get('dingtalk').allowedPrefixes).toEqual([['--help'], ['calendar', 'list']]);
    await expect(run(root, ['add', 'x', '--preset', 'unknown'])).rejects.toThrow('未知');
  });

  it('run 的 -- 后参数与子命令选项保持原样，保留退出码', async () => {
    const code = 'console.log(JSON.stringify(process.argv.slice(1))); process.exit(6)';
    await run(root, [
      'add',
      'echo',
      '--command',
      process.execPath,
      '--args',
      JSON.stringify(['-e', code, '--']),
    ]);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await run(root, [
      'run',
      'echo',
      '--',
      '--help',
      '--home',
      '/not-cpx-home',
      '空 格',
      '$(whoami)',
    ]);
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toEqual([
      '--help',
      '--home',
      '/not-cpx-home',
      '空 格',
      '$(whoami)',
    ]);
    expect(process.exitCode).toBe(6);
  });

  it('显式配置目录与服务 start --dir 使用相同注册位置', async () => {
    await run(root, ['--dir', join(root, 'custom-config'), 'add', 'feishu']);
    expect(
      new CliExtensionRegistry(join(root, 'custom-config', 'extensions')).get('feishu').command,
    ).toBe('lark-cli');
    expect(registry.list()).toEqual([]);
  });
});
