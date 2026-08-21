import { chmodSync, readFileSync, existsSync, mkdirSync, watch, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import * as yaml from 'js-yaml';
import dotenv from 'dotenv';
import { Logger } from '../utils/Logger';
import { ConfigError } from '../utils/errors';
import { DEFAULT_CONFIG } from './defaults';
import { AppConfigSchema } from './schema';
import type { AppConfig, DingTalkConfig, FeishuConfig } from '../core/types';

/**
 * 配置管理器：加载、合并、校验、热更新
 *
 * 加载顺序（后者覆盖前者）：
 * 1. 默认配置 (defaults.ts)
 * 2. config.yaml
 * 3. permissions.yaml（合并到 config.permissions）
 * 4. 环境变量（AGENT_ 前缀，优先级最高）
 */
export class ConfigManager {
  private config: AppConfig;
  private logger: Logger;
  private configDir: string;
  private watchTimer?: NodeJS.Timeout;
  private onReload?: () => void;

  constructor(configDir: string = './config', logger?: Logger) {
    this.configDir = resolve(configDir);
    this.logger = logger ?? new Logger('info');
    this.config = structuredClone(DEFAULT_CONFIG);
  }

  /** 加载并校验配置 */
  load(): AppConfig {
    // 1. .env 文件（仅本地开发；Docker 中环境变量由 -e 直接注入）
    dotenv.config();

    // 2. 从默认值开始
    let config = structuredClone(DEFAULT_CONFIG);

    // 3. 加载 config.yaml
    const configPath = join(this.configDir, 'config.yaml');
    if (existsSync(configPath)) {
      try {
        const yamlContent = readFileSync(configPath, 'utf8');
        const yamlConfig = yaml.load(yamlContent) as Record<string, unknown>;
        config = deepMerge(config, yamlConfig);
      } catch (err) {
        throw new ConfigError(`解析 config.yaml 失败: ${(err as Error).message}`);
      }
    }

    // 4. 加载 permissions.yaml
    const permPath = join(this.configDir, 'permissions.yaml');
    if (existsSync(permPath)) {
      try {
        const permContent = readFileSync(permPath, 'utf8');
        const permConfig = yaml.load(permContent) as Record<string, unknown>;
        config.permissions = deepMerge(config.permissions, permConfig);
      } catch (err) {
        throw new ConfigError(`解析 permissions.yaml 失败: ${(err as Error).message}`);
      }
    }

    // 5. 应用环境变量覆盖
    config = applyEnvOverrides(config);

    // 6. zod 校验
    const result = AppConfigSchema.safeParse(config);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new ConfigError(`配置校验失败: ${issues}`);
    }

    this.config = resolveRuntimePaths(result.data as AppConfig, dirname(this.configDir));
    return this.config;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /** 将已验证的 GitHub Token 持久化到 config.yaml。 */
  saveGitHubToken(token: string): void {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new ConfigError('GitHub Token 不能为空');
    }

    const configPath = join(this.configDir, 'config.yaml');
    let fileConfig: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const parsed = yaml.load(readFileSync(configPath, 'utf8'));
        if (parsed !== undefined && parsed !== null) {
          if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('根节点必须是对象');
          }
          fileConfig = parsed as Record<string, unknown>;
        }
      } catch (err) {
        throw new ConfigError(
          `无法保存 GitHub Token，解析 config.yaml 失败: ${(err as Error).message}`,
        );
      }
    }

    const githubConfig =
      fileConfig.github &&
      typeof fileConfig.github === 'object' &&
      !Array.isArray(fileConfig.github)
        ? (fileConfig.github as Record<string, unknown>)
        : {};
    fileConfig.github = { ...githubConfig, token: normalizedToken };

    try {
      mkdirSync(this.configDir, { recursive: true });
      writeFileSync(
        configPath,
        yaml.dump(fileConfig, { noRefs: true, lineWidth: -1, sortKeys: false }),
        { encoding: 'utf8', mode: 0o600 },
      );
      if (process.platform !== 'win32') chmodSync(configPath, 0o600);
      this.config.github.token = normalizedToken;
    } catch (err) {
      throw new ConfigError(`无法保存 GitHub Token: ${(err as Error).message}`);
    }
  }

  /** 将页面验证过的消息平台配置保存到 config.yaml，并更新当前内存配置。 */
  saveMessagingConfig(
    platform: 'dingtalk' | 'feishu',
    next: DingTalkConfig | FeishuConfig,
  ): AppConfig {
    const candidate = structuredClone(this.config);
    if (platform === 'dingtalk') {
      candidate.dingtalk = next as DingTalkConfig;
    } else {
      candidate.feishu = next as FeishuConfig;
    }
    const result = AppConfigSchema.safeParse(candidate);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      throw new ConfigError(`消息平台配置校验失败: ${issues.join('; ')}`);
    }

    const fileConfig = this.readFileConfig();
    fileConfig[platform] = structuredClone(result.data[platform]);
    this.writeFileConfig(fileConfig, `无法保存${platform === 'dingtalk' ? '钉钉' : '飞书'}配置`);
    this.config = result.data as AppConfig;
    return this.config;
  }

  private readFileConfig(): Record<string, unknown> {
    const configPath = join(this.configDir, 'config.yaml');
    if (!existsSync(configPath)) return {};
    try {
      const parsed = yaml.load(readFileSync(configPath, 'utf8'));
      if (parsed === undefined || parsed === null) return {};
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('根节点必须是对象');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`解析 config.yaml 失败: ${(err as Error).message}`);
    }
  }

  private writeFileConfig(fileConfig: Record<string, unknown>, message: string): void {
    try {
      mkdirSync(this.configDir, { recursive: true });
      writeFileSync(
        join(this.configDir, 'config.yaml'),
        yaml.dump(fileConfig, { noRefs: true, lineWidth: -1, sortKeys: false }),
        { encoding: 'utf8', mode: 0o600 },
      );
      if (process.platform !== 'win32') chmodSync(join(this.configDir, 'config.yaml'), 0o600);
    } catch (err) {
      throw new ConfigError(`${message}: ${(err as Error).message}`);
    }
  }

  setOnReload(callback: () => void): void {
    this.onReload = callback;
  }

  /** 启动配置文件监听（热更新） */
  startWatching(): void {
    if (!existsSync(this.configDir)) {
      return;
    }
    try {
      watch(this.configDir, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.yaml')) {
          return;
        }
        // 500ms 防抖
        if (this.watchTimer) {
          clearTimeout(this.watchTimer);
        }
        this.watchTimer = setTimeout(() => {
          try {
            this.load();
            this.logger.info(`配置已热更新: ${filename}`);
            this.onReload?.();
          } catch (err) {
            this.logger.error(`配置热更新失败: ${(err as Error).message}`);
          }
        }, 500);
      });
    } catch {
      this.logger.warn('配置目录监听启动失败，热更新不可用');
    }
  }

  stopWatching(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = undefined;
    }
  }
}

/** 配置中的相对运行路径以 config/ 的父目录为基准，不受启动目录影响。 */
export function resolveRuntimePaths(config: AppConfig, runtimeRoot: string): AppConfig {
  const resolved = structuredClone(config);
  resolved.storage.path = resolveConfiguredPath(resolved.storage.path, runtimeRoot);
  resolved.skills.installPath = resolveConfiguredPath(resolved.skills.installPath, runtimeRoot);
  if (resolved.logging.file) {
    resolved.logging.file = resolveConfiguredPath(resolved.logging.file, runtimeRoot);
  }
  return resolved;
}

function resolveConfiguredPath(value: string, runtimeRoot: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(runtimeRoot, value);
}

/**
 * 深度合并对象（后者覆盖前者）
 */
export function deepMerge<T>(target: T, source: unknown): T {
  if (!source || typeof source !== 'object') {
    return target;
  }
  const result: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

// 环境变量到配置路径的映射
const ENV_MAP: Record<string, string> = {
  AGENT_SERVER_PORT: 'server.port',
  AGENT_SERVER_HOST: 'server.host',
  AGENT_DINGTALK_ENABLED: 'dingtalk.enabled',
  AGENT_DINGTALK_CLIENT_ID: 'dingtalk.clientId',
  AGENT_DINGTALK_CLIENT_SECRET: 'dingtalk.clientSecret',
  AGENT_FEISHU_ENABLED: 'feishu.enabled',
  AGENT_FEISHU_APP_ID: 'feishu.appId',
  AGENT_FEISHU_APP_SECRET: 'feishu.appSecret',
  AGENT_GITHUB_TOKEN: 'github.token',
  AGENT_GITHUB_DEFAULT_REPO: 'github.defaultRepo',
  AGENT_LOGGING_LEVEL: 'logging.level',
  AGENT_STORAGE_PATH: 'storage.path',
};

/**
 * 应用环境变量覆盖
 */
function applyEnvOverrides(config: AppConfig): AppConfig {
  const result = structuredClone(config);
  for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
    const envValue = process.env[envKey];
    if (envValue === undefined || envValue === '') {
      continue;
    }
    setByPath(result as unknown as Record<string, unknown>, configPath, envValue);
  }
  return result;
}

function setByPath(obj: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  // 数字类型转换
  if (lastKey === 'port' || lastKey === 'executionTimeout' || lastKey === 'confirmationTtl') {
    current[lastKey] = parseInt(value, 10);
  } else if (lastKey === 'enabled') {
    current[lastKey] = /^(1|true|yes|on)$/i.test(value);
  } else {
    current[lastKey] = value;
  }
}
