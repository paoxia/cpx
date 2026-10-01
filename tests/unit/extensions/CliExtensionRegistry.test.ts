import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CliExtensionRegistry,
  cliExecutionFailed,
} from '../../../src/extensions/CliExtensionRegistry';
import { CliExtensionSchema } from '../../../src/extensions/schema';

const registries: CliExtensionRegistry[] = [];
const roots: string[] = [];
function setup(): CliExtensionRegistry {
  const root = mkdtempSync(join(tmpdir(), 'cpx-extensions-'));
  roots.push(root);
  const registry = new CliExtensionRegistry(join(root, 'config', 'extensions'));
  registries.push(registry);
  return registry;
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.CPX_TEST_CLI_CREDENTIAL;
});

describe('CLI 扩展注册与执行', () => {
  it('跨实例动态发现注册、更新、禁用和删除，不需重启', () => {
    const registry = setup();
    const other = new CliExtensionRegistry(registry.directory);
    expect(other.list()).toEqual([]);
    registry.add({ name: 'sample', command: process.execPath });
    expect(other.get('sample').enabled).toBe(true);
    expect(() => registry.add({ name: 'sample', command: process.execPath })).toThrow('已存在');
    registry.add(
      {
        name: 'sample',
        command: process.execPath,
        agentEnabled: true,
        allowedPrefixes: [['--version']],
      },
      true,
    );
    expect(other.list(true)).toHaveLength(1);
    registry.setEnabled('sample', false);
    expect(other.list(true)).toEqual([]);
    registry.remove('sample');
    expect(other.list()).toEqual([]);
  });

  it('校验名称、路径遍历、未知字段、NUL 和 Agent 空授权', () => {
    const registry = setup();
    for (const name of ['../escape', '/tmp/file', 'Upper', 'a.b']) {
      expect(() => registry.add({ name, command: 'node' })).toThrow();
      expect(() => registry.get(name)).toThrow();
    }
    expect(() => registry.add({ name: 'x', command: 'node', shell: true })).toThrow();
    expect(() => registry.add({ name: 'x', command: 'node', agentEnabled: true })).toThrow('授权');
    expect(() => registry.add({ name: 'x', command: 'node', allowedPrefixes: [[]] })).toThrow();
    expect(CliExtensionSchema.safeParse({ name: 'x', command: 'node\0' }).success).toBe(false);
  });

  it('损坏 manifest 不得静默忽略，文件名与名称必须一致', () => {
    const registry = setup();
    registry.add({ name: 'sample', command: 'node' });
    writeFileSync(join(registry.directory, 'sample.yaml'), 'name: different\ncommand: node\n');
    expect(() => registry.list()).toThrow('不一致');
    writeFileSync(join(registry.directory, 'sample.yaml'), 'name: [broken');
    expect(() => registry.get('sample')).toThrow();
  });

  it('原样传递数组参数，shell 元字符和 Unicode 不产生额外命令', async () => {
    const registry = setup();
    registry.add({
      name: 'echo',
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'],
    });
    const args = [
      'hello world',
      '钉钉',
      '$(touch /tmp/cpx-injection)',
      '; exit 9',
      '--format=json',
    ];
    const result = await registry.run('echo', args);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    const audit = readFileSync(join(registry.directory, '.audit.jsonl'), 'utf8');
    expect(audit).toContain('"event":"finish"');
    expect(audit).not.toContain('cpx-injection');
  });

  it('Agent 只可发现显式授权的启用扩展，并校验完整参数前缀', async () => {
    const registry = setup();
    registry.add({ name: 'private', command: process.execPath });
    registry.add({
      name: 'public',
      command: process.execPath,
      args: ['-e', 'console.log("ok")'],
      agentEnabled: true,
      allowedPrefixes: [['calendar', 'list']],
    });
    expect(registry.list(true).map((item) => item.name)).toEqual(['public']);
    await expect(registry.run('private', ['--version'], true)).rejects.toThrow('未授权');
    await expect(registry.run('public', ['calendar', 'delete'], true)).rejects.toThrow('授权前缀');
    await expect(registry.run('public', ['calendar-list'], true)).rejects.toThrow('授权前缀');
    await expect(
      registry.run('public', ['--profile', 'admin', 'calendar', 'list'], true),
    ).rejects.toThrow('授权前缀');
    await expect(
      registry.run('public', ['calendar', 'list', 'today'], true),
    ).resolves.toMatchObject({ exitCode: 0 });
    registry.setEnabled('public', false);
    await expect(registry.run('public', ['calendar', 'list'], true)).rejects.toThrow('禁用');
  });

  it('空前缀只允许本地使用；非零退出保留 stderr 并标识失败', async () => {
    const registry = setup();
    registry.add({
      name: 'failure',
      command: process.execPath,
      args: ['-e', 'console.error("failed"); process.exit(7)'],
    });
    const result = await registry.run('failure');
    expect(result).toMatchObject({ exitCode: 7, stderr: 'failed\n' });
    expect(cliExecutionFailed(result)).toBe(true);
  });

  it('凭据通过环境变量引用传入、输出脱敏、审计不含凭据', async () => {
    const registry = setup();
    process.env.CPX_TEST_CLI_CREDENTIAL = 'credential-value-for-cli-test';
    registry.add({
      name: 'secret',
      command: process.execPath,
      args: ['-e', 'console.log(process.env.CLI_TOKEN); console.error(process.env.CLI_TOKEN)'],
      env: { CLI_TOKEN: 'CPX_TEST_CLI_CREDENTIAL' },
    });
    const result = await registry.run('secret');
    expect(result.stdout).toBe('***\n');
    expect(result.stderr).toBe('***\n');
    expect(readFileSync(join(registry.directory, 'secret.yaml'), 'utf8')).not.toContain(
      'credential-value',
    );
    expect(readFileSync(join(registry.directory, '.audit.jsonl'), 'utf8')).not.toContain(
      'credential-value',
    );
    delete process.env.CPX_TEST_CLI_CREDENTIAL;
    await expect(registry.run('secret')).rejects.toThrow('缺少环境变量');
  });

  it('未安装的二进制有明确错误，使用稳定工作目录并关闭 stdin', async () => {
    const registry = setup();
    registry.add({ name: 'missing', command: 'cpx-not-installed-012345' });
    await expect(registry.run('missing')).rejects.toThrow('无法启动');
    registry.add({
      name: 'cwd',
      command: process.execPath,
      args: [
        '-e',
        'process.stdin.resume(); process.stdin.on("end", () => console.log(process.cwd()))',
      ],
    });
    const result = await registry.run('cwd');
    expect(result.stdout.trim()).toBe(roots[roots.length - 1]);
  });

  it('强制终止超时进程，即使进程忽略 SIGTERM', async () => {
    const registry = setup();
    registry.add({
      name: 'hang',
      command: process.execPath,
      timeoutMs: 200,
      args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    });
    const result = await registry.run('hang');
    expect(result.timedOut).toBe(true);
    expect(cliExecutionFailed(result)).toBe(true);
  });

  it('限制 stdout 和 stderr 的总字节数，并终止输出洪泛进程', async () => {
    const registry = setup();
    registry.add({
      name: 'flood',
      command: process.execPath,
      maxOutputBytes: 256,
      args: ['-e', 'console.log("x".repeat(1024)); console.error("y".repeat(1024))'],
    });
    const result = await registry.run('flood');
    expect(result.outputLimitExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      256,
    );
    expect(cliExecutionFailed(result)).toBe(true);
  });

  it('停止执行器会取消活动进程并拒绝后续执行', async () => {
    const registry = setup();
    registry.add({
      name: 'wait',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    const pending = registry.run('wait');
    registry.stop();
    expect(cliExecutionFailed(await pending)).toBe(true);
    await expect(registry.run('wait')).rejects.toThrow('停止');
  });
});
