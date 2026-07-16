import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { ConfigManager, deepMerge } from '../../../src/config/ConfigManager';

const TMP_DIR = join(process.cwd(), 'tmp-test-config');

describe('ConfigManager', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('应使用默认配置当无 yaml 文件时', () => {
    const cm = new ConfigManager(TMP_DIR);
    const cfg = cm.load();
    expect(cfg.server.port).toBe(3000);
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.github.defaultBranch).toBe('main');
    expect(cfg.permissions.confirmationTtl).toBe(300);
  });

  it('应从 config.yaml 加载配置', () => {
    writeFileSync(
      join(TMP_DIR, 'config.yaml'),
      'server:\n  port: 8080\ngithub:\n  defaultRepo: owner/repo\n',
    );
    const cm = new ConfigManager(TMP_DIR);
    const cfg = cm.load();
    expect(cfg.server.port).toBe(8080);
    expect(cfg.github.defaultRepo).toBe('owner/repo');
  });

  it('应从 permissions.yaml 加载权限', () => {
    writeFileSync(
      join(TMP_DIR, 'permissions.yaml'),
      'git:\n  protectedBranches:\n    - main\n    - release\noperations:\n  blacklist:\n    - dangerous_cmd\n',
    );
    const cm = new ConfigManager(TMP_DIR);
    const cfg = cm.load();
    expect(cfg.permissions.git.protectedBranches).toContain('release');
    expect(cfg.permissions.operations.blacklist).toContain('dangerous_cmd');
  });

  it('环境变量应覆盖 yaml 配置', () => {
    writeFileSync(join(TMP_DIR, 'config.yaml'), 'server:\n  port: 8080\n');
    process.env.AGENT_SERVER_PORT = '9090';
    process.env.AGENT_GITHUB_TOKEN = 'ghp_secret';
    const cm = new ConfigManager(TMP_DIR);
    const cfg = cm.load();
    expect(cfg.server.port).toBe(9090);
    expect(cfg.github.token).toBe('ghp_secret');
  });

  it('应在配置校验失败时抛出 ConfigError', () => {
    writeFileSync(join(TMP_DIR, 'config.yaml'), 'server:\n  port: "not-a-number"\n');
    const cm = new ConfigManager(TMP_DIR);
    expect(() => cm.load()).toThrow();
  });

  it('getConfig 应返回已加载配置', () => {
    const cm = new ConfigManager(TMP_DIR);
    cm.load();
    expect(cm.getConfig().server.port).toBe(3000);
  });
});

describe('deepMerge', () => {
  it('应深度合并嵌套对象', () => {
    const target = { a: 1, b: { c: 2, d: 3 } };
    const source = { b: { d: 4, e: 5 } };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1, b: { c: 2, d: 4, e: 5 } });
  });

  it('源数组应直接覆盖目标数组', () => {
    const target = { list: [1, 2, 3] };
    const source = { list: [4, 5] };
    const result = deepMerge(target, source);
    expect(result).toEqual({ list: [4, 5] });
  });

  it('undefined 值不应覆盖', () => {
    const target = { a: 1 };
    const source = { a: undefined };
    const result = deepMerge(target, source);
    expect(result).toEqual({ a: 1 });
  });

  it('非对象 source 应直接返回 target', () => {
    const target = { a: 1 };
    const result = deepMerge(target, null);
    expect(result).toEqual({ a: 1 });
  });
});
