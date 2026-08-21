import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cpxRuntimePaths,
  getConfigValue,
  initializeConfiguration,
  isProcessRunning,
  isSecretConfigPath,
  parseConfigValue,
  readPidRecord,
  readYamlObject,
  redactConfig,
  removePidRecord,
  resolveCpxHome,
  setConfigValue,
  writePidRecord,
  writeYamlObject,
} from '../../src/cliSupport';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cpx-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CLI 运行目录', () => {
  it('优先使用显式目录，其次使用 CPX_HOME', () => {
    const explicit = temporaryDirectory();
    const environmentHome = temporaryDirectory();
    expect(resolveCpxHome(explicit, { CPX_HOME: environmentHome })).toBe(resolve(explicit));
    expect(resolveCpxHome(undefined, { CPX_HOME: environmentHome })).toBe(resolve(environmentHome));
  });

  it('按固定层级生成配置、数据、日志和 PID 路径', () => {
    const home = temporaryDirectory();
    const paths = cpxRuntimePaths(home);
    expect(paths.configDir).toBe(join(home, 'config'));
    expect(paths.dataDir).toBe(join(home, 'data'));
    expect(paths.daemonLog).toBe(join(home, 'logs', 'cpx.log'));
    expect(paths.pidFile).toBe(join(home, 'run', 'cpx.pid.json'));
  });

  it('只从包内示例创建缺失配置且不覆盖已有文件', () => {
    const paths = cpxRuntimePaths(temporaryDirectory());
    const packageRoot = resolve(__dirname, '../..');
    const first = initializeConfiguration(paths, packageRoot);
    expect(first.created).toHaveLength(2);
    const configPath = join(paths.configDir, 'config.yaml');
    const original = readFileSync(configPath, 'utf8');
    chmodSync(configPath, 0o600);

    const second = initializeConfiguration(paths, packageRoot);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(2);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
  });
});

describe('CLI 配置读写', () => {
  it('支持点路径、YAML 值解析和安全脱敏', () => {
    const root: Record<string, unknown> = {};
    setConfigValue(root, 'server.port', parseConfigValue('3100'));
    setConfigValue(root, 'github.token', 'secret-token');
    setConfigValue(root, 'feishu.appSecret', 'app-secret');
    expect(getConfigValue(root, 'server.port')).toBe(3100);
    expect(isSecretConfigPath('github.token')).toBe(true);
    expect(isSecretConfigPath('feishu.appSecret')).toBe(true);
    expect(redactConfig(root)).toEqual({
      server: { port: 3100 },
      github: { token: '***' },
      feishu: { appSecret: '***' },
    });
  });

  it('以 0600 权限写入并重新读取 YAML', () => {
    const configPath = join(temporaryDirectory(), 'config', 'config.yaml');
    writeYamlObject(configPath, { server: { port: 3200 } });
    expect(readYamlObject(configPath)).toEqual({ server: { port: 3200 } });
  });
});

describe('CLI PID 记录', () => {
  it('写入、读取并清理当前进程记录', () => {
    const pidFile = join(temporaryDirectory(), 'run', 'cpx.pid.json');
    const record = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      configDir: '/tmp/cpx/config',
      port: 3000,
    };
    writePidRecord(pidFile, record);
    expect(readPidRecord(pidFile)).toEqual(record);
    expect(isProcessRunning(process.pid)).toBe(true);
    removePidRecord(pidFile);
    expect(readPidRecord(pidFile)).toBeUndefined();
  });
});
