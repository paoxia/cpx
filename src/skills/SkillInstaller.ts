import { execSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { Logger } from '../utils/Logger';
import { SkillError } from '../utils/errors';
import { SkillManifestSchema } from '../config/schema';
import type { DatabaseService } from '../storage/Database';
import type { InstalledSkill, SkillManifest, SkillSource } from '../core/types';

/**
 * Skill 安装器：从 npm/local/git 安装 Skill 包
 */
export class SkillInstaller {
  private installPath: string;
  private db: DatabaseService;
  private logger: Logger;

  constructor(installPath: string, db: DatabaseService, logger: Logger) {
    this.installPath = resolve(installPath);
    this.db = db;
    this.logger = logger;
    if (!existsSync(this.installPath)) {
      mkdirSync(this.installPath, { recursive: true });
    }
  }

  /** 安装 Skill */
  async install(source: SkillSource, identifier: string): Promise<InstalledSkill> {
    const skillsDir = this.installPath;
    this.logger.info(`安装 Skill: ${identifier} (来源: ${source})`);

    let pkgName: string;
    let sourceUrl: string;

    if (source === 'npm') {
      pkgName = identifier;
      sourceUrl = `npm:${identifier}`;
    } else if (source === 'local') {
      const localPath = resolve(identifier);
      if (!existsSync(localPath)) {
        throw new SkillError(`本地路径不存在: ${localPath}`);
      }
      pkgName = this.readLocalPackageName(localPath);
      sourceUrl = localPath;
    } else if (source === 'git') {
      pkgName = identifier.split('/').pop()?.replace(/\.git$/, '') ?? identifier;
      sourceUrl = identifier;
    } else {
      throw new SkillError(`不支持的安装源: ${source}`);
    }

    // 执行 npm install
    try {
      execSync(`npm install --prefix "${skillsDir}" ${identifier}`, {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 120000,
      });
    } catch (err) {
      throw new SkillError(`Skill 安装失败: ${(err as Error).message}`);
    }

    // 读取 package.json 获取 manifest
    const pkgPath = join(skillsDir, 'node_modules', pkgName, 'package.json');
    if (!existsSync(pkgPath)) {
      throw new SkillError(`Skill 安装后未找到 package.json: ${pkgPath}`);
    }

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const skillDir = join(skillsDir, 'node_modules', pkgName);

    // 构造并校验 manifest
    const manifest: SkillManifest = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description ?? '',
      entry: pkg.main ?? 'index.js',
      permissions: {
        github: pkg.skill?.permissions?.github ?? false,
        mcp: pkg.skill?.permissions?.mcp ?? false,
        network: pkg.skill?.permissions?.network ?? false,
        filesystem: pkg.skill?.permissions?.filesystem ?? false,
      },
    };

    const validation = SkillManifestSchema.safeParse(manifest);
    if (!validation.success) {
      throw new SkillError(`Skill manifest 校验失败: ${validation.error.message}`);
    }

    // 存入数据库
    const installedAt = Date.now();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO skills
       (name, version, description, entry, permissions, source, source_url, path, installed_at, loaded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    stmt.run(
      manifest.name,
      manifest.version,
      manifest.description,
      manifest.entry,
      JSON.stringify(manifest.permissions),
      source,
      sourceUrl,
      skillDir,
      installedAt,
    );

    this.logger.info(`Skill ${manifest.name}@${manifest.version} 安装成功`);
    return {
      manifest,
      source,
      sourceUrl,
      path: skillDir,
      installedAt,
      loaded: false,
    };
  }

  /** 卸载 Skill */
  async uninstall(name: string): Promise<void> {
    const row = this.db.prepare(`SELECT * FROM skills WHERE name = ?`).get(name);
    if (!row) {
      throw new SkillError(`Skill 未安装: ${name}`);
    }

    try {
      execSync(`npm uninstall --prefix "${this.installPath}" ${name}`, {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 60000,
      });
    } catch (err) {
      this.logger.warn(`npm uninstall 失败（将继续删除记录）: ${(err as Error).message}`);
    }

    this.db.prepare(`DELETE FROM skills WHERE name = ?`).run(name);
    this.logger.info(`Skill ${name} 已卸载`);
  }

  /** 列出已安装 Skill */
  listInstalled(): InstalledSkill[] {
    const rows = this.db.prepare(`SELECT * FROM skills ORDER BY installed_at DESC`).all() as Array<{
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
    }>;
    return rows.map((r) => ({
      manifest: {
        name: r.name,
        version: r.version,
        description: r.description,
        entry: r.entry,
        permissions: JSON.parse(r.permissions),
      },
      source: r.source as SkillSource,
      sourceUrl: r.source_url,
      path: r.path,
      installedAt: r.installed_at,
      loaded: r.loaded === 1,
    }));
  }

  /** 获取已安装 Skill 记录 */
  getInstalled(name: string): InstalledSkill | null {
    const rows = this.listInstalled();
    return rows.find((s) => s.manifest.name === name) ?? null;
  }

  private readLocalPackageName(localPath: string): string {
    const pkgPath = join(localPath, 'package.json');
    if (!existsSync(pkgPath)) {
      throw new SkillError(`本地 Skill 缺少 package.json: ${pkgPath}`);
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.name;
  }
}
