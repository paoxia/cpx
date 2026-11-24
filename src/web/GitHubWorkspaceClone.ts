import { execFile } from 'child_process';
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { withGitHubGitCredentials } from '../github/GitHubGitCredentials';
import { cloneWorkspace, inspectWorkspace, Workspace } from '../workspace/Workspace';
import { normalizeGitHubRepository } from './GitHubWorkspace';

const execFileAsync = promisify(execFile);

/** GitHub 接入得到服务端的本地工作区；重复选择复用目录，不拉取或覆盖改动。 */
export class GitHubWorkspaceClone {
  private readonly pending = new Map<string, Promise<Workspace>>();

  constructor(
    private readonly directory: string,
    private readonly githubToken: () => string | undefined,
  ) {}

  async clone(value: string): Promise<Workspace> {
    const repository = normalizeGitHubRepository(value);
    const key = repository.toLowerCase();
    const active = this.pending.get(key);
    if (active) return active;
    const operation = this.prepare(repository, key);
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }

  private async prepare(repository: string, key: string): Promise<Workspace> {
    mkdirSync(this.directory, { recursive: true });
    const [owner, name] = key.split('/');
    const parent = join(realpathSync(this.directory), owner);
    const parentEntry = lstatSync(parent, { throwIfNoEntry: false });
    if (parentEntry && !parentEntry.isDirectory())
      throw new Error('工作区同名路径已存在，已有内容已保留');
    mkdirSync(parent, { recursive: true });
    const destination = join(parent, name);
    const entry = lstatSync(destination, { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || readdirSync(destination).length > 0)) {
      if (!entry.isDirectory()) throw new Error('工作区同名路径已存在，已有内容已保留');
      const workspace = await inspectWorkspace(destination);
      const { stdout } = await execFileAsync(
        'git',
        ['config', '--local', '--get', 'remote.origin.url'],
        { cwd: destination, encoding: 'utf8', timeout: 10_000 },
      ).catch(() => ({ stdout: '' }));
      let origin: string | undefined;
      try {
        origin = normalizeGitHubRepository(stdout.trim()).toLowerCase();
      } catch {
        /* 同名路径未绑定选中的 GitHub 仓库，保留现场。 */
      }
      if (origin !== key) throw new Error('目标目录已存在且属于其他仓库，已有内容已保留');
      return workspace;
    }
    return withGitHubGitCredentials(this.githubToken(), (environment) =>
      cloneWorkspace(`https://github.com/${repository}.git`, resolve(destination), environment),
    );
  }
}
