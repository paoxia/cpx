import type { AppConfig } from '../core/types';

/**
 * 默认配置（优先级最低，被 config.yaml / permissions.yaml / 环境变量覆盖）
 */
export const DEFAULT_CONFIG: AppConfig = {
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  dingtalk: {
    enabled: false,
    clientId: undefined,
    clientSecret: undefined,
  },
  feishu: {
    enabled: false,
    appId: undefined,
    appSecret: undefined,
  },
  github: {
    token: undefined,
    defaultRepo: undefined,
    defaultBranch: 'main',
  },
  skills: {
    installPath: './data/skills',
    executionTimeout: 30000,
  },
  mcp: {
    connections: [],
  },
  permissions: {
    git: {
      protectedBranches: ['main', 'master', 'production'],
      allowedBranches: ['feature/*', 'dev/*', 'hotfix/*'],
      forbiddenOperations: ['force_push', 'delete_branch', 'delete_repository'],
      confirmOperations: ['delete_file', 'merge_to_main'],
    },
    operations: {
      blacklist: [],
    },
    confirmationTtl: 300, // 5 分钟
  },
  logging: {
    level: 'info',
    file: undefined,
  },
  storage: {
    path: './data/agent.db',
  },
};
