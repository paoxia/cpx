import { existsSync } from 'fs';
import { join } from 'path';
import { Logger } from '../utils/Logger';
import { SkillError } from '../utils/errors';
import type { DatabaseService } from '../storage/Database';
import type { InstalledSkill, SkillModule } from '../core/types';

interface SkillRow {
  name: string;
  version: string;
  description: string;
  entry: string;
  permissions: string;
  source: string;
  source_url: string;
  path: string;
  installed_at: number;
  loaded: number;
}

/**
 * Skill 加载器：动态加载已安装的 Skill 模块
 */
export class SkillLoader {
  private db: DatabaseService;
  private logger: Logger;
  private loadedModules: Map<string, SkillModule> = new Map();

  constructor(_installPath: string, db: DatabaseService, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  /** 加载 Skill 模块到内存 */
  load(name: string): SkillModule {
    const cached = this.loadedModules.get(name);
    if (cached) {
      return cached;
    }

    const row = this.getRow(name);
    if (!row) {
      throw new SkillError(`Skill 未安装: ${name}`);
    }

    const entryPath = join(row.path, row.entry);
    if (!existsSync(entryPath)) {
      throw new SkillError(`Skill 入口文件不存在: ${entryPath}`);
    }

    let module: SkillModule;
    try {
      delete require.cache[require.resolve(entryPath)];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(entryPath);
      module = loaded.default ?? loaded;
    } catch (err) {
      throw new SkillError(`Skill 加载失败: ${(err as Error).message}`);
    }

    if (typeof module.execute !== 'function') {
      throw new SkillError(`Skill ${name} 未导出 execute 函数`);
    }

    this.loadedModules.set(name, module);
    this.db.prepare(`UPDATE skills SET loaded = 1 WHERE name = ?`).run(name);
    this.logger.info(`Skill ${name} 已加载`);
    return module;
  }

  /** 获取已安装 Skill 信息 */
  getInstalled(name: string): InstalledSkill | null {
    const row = this.getRow(name);
    if (!row) {
      return null;
    }
    return this.rowToInstalled(row);
  }

  /** 卸载 Skill（从内存移除引用） */
  unload(name: string): void {
    if (!this.loadedModules.has(name)) {
      return;
    }
    this.loadedModules.delete(name);
    this.db.prepare(`UPDATE skills SET loaded = 0 WHERE name = ?`).run(name);
    this.logger.info(`Skill ${name} 已卸载（内存引用移除）`);
  }

  /** 判断是否已加载 */
  isLoaded(name: string): boolean {
    return this.loadedModules.has(name);
  }

  /** 获取已加载模块 */
  getModule(name: string): SkillModule | undefined {
    return this.loadedModules.get(name);
  }

  /** 卸载所有已加载 Skill */
  unloadAll(): void {
    for (const name of this.loadedModules.keys()) {
      this.unload(name);
    }
  }

  private getRow(name: string): SkillRow | undefined {
    return this.db.prepare(`SELECT * FROM skills WHERE name = ?`).get(name) as
      | SkillRow
      | undefined;
  }

  private rowToInstalled(row: SkillRow): InstalledSkill {
    return {
      manifest: {
        name: row.name,
        version: row.version,
        description: row.description,
        entry: row.entry,
        permissions: JSON.parse(row.permissions),
      },
      source: row.source as InstalledSkill['source'],
      sourceUrl: row.source_url,
      path: row.path,
      installedAt: row.installed_at,
      loaded: row.loaded === 1,
    };
  }
}
