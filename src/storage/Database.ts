import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';
import { Logger } from '../utils/Logger';
import { MIGRATIONS } from './migrations';

/**
 * SQLite 数据库封装
 */
export class DatabaseService {
  private db: Database.Database;
  private logger: Logger;

  constructor(dbPath: string, logger: Logger) {
    this.logger = logger;
    const dir = dirname(dbPath);
    if (dir && dir !== '.') {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.logger.info(`数据库已就绪: ${dbPath}`);
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) {
      this.db.close();
      throw new Error('数据库版本高于当前程序支持的版本，请恢复匹配的程序与备份');
    }
    const tx = this.db.transaction(() => {
      for (const sql of MIGRATIONS) {
        this.db.exec(sql);
      }
      this.db.pragma('user_version = 1');
    });
    tx();
  }

  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  async backup(destination: string): Promise<void> {
    await this.db.backup(destination);
    chmodSync(destination, 0o600);
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
      this.logger.info('数据库已关闭');
    }
  }
}
