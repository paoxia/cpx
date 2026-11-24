import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listServerDirectories } from '../../../src/workspace/ServerDirectories';
import { WorkspaceHistory } from '../../../src/workspace/WorkspaceHistory';

let temporary: string;
beforeEach(() => { temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cpx-directory-browser-'))); });
afterEach(() => rmSync(temporary, { recursive: true, force: true }));

it('浏览服务器文件夹并将相对路径转换为可直接使用的绝对路径', async () => {
  for (const name of ['alpha', 'beta', '.hidden']) mkdirSync(join(temporary, name));
  writeFileSync(join(temporary, 'file.txt'), 'not a directory');
  symlinkSync(join(temporary, 'alpha'), join(temporary, 'shortcut'));
  const result = await listServerDirectories(relative(process.cwd(), temporary));
  expect(result.path).toBe(temporary);
  expect(result.directories).toEqual(['alpha', 'beta'].map((name) => ({ name, path: join(temporary, name) })));
  expect((await listServerDirectories(result.directories[0].path)).parent).toBe(temporary);
  expect((await listServerDirectories(result.root)).parent).toBeNull();
});

it('不存在或指向文件的路径提供可理解的错误', async () => {
  writeFileSync(join(temporary, 'file.txt'), 'keep');
  await expect(listServerDirectories(join(temporary, 'missing'))).rejects.toThrow('目录不存在');
  await expect(listServerDirectories(join(temporary, 'file.txt'))).rejects.toThrow('请选择文件夹');
  expect(readFileSync(join(temporary, 'file.txt'), 'utf8')).toBe('keep');
});

it('重建实例后恢复本地工作区，重复打开只保留一条并标记暂不可用的目录', () => {
  const alpha = join(temporary, 'alpha');
  const beta = join(temporary, 'beta');
  mkdirSync(alpha);
  mkdirSync(beta);
  const data = join(temporary, 'data');
  const first = new WorkspaceHistory(data);
  first.remember(alpha);
  first.remember(beta);
  first.remember(alpha);
  expect(new WorkspaceHistory(data).list()).toMatchObject([
    { path: alpha, name: 'alpha', available: true },
    { path: beta, name: 'beta', available: true },
  ]);
  expect(statSync(join(data, 'workspace-history.json')).mode & 0o777).toBe(0o600);
  rmSync(beta, { recursive: true });
  expect(new WorkspaceHistory(data).list()[1]).toMatchObject({ path: beta, available: false });
  expect(readFileSync(join(data, 'workspace-history.json'), 'utf8')).not.toContain('token');
});

it('工作区记录损坏时保留原文件，不覆盖已有记录', () => {
  const file = join(temporary, 'workspace-history.json');
  writeFileSync(file, 'broken');
  const history = new WorkspaceHistory(temporary);
  expect(() => history.list()).toThrow('原文件已保留');
  expect(() => history.remember(temporary)).toThrow('原文件已保留');
  expect(readFileSync(file, 'utf8')).toBe('broken');
});

it('旧版本已克隆的受管工作区无需重新克隆即可出现在本地选项中', () => {
  const path = join(temporary, 'workspaces/octocat/existing');
  mkdirSync(join(path, '.git'), { recursive: true });
  for (const file of ['README.md', 'AGENTS.md', 'repos.txt']) writeFileSync(join(path, file), 'fixture');
  const history = new WorkspaceHistory(temporary);
  expect(history.list()).toMatchObject([{ path, name: 'existing', available: true }]);
  history.remember(path);
  expect(history.list()).toHaveLength(1);
  expect(history.list()[0].lastOpenedAt).toBeGreaterThan(0);
});
