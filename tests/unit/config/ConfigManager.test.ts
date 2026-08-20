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

  it('应从环境变量加载消息平台长连接凭据和开关', () => {
    process.env.AGENT_DINGTALK_ENABLED = 'true';
    process.env.AGENT_DINGTALK_CLIENT_ID = 'ding-id';
    process.env.AGENT_DINGTALK_CLIENT_SECRET = 'ding-secret';
    process.env.AGENT_FEISHU_ENABLED = '1';
    process.env.AGENT_FEISHU_APP_ID = 'cli_test';
    process.env.AGENT_FEISHU_APP_SECRET = 'feishu-secret';
    const cfg = new ConfigManager(TMP_DIR).load();
    expect(cfg.dingtalk).toEqual({
      enabled: true,
      clientId: 'ding-id',
      clientSecret: 'ding-secret',
    });
    expect(cfg.feishu).toEqual({
      enabled: true,
      appId: 'cli_test',
      appSecret: 'feishu-secret',
    });
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

  it('应将 GitHub Token 持久化到 config.yaml 并保留其他配置', () => {
    writeFileSync(
      join(TMP_DIR, 'config.yaml'),
      'server:\n  port: 8080\ngithub:\n  defaultRepo: owner/repo\n  defaultBranch: develop\n',
    );
    const cm = new ConfigManager(TMP_DIR);
    cm.load();

    cm.saveGitHubToken('github_pat_persisted');

    const reloaded = new ConfigManager(TMP_DIR).load();
    expect(reloaded.server.port).toBe(8080);
    expect(reloaded.github).toEqual({
      token: 'github_pat_persisted',
      defaultRepo: 'owner/repo',
      defaultBranch: 'develop',
    });
    expect(cm.getConfig().github.token).toBe('github_pat_persisted');
  });

  it('应持久化页面提交的长连接配置并保留其他配置', () => {
    writeFileSync(join(TMP_DIR, 'config.yaml'), 'server:\n  port: 8080\n');
    const cm = new ConfigManager(TMP_DIR);
    cm.load();

    cm.saveMessagingConfig('feishu', {
      enabled: true,
      appId: 'cli_saved',
      appSecret: 'saved-secret',
    });

    const reloaded = new ConfigManager(TMP_DIR).load();
    expect(reloaded.server.port).toBe(8080);
    expect(reloaded.feishu).toEqual({
      enabled: true,
      appId: 'cli_saved',
      appSecret: 'saved-secret',
    });
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
