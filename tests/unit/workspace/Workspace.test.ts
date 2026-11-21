import { execFileSync } from 'child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addWorkspaceProject,
  cloneWorkspace,
  initializeWorkspace,
  inspectWorkspace,
} from '../../../src/workspace/Workspace';

let temporary: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFixture(root: string): void {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'Fixture',
  );
}

beforeEach(() => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cpx-workspace-test-')));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temporary, { recursive: true, force: true });
});

describe('digital-avatar 工作区', () => {
  it('在空目录初始化本地模板，并可只读重新打开', async () => {
    const root = join(temporary, 'local');
    mkdirSync(root);
    const originalDirectory = statSync(root).ino;
    await expect(initializeWorkspace(root)).resolves.toEqual({
      root,
      branch: 'main',
      projects: [],
    });
    expect(statSync(root).ino).toBe(originalDirectory);
    expect((await inspectWorkspace(root)).projects).toEqual([]);
    expect(git(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(
      git(root, 'check-ignore', 'code/example/README.md', 'story/task/example/README.md'),
    ).toContain('code/example');
    expect(readFileSync(join(root, 'repos.txt'), 'utf8')).toBe('# 项目目录名 Git 克隆地址\n');
    const status = git(root, 'status', '--short');
    await expect(initializeWorkspace(root)).rejects.toThrow('目标目录必须为空');
    expect(git(root, 'status', '--short')).toBe(status);
  });

  it('在 origin 缺失时登记已有本地项目，并保留用户导航和子仓库改动', async () => {
    const { root } = await initializeWorkspace(join(temporary, 'local'));
    const project = join(root, 'code', 'notes');
    mkdirSync(project);
    git(project, 'init', '--initial-branch=master');
    writeFileSync(join(project, 'local.md'), 'uncommitted\n');
    const readme = join(root, 'README.md');
    appendFileSync(readme, '\n## 我的说明\n\n已有资料\n');
    const result = await addWorkspaceProject(root, 'notes', '项目笔记');
    expect(result).toEqual({ name: 'notes', present: true });
    const after = readFileSync(readme, 'utf8');
    expect(after).toContain('[notes](./code/notes/) · 项目笔记');
    expect(after).toContain('已有资料');
    await addWorkspaceProject(root, 'notes', '项目笔记');
    expect(readFileSync(readme, 'utf8')).toBe(after);
    expect(readFileSync(join(root, 'repos.txt'), 'utf8')).toBe('# 项目目录名 Git 克隆地址\n');
    expect(git(project, 'status', '--short')).toBe('?? local.md');
  });

  it('通过非 GitHub 克隆地址接入根仓库和项目，保留独立历史', async () => {
    // 通过 Git 的 URL 映射使用本地 fixture，覆盖通用远端流程而无需联网。
    const prefix = 'https://git.example.test/';
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(`${temporary}/`).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', prefix);
    const base = await initializeWorkspace(join(temporary, 'source'));
    git(base.root, 'config', 'user.name', 'Workspace Owner');
    commitFixture(base.root);
    const sourceProject = join(temporary, 'project');
    mkdirSync(sourceProject);
    git(sourceProject, 'init', '--initial-branch=master');
    writeFileSync(join(sourceProject, 'hello.md'), 'original\n');
    commitFixture(sourceProject);

    const copy = await cloneWorkspace(`${prefix}source`, join(temporary, 'copy'));
    expect(git(copy.root, 'rev-parse', 'HEAD')).toBe(git(base.root, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(copy.root, 'AGENTS.md'), 'utf8')).toBe(
      readFileSync(join(base.root, 'AGENTS.md'), 'utf8'),
    );
    const remote = `${prefix}project`;
    await addWorkspaceProject(copy.root, 'alpha', '示例项目', remote);
    expect((await inspectWorkspace(copy.root)).projects).toEqual([
      { name: 'alpha', present: true, remote },
    ]);
    const clonedProject = join(copy.root, 'code', 'alpha');
    expect(git(clonedProject, 'branch', '--show-current')).toBe('master');
    expect(git(clonedProject, 'rev-parse', 'HEAD')).toBe(git(sourceProject, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(copy.root, 'repos.txt'), 'utf8')).toContain(`alpha ${remote}\n`);
    await expect(
      addWorkspaceProject(copy.root, 'alpha', '示例项目', `${prefix}other`),
    ).rejects.toThrow('地址不同');
    await expect(
      addWorkspaceProject(copy.root, 'missing', '示例项目', `${prefix}missing`),
    ).rejects.toThrow('克隆项目失败');
    expect(readdirSync(join(copy.root, 'code'))).toEqual(['alpha']);
  });

  it('拒绝覆盖已有路径和在项目清单登记包含凭据的地址', async () => {
    const { root } = await initializeWorkspace(join(temporary, 'local'));
    const conflict = join(root, 'code', 'notes');
    mkdirSync(conflict);
    writeFileSync(join(conflict, 'draft.md'), 'keep\n');
    const original = readFileSync(join(root, 'README.md'), 'utf8');
    await expect(
      addWorkspaceProject(root, 'notes', '项目笔记', 'git@gitee.com:owner/notes.git'),
    ).rejects.toThrow('同名路径');
    await expect(
      addWorkspaceProject(root, 'other', '其他项目', 'https://user:token@git.example.test/other'),
    ).rejects.toThrow('凭据独立配置');
    expect(readFileSync(join(conflict, 'draft.md'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(original);
    expect((await inspectWorkspace(root)).projects).toEqual([]);
  });
});
