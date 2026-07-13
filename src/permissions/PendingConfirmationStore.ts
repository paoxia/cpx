import { randomBytes } from 'crypto';
import type { DatabaseService } from '../storage/Database';
import type { Command, CommandSource, PendingConfirmation, ConfirmationStatus } from '../core/types';

interface ConfirmationRow {
  id: string;
  command_id: string;
  user_id: string;
  source: string;
  operation: string;
  description: string;
  status: string;
  created_at: number;
  expires_at: number;
  confirmed_by: string | null;
}

/**
 * 待确认操作存储：SQLite 持久化，支持 TTL 过期
 */
export class PendingConfirmationStore {
  private db: DatabaseService;
  private ttl: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(db: DatabaseService, ttlSeconds: number = 300) {
    this.db = db;
    this.ttl = ttlSeconds;
  }

  /** 创建待确认记录 */
  create(command: Command, operation: string, description: string): PendingConfirmation {
    const id = `cf_${randomBytes(4).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + this.ttl * 1000;
    const commandJson = JSON.stringify(command);

    const stmt = this.db.prepare(
      `INSERT INTO pending_confirmations
       (id, command_id, user_id, source, operation, description, command_json, status, created_at, expires_at, confirmed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
    );
    stmt.run(
      id,
      command.id,
      command.userId,
      command.source,
      operation,
      description,
      commandJson,
      now,
      expiresAt,
    );

    return {
      id,
      commandId: command.id,
      userId: command.userId,
      source: command.source,
      operation,
      description,
      status: 'pending',
      createdAt: now,
      expiresAt,
    };
  }

  /** 查询待确认记录 */
  get(id: string): PendingConfirmation | null {
    const stmt = this.db.prepare(`SELECT * FROM pending_confirmations WHERE id = ?`);
    const row = stmt.get(id) as ConfirmationRow | undefined;
    if (!row) {
      return null;
    }
    return this.rowToConfirmation(row);
  }

  /** 确认操作（校验用户和来源） */
  confirm(
    id: string,
    userId: string,
    source: CommandSource,
  ): { ok: boolean; confirmation?: PendingConfirmation; reason?: string } {
    const confirmation = this.get(id);
    if (!confirmation) {
      return { ok: false, reason: '确认记录不存在' };
    }
    if (confirmation.status !== 'pending') {
      return { ok: false, reason: `操作已${this.statusLabel(confirmation.status)}` };
    }
    if (Date.now() > confirmation.expiresAt) {
      this.updateStatus(id, 'expired');
      return { ok: false, reason: '确认已过期，请重新发起操作' };
    }
    if (confirmation.userId !== userId || confirmation.source !== source) {
      return { ok: false, reason: '确认用户或渠道不匹配' };
    }
    this.db
      .prepare(`UPDATE pending_confirmations SET status = 'confirmed', confirmed_by = ? WHERE id = ?`)
      .run(userId, id);
    return { ok: true, confirmation: { ...confirmation, status: 'confirmed', confirmedBy: userId } };
  }

  /** 拒绝操作 */
  reject(id: string, userId: string): { ok: boolean; reason?: string } {
    const confirmation = this.get(id);
    if (!confirmation) {
      return { ok: false, reason: '确认记录不存在' };
    }
    if (confirmation.status !== 'pending') {
      return { ok: false, reason: `操作已${this.statusLabel(confirmation.status)}` };
    }
    this.db
      .prepare(`UPDATE pending_confirmations SET status = 'rejected', confirmed_by = ? WHERE id = ?`)
      .run(userId, id);
    return { ok: true };
  }

  /** 获取原始命令信息（用于确认后重派） */
  getCommandInfo(id: string): { commandId: string; operation: string } | null {
    const confirmation = this.get(id);
    if (!confirmation) {
      return null;
    }
    return { commandId: confirmation.commandId, operation: confirmation.operation };
  }

  /** 获取完整的原始命令（用于确认后重派） */
  getOriginalCommand(id: string): Command | null {
    const stmt = this.db.prepare(
      `SELECT command_json FROM pending_confirmations WHERE id = ?`,
    );
    const row = stmt.get(id) as { command_json: string | null } | undefined;
    if (!row || !row.command_json) {
      return null;
    }
    try {
      return JSON.parse(row.command_json) as Command;
    } catch {
      return null;
    }
  }

  /** 启动过期清理定时器 */
  startExpiryCleanup(intervalMs: number = 60000): void {
    this.cleanupTimer = setInterval(() => {
      this.db
        .prepare(`UPDATE pending_confirmations SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`)
        .run(Date.now());
    }, intervalMs);
  }

  stopExpiryCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private updateStatus(id: string, status: ConfirmationStatus): void {
    this.db.prepare(`UPDATE pending_confirmations SET status = ? WHERE id = ?`).run(status, id);
  }

  private rowToConfirmation(row: ConfirmationRow): PendingConfirmation {
    return {
      id: row.id,
      commandId: row.command_id,
      userId: row.user_id,
      source: row.source as CommandSource,
      operation: row.operation,
      description: row.description,
      status: row.status as ConfirmationStatus,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      confirmedBy: row.confirmed_by ?? undefined,
    };
  }

  private statusLabel(status: ConfirmationStatus): string {
    return { pending: '待确认', confirmed: '确认', rejected: '拒绝', expired: '过期' }[status];
  }
}
