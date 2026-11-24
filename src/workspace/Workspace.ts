import { execFile } from 'child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { promisify } from 'util';

export interface WorkspaceProject {
  name: string;
  present: boolean;
  remote?: string;
}

export interface Workspace {
  root: string;
  branch: 'main';
  projects: WorkspaceProject[];
}

const PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PROJECT_SECTION = '<!-- cpx:projects -->';
const README = `# 工作区

## 项目职能

${PROJECT_SECTION}

## 任务归属

按项目职能定位目标，阅读根目录和目标路径适用的 AGENTS.md。默认直接处理任务，只有用户明确要求时才创建 story；已有任务沿用原 story。

## 工作区命令

- cpx workspace show 查看已登记项目和本地仓库。
- cpx workspace add 登记项目。
`;
const GUIDELINES = `# 工作区规约

- 根仓库保持在 main，使用 README.md 的项目职能与任务归属定位项目，并遵循目标路径适用的规约。
- 默认不创建 story。只有用户明确要求时，才在 story/YYYY-MM-DD-需求名 记录说明和验证结果；已有任务沿用原 story。
- 子项目在 code/ 独立管理。默认在已有 main 或 master 上工作，保留已有改动。明确要求建分支时，在已有 story 下为每个项目创建或复用 worktree；没有 story 时放在 .worktrees/YYYY-MM-DD-需求名/项目名，不为此创建 story。
- 提交、推送和创建 PR 按用户授权执行。收到「保存所有」时，依次处理子项目和 worktree 的当前分支，再保存根仓库 main。使用该工作区的 Git 身份。
- 收到明确归档指令后，将已完成任务的过程资料移到同名 archive/ 目录。确认成果已合入且现场无待保留改动后，再移除对应 worktree。
`;

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string | undefined>;
async function git(
  args: string[],
  cwd: string,
  failure: string,
  environment?: NodeJS.ProcessEnv,
): Promise<string>;
async function git(
  args: string[],
  cwd: string,
  failure?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const env: NodeJS.ProcessEnv = { ...environment, GIT_TERMINAL_PROMPT: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'AGENT_WORKSPACE_WEB_TOKEN',
  ]) {
    delete env[key];
  }
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      env,
      timeout: 120_000,
    });
    return stdout.replace(/\r?\n$/, '');
  } catch (error) {
    const { code, killed } = error as NodeJS.ErrnoException & { killed?: boolean };
    if (code === 'ENOENT') throw new Error('找不到 Git 或工作目录已不存在');
    if (killed) throw new Error('Git 操作超时');
    if (failure) throw new Error(failure);
    return undefined;
  }
}

export function workspaceGitDirectory(root: string): Promise<string> {
  return git(['rev-parse', '--absolute-git-dir'], root, '无法定位工作区 Git 目录');
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function validRemote(value: string): boolean {
  if (/[\s\\]/.test(value) || value.startsWith('-') || hasControlCharacters(value)) return false;
  if (!value.includes('://')) {
    return /^(?:[\w.-]+@)?[\w.-]+:(?!:)[^?#]+$/.test(value) && !/^[a-z]:/i.test(value);
  }
  try {
    const remote = new URL(value);
    return (
      ['https:', 'http:', 'ssh:', 'git:'].includes(remote.protocol) &&
      Boolean(remote.hostname) &&
      remote.pathname.length > 1 &&
      !remote.password &&
      (!remote.username || remote.protocol === 'ssh:') &&
      !remote.search &&
      !remote.hash
    );
  } catch {
    return false;
  }
}

function requireRemote(value: string): void {
  if (!validRemote(value)) throw new Error('请输入凭据独立配置的 SSH、HTTPS、HTTP 或 Git 克隆地址');
}

async function isRepository(path: string): Promise<boolean> {
  const marker = lstatSync(join(path, '.git'), { throwIfNoEntry: false });
  if (!marker?.isFile() && !marker?.isDirectory()) return false;
  const top = await git(['rev-parse', '--show-toplevel'], path);
  return Boolean(top && realpathSync(top) === path);
}

function workspaceFile(root: string, name: string): string {
  const file = join(root, name);
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`工作区缺少普通文件 ${name}`);
  }
  return readFileSync(file, 'utf8');
}

function readManifest(content: string): Map<string, string> {
  const projects = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const [name, url, extra] = line.trim().split(/\s+/);
    if (!PROJECT_NAME.test(name) || !url || extra || projects.has(name)) {
      throw new Error('repos.txt 中存在无效或重复的项目登记');
    }
    projects.set(name, url);
  }
  return projects;
}

export function workspaceProjects(content: string, present = new Set<string>()): WorkspaceProject[] {
  const manifest = readManifest(content);
  return [...new Set([...manifest.keys(), ...present])].sort().map((name) => {
    const url = manifest.get(name);
    return { name, present: present.has(name), remote: url && validRemote(url) ? url : undefined };
  });
}

export async function inspectWorkspace(path: string, scanProjects = true): Promise<Workspace> {
  const root = realpathSync(path);
  if (
    !(await isRepository(root)) ||
    (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root)) !== 'main'
  ) {
    throw new Error('请选择已经检出 main 的工作区 Git 根目录');
  }
  workspaceFile(root, 'README.md');
  workspaceFile(root, 'AGENTS.md');
  const manifest = workspaceFile(root, 'repos.txt');
  const code = join(root, 'code');
  const codeEntry = lstatSync(code, { throwIfNoEntry: false });
  if (codeEntry && !codeEntry.isDirectory()) throw new Error('code 必须是工作区内的普通目录');
  const present = new Set<string>();
  if (codeEntry && scanProjects) {
    for (const entry of readdirSync(code, { withFileTypes: true })) {
      if (entry.isDirectory() && (await isRepository(join(code, entry.name))))
        present.add(entry.name);
    }
  }
  return { root, branch: 'main', projects: workspaceProjects(manifest, present) };
}

async function prepareDirectory(
  path: string,
  prepare: (staging: string) => Promise<void>,
): Promise<string> {
  const absolute = resolve(path);
  const destination = join(realpathSync(dirname(absolute)), basename(absolute));
  const checkEmpty = (): boolean => {
    const entry = lstatSync(destination, { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || readdirSync(destination).length)) {
      throw new Error('目标目录必须为空，已有内容已保留');
    }
    return Boolean(entry);
  };
  checkEmpty();
  const staging = mkdtempSync(join(dirname(destination), '.cpx-workspace-'));
  try {
    await prepare(staging);
    if (checkEmpty()) {
      publishIntoEmptyDirectory(staging, destination);
    } else {
      renameSync(staging, destination);
    }
    return destination;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function publishIntoEmptyDirectory(staging: string, destination: string): void {
  const lockName = '.cpx-workspace-init.lock';
  const lock = join(destination, lockName);
  mkdirSync(lock);
  const moved: string[] = [];
  try {
    if (readdirSync(destination).some((name) => name !== lockName)) {
      throw new Error('目标目录已新增内容，请重新选择目录');
    }
    for (const name of readdirSync(staging)) {
      const target = join(destination, name);
      if (lstatSync(target, { throwIfNoEntry: false })) {
        throw new Error('目标目录已新增内容，请重新选择目录');
      }
      renameSync(join(staging, name), target);
      moved.push(name);
    }
  } catch (error) {
    for (const name of moved.reverse()) renameSync(join(destination, name), join(staging, name));
    throw error;
  } finally {
    rmdirSync(lock);
  }
}

export async function initializeWorkspace(path: string): Promise<Workspace> {
  const root = await prepareDirectory(path, async (staging) => {
    await git(['init', '--initial-branch=main'], staging, '无法初始化 main 分支');
    writeFileSync(join(staging, 'README.md'), README, { flag: 'wx' });
    writeFileSync(join(staging, 'AGENTS.md'), GUIDELINES, { flag: 'wx' });
    writeFileSync(join(staging, 'repos.txt'), '# 项目目录名 Git 克隆地址\n', { flag: 'wx' });
    writeFileSync(join(staging, '.gitignore'), '/code/\n/story/*/*/\n/.worktrees/\n.DS_Store\n', { flag: 'wx' });
    mkdirSync(join(staging, 'code'));
    for (const directory of ['story', 'archive']) {
      mkdirSync(join(staging, directory));
      writeFileSync(join(staging, directory, '.gitkeep'), '');
    }
    await inspectWorkspace(staging);
  });
  return inspectWorkspace(root);
}

export async function cloneWorkspace(
  remote: string,
  path: string,
  environment?: NodeJS.ProcessEnv,
): Promise<Workspace> {
  requireRemote(remote);
  const root = await prepareDirectory(path, async (staging) => {
    await git(
      ['clone', '--branch', 'main', '--', remote, '.'],
      staging,
      '克隆工作区失败，请检查地址、凭据和 main 分支',
      environment,
    );
    await inspectWorkspace(staging);
  });
  return inspectWorkspace(root);
}

function appendLine(content: string, line: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = content && !content.endsWith('\n') ? newline : '';
  return `${content}${separator}${line}${newline}`;
}

function projectReadme(readme: string, name: string, purpose: string): string {
  const link = `./code/${name}`;
  if (readme.includes(`](${link}/`) || readme.includes(`](${link})`)) return readme;
  const description = purpose.replace(/[\\`*_[\]<>!&]/g, '\\$&');
  const item = `- [${name}](${link}/) · ${description}`;
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  if (readme.includes(PROJECT_SECTION)) {
    return readme.replace(PROJECT_SECTION, () => `${PROJECT_SECTION}${newline}${item}`);
  }
  const heading = '## cpx 登记项目';
  return appendLine(
    readme,
    readme.includes(heading) ? item : `${newline}${heading}${newline}${newline}${item}`,
  );
}

function updateWorkspaceFile(root: string, name: string, before: string, after: string): void {
  if (before === after) return;
  const path = join(root, name);
  const staging = mkdtempSync(join(root, '.cpx-workspace-'));
  try {
    const file = join(staging, name);
    const mode = lstatSync(path).mode & 0o777;
    writeFileSync(file, after, { mode });
    if (workspaceFile(root, name) !== before) throw new Error(`${name} 已被修改，请重试`);
    renameSync(file, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 克隆已向用户展示并确认的清单项目，不改工作区登记和远端。 */
export async function cloneRegisteredWorkspaceProject(
  path: string, name: string, expectedRemote: string, httpsRemote: string, environment: NodeJS.ProcessEnv,
): Promise<void> {
  const { root } = await inspectWorkspace(path, false);
  const manifest = readManifest(workspaceFile(root, 'repos.txt'));
  if (manifest.get(name) !== expectedRemote || !PROJECT_NAME.test(name) || name.endsWith('.')) {
    throw new Error('项目清单已变化，请重新确认。');
  }
  const code = join(root, 'code');
  const destination = join(code, name);
  const current = lstatSync(destination, { throwIfNoEntry: false });
  if (current?.isDirectory() && await isRepository(destination)) return;
  if (current) throw new Error('已有同名目录，请在工作区检查。');
  mkdirSync(code, { recursive: true });
  await prepareDirectory(destination, async (staging) => {
    await git(['clone', '--', httpsRemote, '.'], staging, '克隆失败，请检查网络和仓库授权。', environment);
  });
}

export async function addWorkspaceProject(
  path: string,
  name: string,
  purpose: string,
  remote?: string,
): Promise<WorkspaceProject> {
  if (!PROJECT_NAME.test(name) || name.endsWith('.'))
    throw new Error('项目目录名只能使用字母、数字、点、连字符和下划线，并以字母或数字开头');
  if (!purpose.trim() || hasControlCharacters(purpose)) throw new Error('请输入一行项目职能');
  if (remote !== undefined) requireRemote(remote);
  const { root } = await inspectWorkspace(path);
  const gitDirectory = await workspaceGitDirectory(root);
  const lock = join(gitDirectory, 'cpx-workspace-add.lock');
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('工作区项目登记已锁定，请检查是否有操作正在进行');
    throw error;
  }
  try {
    const readme = workspaceFile(root, 'README.md');
    const manifestContent = workspaceFile(root, 'repos.txt');
    const manifest = readManifest(manifestContent);
    const registered = manifest.get(name);
    const code = join(root, 'code');
    const target = join(code, name);
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry && (!entry.isDirectory() || !(await isRepository(target)))) {
      throw new Error('同名路径已存在且不是独立 Git 仓库，已有内容已保留');
    }
    const origin = entry
      ? await git(['config', '--local', '--get', 'remote.origin.url'], target)
      : undefined;
    const nextRemote = remote ?? registered ?? (origin && validRemote(origin) ? origin : undefined);
    if (
      (registered && remote && registered !== remote) ||
      (entry && nextRemote && nextRemote !== origin)
    ) {
      throw new Error('已登记的地址或本地仓库 origin 与所选地址不同');
    }
    if (!entry) {
      if (!nextRemote) throw new Error('请提供克隆地址，或将已有本地 Git 仓库放到 code 下');
      requireRemote(nextRemote);
      mkdirSync(code, { recursive: true });
      await prepareDirectory(target, async (staging) => {
        await git(['clone', '--', nextRemote, '.'], staging, '克隆项目失败，请检查地址和凭据');
      });
    }
    updateWorkspaceFile(root, 'README.md', readme, projectReadme(readme, name, purpose.trim()));
    if (nextRemote && !registered) {
      updateWorkspaceFile(
        root,
        'repos.txt',
        manifestContent,
        appendLine(manifestContent, `${name} ${nextRemote}`),
      );
    }
    return {
      name,
      present: true,
      remote: nextRemote && validRemote(nextRemote) ? nextRemote : undefined,
    };
  } finally {
    rmdirSync(lock);
  }
}
