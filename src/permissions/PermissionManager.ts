import type { Command, PermissionCheckResult, PermissionConfig } from '../core/types';
import { PendingConfirmationStore } from './PendingConfirmationStore';

/**
 * 权限管理器：分支保护、操作黑名单、危险操作确认
 */
export class PermissionManager {
  private config: PermissionConfig;
  private confirmationStore: PendingConfirmationStore;

  constructor(config: PermissionConfig, confirmationStore: PendingConfirmationStore) {
    this.config = config;
    this.confirmationStore = confirmationStore;
  }

  /** 更新权限配置（热更新） */
  updateConfig(config: PermissionConfig): void {
    this.config = config;
  }

  /** 权限检查入口 */
  check(command: Command): PermissionCheckResult {
    // 确认/取消命令本身不需要权限检查
    if (command.name === 'confirm' || command.name === 'cancel') {
      return { allowed: true };
    }

    // 1. 操作黑名单
    if (this.config.operations.blacklist.includes(command.name)) {
      return {
        allowed: false,
        reason: `命令 ${command.name} 已被加入黑名单，禁止执行`,
      };
    }

    // 2. Git 分支保护（针对 github_* 命令）
    if (command.name.startsWith('github_')) {
      const branchCheck = this.checkGitOperation(command);
      if (!branchCheck.allowed) {
        return branchCheck;
      }
    }

    // 3. 危险操作确认
    if (this.config.git.confirmOperations.includes(command.name) && !command.confirmed) {
      const description = this.buildDescription(command);
      const pending = this.confirmationStore.create(command, command.name, description);
      return {
        allowed: false,
        needsConfirmation: true,
        confirmationId: pending.id,
        message: `⚠️ 危险操作确认\n\n操作: ${description}\n确认 ID: ${pending.id}\n\n回复 "确认 ${pending.id}" 继续，或 "取消 ${pending.id}" 取消`,
      };
    }

    return { allowed: true };
  }

  /** 确认操作 */
  confirm(
    id: string,
    userId: string,
    source: Command['source'],
  ): { ok: boolean; confirmation?: import('../core/types').PendingConfirmation; reason?: string } {
    return this.confirmationStore.confirm(id, userId, source);
  }

  /** 取消操作 */
  reject(id: string, userId: string): { ok: boolean; reason?: string } {
    return this.confirmationStore.reject(id, userId);
  }

  /** 根据确认 ID 获取命令信息 */
  getCommandInfo(id: string): { commandId: string; operation: string } | null {
    return this.confirmationStore.getCommandInfo(id);
  }

  private checkGitOperation(command: Command): PermissionCheckResult {
    const op = command.args.operation as string | undefined;
    const branch = (command.args.branch as string | undefined) ?? '';

    // 禁止的操作
    if (op && this.config.git.forbiddenOperations.includes(op)) {
      return { allowed: false, reason: `Git 操作 ${op} 被禁止` };
    }

    // 显式指定保护分支 -> 拒绝
    if (branch && this.isProtectedBranch(branch)) {
      return {
        allowed: false,
        reason: `分支 ${branch} 受保护，禁止直接操作。请在功能分支（如 feature/*）上操作。`,
      };
    }

    // 指定了分支但不在允许列表 -> 拒绝
    if (branch && !this.isAllowedBranch(branch)) {
      return {
        allowed: false,
        reason: `分支 ${branch} 不在允许列表中。允许: ${this.config.git.allowedBranches.join(', ')}`,
      };
    }

    return { allowed: true };
  }

  isProtectedBranch(branch: string): boolean {
    return this.config.git.protectedBranches.includes(branch);
  }

  isAllowedBranch(branch: string): boolean {
    if (this.config.git.allowedBranches.length === 0) {
      return true;
    }
    return this.config.git.allowedBranches.some((pattern) => matchGlob(pattern, branch));
  }

  private buildDescription(command: Command): string {
    const parts = [command.name];
    for (const [k, v] of Object.entries(command.args)) {
      parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    return parts.join(' ');
  }
}

/**
 * glob 匹配：支持 * 通配
 * 例：feature/* 匹配 feature/anything
 */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }
  // 将 glob 转为正则
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(value);
}
