/**
 * Agent System 共享类型定义
 */

// ============ 命令与结果 ============

export type CommandSource = 'dingtalk' | 'feishu' | 'cli';

export interface Command {
  id: string;
  source: CommandSource;
  userId: string;
  userName: string;
  /** 消息平台会话路由，不作为用户身份或权限标识。 */
  replyRouteId?: string;
  rawText: string;
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
  confirmed?: boolean;
}

export interface CommandResult {
  commandId: string;
  success: boolean;
  message: string;
  data?: unknown;
  prUrl?: string;
  needsConfirmation?: boolean;
  confirmationId?: string;
}

// ============ 任务 ============

export type TaskType = 'skill_execute' | 'mcp_call' | 'github_op' | 'agent_delegate';
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'awaiting_confirmation';

export interface Task {
  id: string;
  commandId: string;
  type: TaskType;
  status: TaskStatus;
  params: Record<string, unknown>;
  result?: CommandResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// ============ Skill 插件 ============

export interface SkillPermissions {
  github: boolean;
  mcp: boolean;
  network: boolean;
  filesystem: boolean;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: SkillPermissions;
  configSchema?: unknown;
}

export type SkillSource = 'npm' | 'local' | 'git';

export interface InstalledSkill {
  manifest: SkillManifest;
  source: SkillSource;
  sourceUrl: string;
  path: string;
  installedAt: number;
  loaded: boolean;
}

export interface SkillContext {
  commandId: string;
  args: Record<string, unknown>;
  logger: LoggerLike;
  github?: GitHubServiceLike;
  mcp?: MCPManagerLike;
}

export interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface SkillModule {
  execute(ctx: SkillContext): Promise<SkillResult>;
}

// 用于 SkillContext 的最小接口（避免循环依赖）
export interface LoggerLike {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface GitHubServiceLike {
  readFile(repo: string, path: string, branch?: string): Promise<{ content: string; sha: string }>;
  modifyFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<{ commit: { sha: string } }>;
  createFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<{ commit: { sha: string } }>;
  createBranch(repo: string, branchName: string, fromBranch?: string): Promise<void>;
  createPR(
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<{ url: string; number: number }>;
}

export interface MCPManagerLike {
  call(connectionId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

// ============ MCP 连接 ============

export type MCPTransport = 'stdio' | 'websocket' | 'http';
export type MCPConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface MCPConnectionConfig {
  name: string;
  transport: MCPTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface MCPConnection {
  id: string;
  name: string;
  transport: MCPTransport;
  command?: string;
  args: string[];
  env?: Record<string, string>;
  url?: string;
  status: MCPConnectionStatus;
  capabilities: string[];
  pid?: number;
  connectedAt?: number;
  error?: string;
}

export interface MCPCallRequest {
  connectionId: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

// ============ Agent 注册与委托 ============

export interface AgentRegistration {
  id: string;
  name: string;
  type: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeout: number;
  registeredAt: number;
}

export interface DelegateRequest {
  agentId: string;
  task: string;
  context?: Record<string, unknown>;
  timeout?: number;
}

export interface DelegateResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode?: number;
  duration: number;
}

// ============ 权限 ============

export interface GitPermissionConfig {
  protectedBranches: string[];
  allowedBranches: string[];
  forbiddenOperations: string[];
  confirmOperations: string[];
}

export interface OperationPermissionConfig {
  blacklist: string[];
}

export interface PermissionConfig {
  git: GitPermissionConfig;
  operations: OperationPermissionConfig;
  confirmationTtl: number;
}

export type ConfirmationStatus = 'pending' | 'confirmed' | 'rejected' | 'expired';

export interface PendingConfirmation {
  id: string;
  commandId: string;
  userId: string;
  source: CommandSource;
  operation: string;
  description: string;
  status: ConfirmationStatus;
  createdAt: number;
  expiresAt: number;
  confirmedBy?: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  needsConfirmation?: boolean;
  confirmationId?: string;
  message?: string;
}

// ============ 应用配置 ============

export interface ServerConfig {
  port: number;
  host: string;
}

export interface DingTalkConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
}

export interface FeishuConfig {
  enabled: boolean;
  appId?: string;
  appSecret?: string;
}

export interface GitHubConfig {
  token?: string;
  defaultRepo?: string;
  defaultBranch: string;
}

export interface SkillsConfig {
  installPath: string;
  executionTimeout: number;
}

export interface McpConfig {
  connections: MCPConnectionConfig[];
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  file?: string;
}

export interface StorageConfig {
  path: string;
}

export interface AppConfig {
  server: ServerConfig;
  dingtalk: DingTalkConfig;
  feishu: FeishuConfig;
  github: GitHubConfig;
  skills: SkillsConfig;
  mcp: McpConfig;
  permissions: PermissionConfig;
  logging: LoggingConfig;
  storage: StorageConfig;
}

// ============ 审计日志 ============

export type AuditAction =
  | 'permission_check'
  | 'permission_denied'
  | 'dangerous_op_confirm'
  | 'dangerous_op_reject'
  | 'dangerous_op_expire'
  | 'github_op'
  | 'skill_execute'
  | 'mcp_call'
  | 'agent_delegate'
  | 'agent_platform_tool'
  | 'command_received'
  | 'command_completed'
  | 'command_failed';

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  action: AuditAction;
  userId: string;
  source: CommandSource;
  commandId?: string;
  operation: string;
  result: 'success' | 'failure' | 'denied';
  details?: string;
}
