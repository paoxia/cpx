/**
 * Agent System 错误类型层级
 */

export class AgentError extends Error {
  constructor(
    message: string,
    public code: string = 'AGENT_ERROR',
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export class PermissionError extends AgentError {
  constructor(message: string) {
    super(message, 'PERMISSION_DENIED', 403);
    this.name = 'PermissionError';
  }
}

export class SkillError extends AgentError {
  constructor(message: string) {
    super(message, 'SKILL_ERROR', 500);
    this.name = 'SkillError';
  }
}

export class MCPError extends AgentError {
  constructor(message: string) {
    super(message, 'MCP_ERROR', 500);
    this.name = 'MCPError';
  }
}

export class GitHubError extends AgentError {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message, 'GITHUB_ERROR', status ?? 500);
    this.name = 'GitHubError';
  }
}

export class ConfigError extends AgentError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', 500);
    this.name = 'ConfigError';
  }
}

export class CommandError extends AgentError {
  constructor(message: string) {
    super(message, 'COMMAND_ERROR', 400);
    this.name = 'CommandError';
  }
}

export function isAgentError(err: unknown): err is AgentError {
  return err instanceof AgentError;
}
