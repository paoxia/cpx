import { randomUUID } from 'crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
import { z } from 'zod';

const entry = z.object({
  path: z.string().refine(isAbsolute),
  name: z.string(),
  lastOpenedAt: z.number(),
});
const stored = z.object({ version: z.literal(1), workspaces: z.array(entry) });

/** 与实例数据共同持久化；仅保存成功打开过的本地路径，不保存访问凭据。 */
export class WorkspaceHistory {
  private readonly file: string;
  private readonly workspaceDirectory: string;

  constructor(dataDirectory: string) {
    this.file = join(dataDirectory, 'workspace-history.json');
    this.workspaceDirectory = join(dataDirectory, 'workspaces');
  }

  list() {
    const saved = this.read();
    const known = new Set(saved.map((workspace) => workspace.path));
    return [...saved, ...this.discover().filter((workspace) => !known.has(workspace.path))]
      .slice(0, 30)
      .map((workspace) => {
        let available = false;
        try {
          available = statSync(workspace.path).isDirectory();
        } catch {
          /* 保留暂时不可用的路径。 */
        }
        return { ...workspace, available };
      });
  }

  remember(path: string) {
    if (!isAbsolute(path)) throw new Error('只能保存本地工作区的绝对路径');
    const workspaces = [
      { path, name: basename(path) || path, lastOpenedAt: Date.now() },
      ...this.read().filter((workspace) => workspace.path !== path),
    ].slice(0, 30);
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
    return this.list();
  }

  private read(): Array<z.infer<typeof entry>> {
    try {
      return stored.parse(JSON.parse(readFileSync(this.file, 'utf8'))).workspaces;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('无法读取已保存的工作区记录，原文件已保留');
    }
  }

  /** 兼容历史版本已克隆到受管目录、尚未记录到历史文件的工作区。 */
  private discover(): Array<z.infer<typeof entry>> {
    const workspaces: Array<z.infer<typeof entry>> = [];
    try {
      for (const owner of readdirSync(this.workspaceDirectory, { withFileTypes: true })) {
        if (!owner.isDirectory() || owner.name.startsWith('.')) continue;
        const parent = join(this.workspaceDirectory, owner.name);
        try {
          for (const repository of readdirSync(parent, { withFileTypes: true })) {
            if (!repository.isDirectory() || repository.name.startsWith('.')) continue;
            const path = join(parent, repository.name);
            const git = lstatSync(join(path, '.git'), { throwIfNoEntry: false });
            if (!git?.isDirectory() && !git?.isFile()) continue;
            if (
              !['README.md', 'AGENTS.md', 'repos.txt'].every((name) =>
                lstatSync(join(path, name), { throwIfNoEntry: false })?.isFile(),
              )
            )
              continue;
            workspaces.push({ path, name: repository.name, lastOpenedAt: 0 });
          }
        } catch {
          /* 不可读目录不影响其他已保存工作区。 */
        }
      }
    } catch {
      /* 尚无受管工作区目录。 */
    }
    return workspaces.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));
  }
}
