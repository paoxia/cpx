import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
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
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.logger.info(`数据库已就绪: ${dbPath}`);
  }

  private migrate(): void {
    const tx = this.db.transaction(() => {
      for (const sql of MIGRATIONS) {
        this.db.exec(sql);
      }
    });
    tx();
  }

  prepare(sql: string): Database.Statement {
    return this.db.prepare(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    if (this.db.open) {
      this.db.close();
      this.logger.info('数据库已关闭');
    }
  }
}
