import { randomUUID } from 'crypto';
import type { DatabaseService } from '../storage/Database';
import type { AuditAction, AuditLogEntry, CommandSource } from '../core/types';

/**
 * 审计日志记录器
 */
export class AuditLogger {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  record(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): void {
    const stmt = this.db.prepare(
      `INSERT INTO audit_logs (id, timestamp, action, user_id, source, command_id, operation, result, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      randomUUID(),
      Date.now(),
      entry.action,
      entry.userId,
      entry.source,
      entry.commandId ?? null,
      entry.operation,
      entry.result,
      entry.details ?? null,
    );
  }

  list(limit: number = 100): Promise<Partial<AuditLogEntry>[]> {
    const stmt = this.db.prepare(
      `SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?`,
    );
    return Promise.resolve(stmt.all(limit) as unknown as Partial<AuditLogEntry>[]);
  }
}

export interface AuditRecordInput {
  action: AuditAction;
  userId: string;
  source: CommandSource;
  commandId?: string;
  operation: string;
  result: 'success' | 'failure' | 'denied';
  details?: string;
}
