import type { Command, CommandResult, PermissionCheckResult } from './types';
import { Logger } from '../utils/Logger';

export type CommandHandler = (command: Command) => Promise<CommandResult>;
export type PermissionChecker = (command: Command) => PermissionCheckResult;

/**
 * 命令路由器：将解析后的命令分派到注册的处理器
 */
export class CommandRouter {
  private handlers: Map<string, CommandHandler> = new Map();
  private permissionChecker: PermissionChecker;
  private logger: Logger;

  constructor(logger: Logger, permissionChecker?: PermissionChecker) {
    this.logger = logger;
    this.permissionChecker = permissionChecker ?? (() => ({ allowed: true }));
  }

  setPermissionChecker(checker: PermissionChecker): void {
    this.permissionChecker = checker;
  }

  register(name: string, handler: CommandHandler): void {
    this.handlers.set(name, handler);
  }

  /** 分派命令到处理器 */
  async dispatch(command: Command): Promise<CommandResult> {
    this.logger.info(`分发命令: ${command.name} (来源: ${command.source}, 用户: ${command.userName})`);

    // 权限检查
    const check = this.permissionChecker(command);
    if (!check.allowed) {
      if (check.needsConfirmation && check.confirmationId) {
        return {
          commandId: command.id,
          success: false,
          message: check.message ?? `操作需要确认`,
          needsConfirmation: true,
          confirmationId: check.confirmationId,
        };
      }
      return {
        commandId: command.id,
        success: false,
        message: check.reason ?? `权限不足`,
      };
    }

    const handler = this.handlers.get(command.name);
    if (!handler) {
      return {
        commandId: command.id,
        success: false,
        message: `未知命令: ${command.name}。发送 'help' 查看可用命令。`,
      };
    }

    try {
      return await handler(command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`命令执行失败 ${command.name}: ${message}`);
      return {
        commandId: command.id,
        success: false,
        message: `执行失败: ${message}`,
      };
    }
  }

  hasHandler(name: string): boolean {
    return this.handlers.has(name);
  }
}
