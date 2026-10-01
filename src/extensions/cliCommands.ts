import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Command } from 'commander';
import * as yaml from 'js-yaml';
import { cpxRuntimePaths } from '../cliSupport';
import { CliExtensionRegistry, cliExecutionFailed } from './CliExtensionRegistry';
import { CLI_PRESETS } from './presets';
import { CliArgumentsSchema } from './schema';

function registry(command: Command): CliExtensionRegistry {
  const options = command.optsWithGlobals() as { home?: string; dir?: string };
  return new CliExtensionRegistry(
    join(
      options.dir ? resolve(options.dir) : cpxRuntimePaths(options.home).configDir,
      'extensions',
    ),
  );
}

interface AddOptions {
  file?: string;
  preset?: string;
  command?: string;
  args?: string;
  description?: string;
  allow: string[];
  agent?: boolean;
  force?: boolean;
}

export function registerCliExtensionCommands(program: Command): void {
  const cli = program
    .command('cli')
    .description('动态注册、管理和执行外部 CLI')
    .option('-d, --dir <dir>', '配置目录（与 start --dir 一致）')
    .enablePositionalOptions();
  cli
    .command('presets')
    .description('显示钉钉、飞书的内置注册模板')
    .action(() => console.log(yaml.dump(CLI_PRESETS, { noRefs: true })));
  cli
    .command('add <name>')
    .description('注册 CLI；支持内置模板或 YAML manifest')
    .option('--file <path>', '导入 YAML manifest')
    .option('--preset <name>', '使用内置模板 dingtalk / feishu')
    .option('--command <executable>', '可执行文件名或路径')
    .option('--args <json>', '固定前置参数，JSON 字符串数组')
    .option('--description <text>', '用途与操作提示')
    .option(
      '--allow <json>',
      '授权命令前缀，JSON 字符串数组；可重复',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--agent', '允许 Agent 使用（必须配置授权前缀）')
    .option('--force', '替换已有注册')
    .action((name: string, options: AddOptions, command: Command) => {
      if (options.file && options.preset) throw new Error('--file 和 --preset 不能同时使用');
      let input: Record<string, unknown> = {};
      if (options.file) {
        const parsed: unknown = yaml.load(readFileSync(resolve(options.file), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('manifest 必须是对象');
        input = parsed as Record<string, unknown>;
        if (input.name !== name) throw new Error('manifest 名称必须与 add 的名称一致');
      } else {
        const preset = options.preset ?? (!options.command && CLI_PRESETS[name] ? name : undefined);
        if (preset) {
          if (!Object.prototype.hasOwnProperty.call(CLI_PRESETS, preset))
            throw new Error(`未知 CLI 模板: ${preset}`);
          input = { ...CLI_PRESETS[preset] };
        }
      }
      input = { ...input, name };
      if (options.command !== undefined) input.command = options.command;
      if (options.args !== undefined)
        input.args = CliArgumentsSchema.parse(JSON.parse(options.args));
      if (options.description !== undefined) input.description = options.description;
      if (options.allow.length)
        input.allowedPrefixes = options.allow.map((value) =>
          CliArgumentsSchema.parse(JSON.parse(value)),
        );
      if (options.agent) input.agentEnabled = true;
      const extension = registry(command).add(input, options.force);
      console.log(
        `已注册 CLI: ${extension.name} → ${extension.command}（Agent ${extension.agentEnabled ? '已授权' : '未授权'}）`,
      );
    });
  cli
    .command('list')
    .description('列出已注册 CLI')
    .option('--json', '输出 JSON')
    .action((options: { json?: boolean }, command: Command) => {
      const extensions = registry(command).list();
      if (options.json) console.log(JSON.stringify(extensions, null, 2));
      else if (!extensions.length)
        console.log('尚未注册 CLI；使用 cpx cli add dingtalk 或 cpx cli add feishu');
      else
        for (const item of extensions)
          console.log(
            `${item.name}\t${item.enabled ? '启用' : '禁用'}\tAgent ${item.agentEnabled ? '已授权' : '未授权'}\t${item.command}\t${item.description}`,
          );
    });
  cli
    .command('info <name>')
    .description('显示 CLI 配置与授权前缀')
    .action((name: string, _options: unknown, command: Command) =>
      console.log(yaml.dump(registry(command).get(name), { noRefs: true })),
    );
  for (const enabled of [true, false]) {
    cli
      .command(`${enabled ? 'enable' : 'disable'} <name>`)
      .description(`${enabled ? '启用' : '禁用'} CLI（立即生效）`)
      .action((name: string, _options: unknown, command: Command) => {
        registry(command).setEnabled(name, enabled);
        console.log(`CLI ${name} 已${enabled ? '启用' : '禁用'}`);
      });
  }
  cli
    .command('remove <name>')
    .description('移除注册；外部可执行文件与凭据由原 CLI 管理')
    .action((name: string, _options: unknown, command: Command) => {
      registry(command).remove(name);
      console.log(`已移除 CLI 注册: ${name}`);
    });
  cli
    .command('run <name> [args...]')
    .description('执行 CLI；在 -- 后传入原始 CLI 参数')
    .allowUnknownOption()
    .passThroughOptions()
    .action(async (name: string, args: string[], _options: unknown, command: Command) => {
      const extensions = registry(command);
      const cancel = (): void => extensions.stop();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        // Commander passThroughOptions 保留分隔符；它属于 CPX，不能传给外部 CLI。
        const forwarded = args[0] === '--' ? args.slice(1) : args;
        const result = await extensions.run(name, forwarded);
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        if (result.timedOut) console.error(`CLI ${name} 执行超时`);
        if (result.outputLimitExceeded) console.error(`CLI ${name} 输出超过限制`);
        process.exitCode = result.timedOut
          ? 124
          : result.outputLimitExceeded
            ? 125
            : (result.exitCode ?? 1);
      } finally {
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
      }
    });
  cli
    .command('doctor [name]')
    .description('使用 versionArgs 检查 CLI 是否可执行（不验证登录）')
    .action(async (name: string | undefined, _options: unknown, command: Command) => {
      const extensions = registry(command);
      const items = name ? [extensions.get(name)] : extensions.list();
      if (!items.length) console.log('尚未注册 CLI');
      for (const item of items) {
        try {
          const result = await extensions.run(item.name, item.versionArgs);
          if (cliExecutionFailed(result)) throw new Error('版本检查失败、超时或输出超过限制');
          console.log(`✓ ${item.name}: ${result.stdout.trim() || result.stderr.trim()}`);
        } catch (error) {
          console.error(`✗ ${item.name}: ${(error as Error).message}`);
          process.exitCode = 1;
        }
      }
    });
}
