import { z } from 'zod';

export const SkillPermissionsSchema = z.object({
  github: z.boolean().default(false),
  mcp: z.boolean().default(false),
  network: z.boolean().default(false),
  filesystem: z.boolean().default(false),
});

export const SkillManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  entry: z.string().default('index.js'),
  permissions: SkillPermissionsSchema.default({}),
  configSchema: z.unknown().optional(),
});

export const ServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  host: z.string().default('0.0.0.0'),
});

export const DingTalkConfigSchema = z.object({
  webhookUrl: z.string().url().optional().or(z.literal('')),
  secret: z.string().optional(),
  enableVerify: z.boolean().default(true),
});

export const FeishuConfigSchema = z.object({
  webhookUrl: z.string().url().optional().or(z.literal('')),
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  enableVerify: z.boolean().default(true),
});

export const GitHubConfigSchema = z.object({
  token: z.string().optional(),
  defaultRepo: z
    .string()
    .optional()
    .refine((v) => !v || /^[^/]+\/[^/]+$/.test(v), 'defaultRepo 格式应为 owner/repo'),
  defaultBranch: z.string().default('main'),
});

export const SkillsConfigSchema = z.object({
  installPath: z.string().default('./data/skills'),
  executionTimeout: z.number().int().positive().default(30000),
});

export const MCPConnectionConfigSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['stdio', 'websocket', 'http']).default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
});

export const McpConfigSchema = z.object({
  connections: z.array(MCPConnectionConfigSchema).default([]),
});

export const GitPermissionConfigSchema = z.object({
  protectedBranches: z.array(z.string()).default(['main', 'master', 'production']),
  allowedBranches: z.array(z.string()).default(['feature/*', 'dev/*', 'hotfix/*']),
  forbiddenOperations: z.array(z.string()).default([
    'force_push',
    'delete_branch',
    'delete_repository',
  ]),
  confirmOperations: z.array(z.string()).default(['delete_file', 'merge_to_main']),
});

export const OperationPermissionConfigSchema = z.object({
  blacklist: z.array(z.string()).default([]),
});

export const PermissionConfigSchema = z.object({
  git: GitPermissionConfigSchema.default({}),
  operations: OperationPermissionConfigSchema.default({}),
  confirmationTtl: z.number().int().positive().default(300),
});

export const LoggingConfigSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  file: z.string().optional(),
});

export const StorageConfigSchema = z.object({
  path: z.string().default('./data/agent.db'),
});

export const AppConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  dingtalk: DingTalkConfigSchema.default({}),
  feishu: FeishuConfigSchema.default({}),
  github: GitHubConfigSchema.default({}),
  skills: SkillsConfigSchema.default({}),
  mcp: McpConfigSchema.default({}),
  permissions: PermissionConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
});
