#!/usr/bin/env node
import { spawn, spawnSync } from 'child_process';
import { closeSync, existsSync, openSync } from 'fs';
import { get } from 'http';
import { join, resolve } from 'path';
import { stdin as input, stdout as output } from 'process';
import { createInterface } from 'readline/promises';
import { Command } from 'commander';
import * as yaml from 'js-yaml';
import packageMetadata from '../package.json';
import {
  CpxRuntimePaths,
  cpxRuntimePaths,
  ensureRuntimeDirectories,
  getConfigValue,
  initializeConfiguration,
  isProcessRunning,
  isSecretConfigPath,
  parseConfigValue,
  readPidRecord,
  readYamlObject,
  redactConfig,
  removePidRecord,
  setConfigValue,
  writePidRecord,
  writeYamlObject,
} from './cliSupport';
import { ConfigManager } from './config/ConfigManager';
import { AgentSystem } from './core/AgentSystem';

const PACKAGE_ROOT = resolve(__dirname, '..');
const PACKAGE_NAME = packageMetadata.name;

interface GlobalOptions {
  home?: string;
}

function runtimePaths(command: Command): CpxRuntimePaths {
  return cpxRuntimePaths((command.optsWithGlobals() as GlobalOptions).home);
}

function configDirectory(paths: CpxRuntimePaths, explicit?: string): string {
  return explicit ? resolve(explicit) : paths.configDir;
}

function pathsWithConfigDir(paths: CpxRuntimePaths, explicit?: string): CpxRuntimePaths {
  return { ...paths, configDir: configDirectory(paths, explicit) };
}

function printInitialization(result: { created: string[]; skipped: string[] }): void {
  for (const path of result.created) console.log(`已创建: ${path}`);
  for (const path of result.skipped) console.log(`已存在，跳过: ${path}`);
}

function requireConfiguration(configDir: string): void {
  const configPath = join(configDir, 'config.yaml');
  if (!existsSync(configPath)) {
    throw new Error(`配置不存在: ${configPath}\n请先运行 cpx config init`);
  }
}

function writeValidatedConfiguration(
  configPath: string,
  configDir: string,
  next: Record<string, unknown>,
  previous: Record<string, unknown>,
): void {
  writeYamlObject(configPath, next);
  try {
    new ConfigManager(configDir).load();
  } catch (error) {
    writeYamlObject(configPath, previous);
    throw error;
  }
}

async function readStdin(): Promise<string> {
  let value = '';
  input.setEncoding('utf8');
  for await (const chunk of input) value += chunk;
  return value.replace(/[\r\n]+$/, '');
}

async function runConfigWizard(paths: CpxRuntimePaths): Promise<void> {
  printInitialization(initializeConfiguration(paths, PACKAGE_ROOT));
  const configPath = join(paths.configDir, 'config.yaml');
  const config = readYamlObject(configPath);
  const previous = structuredClone(config);
  const current = new ConfigManager(paths.configDir).load();
  const prompt = createInterface({ input, output });
  const ask = async (label: string, fallback: string): Promise<string> => {
    const answer = (await prompt.question(`${label} [${fallback}]: `)).trim();
    return answer || fallback;
  };

  try {
    const port = Number.parseInt(await ask('Web 服务端口', String(current.server.port)), 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535');
    const host = await ask('监听地址', current.server.host);
    const repo = await ask('默认 GitHub 仓库（可留空）', current.github.defaultRepo ?? '-');
    const branch = await ask('默认分支', current.github.defaultBranch);
    setConfigValue(config, 'server.port', port);
    setConfigValue(config, 'server.host', host);
    setConfigValue(config, 'github.defaultRepo', repo === '-' ? undefined : repo);
    setConfigValue(config, 'github.defaultBranch', branch);
    writeValidatedConfiguration(configPath, paths.configDir, config, previous);
  } finally {
    prompt.close();
  }

  console.log(`\n配置已保存并通过校验: ${configPath}`);
  console.log('敏感值请通过标准输入写入，例如:');
  console.log("  printf '%s' \"$GITHUB_TOKEN\" | cpx config set github.token --stdin");
  console.log('飞书和钉钉可在 cpx 启动后的 Web 设置页继续配置。');
}

async function healthCheck(port: number): Promise<boolean> {
  return new Promise((done) => {
    const request = get(
      { hostname: '127.0.0.1', port, path: '/health', timeout: 1500 },
      (response) => {
        response.resume();
        done(Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400));
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => done(false));
  });
}

async function startForeground(paths: CpxRuntimePaths, configDir: string): Promise<void> {
  ensureRuntimeDirectories(paths);
  requireConfiguration(configDir);
  const existing = readPidRecord(paths.pidFile);
  if (existing && isProcessRunning(existing.pid)) {
    throw new Error(`CPX 已在运行（PID ${existing.pid}）`);
  }
  if (existing || existsSync(paths.pidFile)) removePidRecord(paths.pidFile);

  const config = new ConfigManager(configDir).load();
  const system = new AgentSystem(configDir);
  writePidRecord(paths.pidFile, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    configDir,
    port: config.server.port,
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在停止 CPX...`);
    try {
      await system.stop();
      removePidRecord(paths.pidFile);
      process.exit(0);
    } catch (error) {
      console.error(`停止失败: ${(error as Error).message}`);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try {
    await system.start();
    console.log(`CPX 已启动: http://127.0.0.1:${config.server.port}`);
    console.log('按 Ctrl+C 停止');
  } catch (error) {
    removePidRecord(paths.pidFile);
    throw error;
  }
}

async function startDaemon(paths: CpxRuntimePaths, configDir: string): Promise<void> {
  ensureRuntimeDirectories(paths);
  requireConfiguration(configDir);
  const existing = readPidRecord(paths.pidFile);
  if (existing && isProcessRunning(existing.pid)) {
    throw new Error(`CPX 已在运行（PID ${existing.pid}）`);
  }
  if (existing || existsSync(paths.pidFile)) removePidRecord(paths.pidFile);
  const port = new ConfigManager(configDir).load().server.port;

  const logFd = openSync(paths.daemonLog, 'a');
  const child = spawn(
    process.execPath,
    [process.argv[1], '--home', paths.home, 'start', '--dir', configDir],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, CPX_HOME: paths.home },
    },
  );
  child.unref();
  closeSync(logFd);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((done) => setTimeout(done, 100));
    const record = readPidRecord(paths.pidFile);
    if (record && isProcessRunning(record.pid) && (await healthCheck(port))) {
      console.log(`CPX 已在后台启动（PID ${record.pid}）`);
      console.log(`日志: ${paths.daemonLog}`);
      return;
    }
    if (child.pid && !isProcessRunning(child.pid)) break;
  }
  throw new Error(`后台启动失败，请查看日志: ${paths.daemonLog}`);
}

async function stopService(paths: CpxRuntimePaths): Promise<void> {
  const record = readPidRecord(paths.pidFile);
  if (!record) {
    if (existsSync(paths.pidFile)) removePidRecord(paths.pidFile);
    console.log('CPX 未运行');
    return;
  }
  if (!isProcessRunning(record.pid)) {
    removePidRecord(paths.pidFile);
    console.log(`已清理失效的 PID 记录（${record.pid}）`);
    return;
  }

  process.kill(record.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((done) => setTimeout(done, 100));
    if (!isProcessRunning(record.pid)) {
      removePidRecord(paths.pidFile);
      console.log('CPX 已停止');
      return;
    }
  }
  throw new Error(`停止超时（PID ${record.pid}），请检查进程状态`);
}

function commandVersion(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return undefined;
  return (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0];
}

function compareVersions(left: string, right: string): number {
  const normalize = (value: string): number[] =>
    value.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = normalize(left);
  const b = normalize(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('cpx')
    .description('CPX AI 开发控制台：连接 Codex、GitHub、飞书与钉钉')
    .version(packageMetadata.version)
    .option('--home <dir>', 'CPX 数据目录（默认 ~/.cpx，也可设置 CPX_HOME）');

  program
    .command('version')
    .description('显示版本信息')
    .action(() => console.log(`${PACKAGE_NAME} v${packageMetadata.version}`));

  const config = program.command('config').description('交互配置或管理 CPX 配置');
  config.action(async (_options, command: Command) => runConfigWizard(runtimePaths(command)));
  config
    .command('init')
    .description('创建默认配置文件')
    .option('-d, --dir <dir>', '兼容旧部署的自定义配置目录')
    .action((options: { dir?: string }, command: Command) => {
      const paths = pathsWithConfigDir(runtimePaths(command), options.dir);
      printInitialization(initializeConfiguration(paths, PACKAGE_ROOT));
      console.log(`配置目录: ${paths.configDir}`);
    });
  config
    .command('path')
    .description('显示 CPX 目录和配置文件位置')
    .action((_options, command: Command) => {
      const paths = runtimePaths(command);
      console.log(`CPX_HOME: ${paths.home}`);
      console.log(`配置: ${join(paths.configDir, 'config.yaml')}`);
      console.log(`数据: ${paths.dataDir}`);
      console.log(`日志: ${paths.logsDir}`);
    });
  config
    .command('show')
    .description('显示合并后的配置（自动隐藏密钥）')
    .action((_options, command: Command) => {
      const paths = runtimePaths(command);
      requireConfiguration(paths.configDir);
      const loaded = new ConfigManager(paths.configDir).load();
      console.log(yaml.dump(redactConfig(loaded), { noRefs: true, lineWidth: -1 }));
    });
  config
    .command('get <key>')
    .description('读取点分隔的配置项')
    .action((key: string, _options: unknown, command: Command) => {
      const paths = runtimePaths(command);
      const value = getConfigValue(readYamlObject(join(paths.configDir, 'config.yaml')), key);
      if (value === undefined) throw new Error(`配置项不存在: ${key}`);
      console.log(isSecretConfigPath(key) && value ? '***' : yaml.dump(value).trimEnd());
    });
  config
    .command('set <key> [value]')
    .description('设置点分隔的配置项；密钥必须通过标准输入传入')
    .option('--stdin', '从标准输入读取值')
    .action(async (key: string, value: string | undefined, options: { stdin?: boolean }, command: Command) => {
      const paths = runtimePaths(command);
      printInitialization(initializeConfiguration(paths, PACKAGE_ROOT));
      if (isSecretConfigPath(key) && !options.stdin) {
        throw new Error('敏感配置不能出现在命令历史中，请使用 --stdin');
      }
      const raw = options.stdin ? await readStdin() : value;
      if (raw === undefined) throw new Error('缺少配置值');
      const configPath = join(paths.configDir, 'config.yaml');
      const root = readYamlObject(configPath);
      const previous = structuredClone(root);
      setConfigValue(root, key, isSecretConfigPath(key) ? raw : parseConfigValue(raw));
      writeValidatedConfiguration(configPath, paths.configDir, root, previous);
      console.log(`已保存并通过校验: ${key}${isSecretConfigPath(key) ? ' = ***' : ''}`);
    });
  config
    .command('validate')
    .description('校验当前配置')
    .action((_options, command: Command) => {
      const paths = runtimePaths(command);
      requireConfiguration(paths.configDir);
      new ConfigManager(paths.configDir).load();
      console.log(`配置有效: ${join(paths.configDir, 'config.yaml')}`);
    });

  program
    .command('init')
    .description('兼容旧版：等同于 cpx config init')
    .option('-d, --dir <dir>', '自定义配置目录')
    .action((options: { dir?: string }, command: Command) => {
      const paths = pathsWithConfigDir(runtimePaths(command), options.dir);
      printInitialization(initializeConfiguration(paths, PACKAGE_ROOT));
      console.log(`配置目录: ${paths.configDir}`);
    });

  program
    .command('start')
    .description('启动 CPX（默认前台运行）')
    .option('-d, --dir <dir>', '兼容 Docker 等旧部署的自定义配置目录')
    .option('--daemon', '后台运行')
    .action(async (options: { dir?: string; daemon?: boolean }, command: Command) => {
      const paths = runtimePaths(command);
      const configDir = configDirectory(paths, options.dir);
      if (options.daemon) await startDaemon(paths, configDir);
      else await startForeground(paths, configDir);
    });

  program
    .command('status')
    .description('查看 CPX 进程和健康状态')
    .action(async (_options, command: Command) => {
      const paths = runtimePaths(command);
      const record = readPidRecord(paths.pidFile);
      if (!record || !isProcessRunning(record.pid)) {
        if (existsSync(paths.pidFile)) removePidRecord(paths.pidFile);
        console.log('状态: 未运行');
        process.exitCode = 1;
        return;
      }
      console.log('状态: 运行中');
      console.log(`PID: ${record.pid}`);
      console.log(`启动时间: ${record.startedAt}`);
      console.log(`配置目录: ${record.configDir}`);
      console.log(`健康检查: ${(await healthCheck(record.port)) ? '正常' : '不可达'}`);
      console.log(`访问地址: http://127.0.0.1:${record.port}`);
    });

  program
    .command('stop')
    .description('停止通过 cpx start 启动的进程')
    .action(async (_options, command: Command) => stopService(runtimePaths(command)));

  program
    .command('doctor')
    .description('检查 Node.js、Git、Codex 和 CPX 配置')
    .action((_options, command: Command) => {
      const paths = runtimePaths(command);
      let failed = false;
      const report = (ok: boolean, name: string, detail: string, required = true): void => {
        console.log(`${ok ? '✓' : required ? '✗' : '!'} ${name}: ${detail}`);
        if (!ok && required) failed = true;
      };
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
      const gitVersion = commandVersion('git', ['--version']);
      const codexVersion = commandVersion('codex', ['--version']);
      const ghVersion = commandVersion('gh', ['--version']);
      report(nodeMajor >= 18, 'Node.js', process.version);
      report(Boolean(gitVersion), 'Git', gitVersion ?? '未找到');
      report(Boolean(codexVersion), 'Codex CLI', codexVersion ?? '未找到');
      report(Boolean(ghVersion), 'GitHub CLI', ghVersion ?? '未找到（可选）', false);
      try {
        requireConfiguration(paths.configDir);
        new ConfigManager(paths.configDir).load();
        report(true, 'CPX 配置', `${paths.configDir}（有效）`);
      } catch (error) {
        report(false, 'CPX 配置', (error as Error).message);
      }
      if (failed) process.exitCode = 1;
    });

  program
    .command('update')
    .description('检查 npm 上是否有新版本')
    .option('--registry <url>', '指定 npm registry')
    .action((options: { registry?: string }) => {
      const args = ['view', PACKAGE_NAME, 'version', '--json'];
      if (options.registry) args.push('--registry', options.registry);
      const result = spawnSync('npm', args, { encoding: 'utf8', timeout: 15000 });
      if (result.status !== 0) throw new Error(`更新检查失败: ${(result.stderr || result.stdout).trim()}`);
      const latest = String(JSON.parse(result.stdout.trim()));
      if (compareVersions(latest, packageMetadata.version) > 0) {
        console.log(`发现新版本: ${packageMetadata.version} → ${latest}`);
        console.log(`运行 npm install -g ${PACKAGE_NAME}@latest 更新`);
      } else {
        console.log(`当前已是最新版本: ${packageMetadata.version}`);
      }
    });

  program.showHelpAfterError();
  program.showSuggestionAfterError();
  return program;
}

if (require.main === module) {
  createProgram().parseAsync(process.argv).catch((error: unknown) => {
    console.error(`错误: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
