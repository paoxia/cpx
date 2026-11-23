import { readdir, realpath } from 'fs/promises';
import { dirname, join, parse, resolve } from 'path';

/** 浏览运行 cpx 的机器，只返回目录名称与规范化路径。调用方负责鉴权。 */
export async function listServerDirectories(path: string) {
  try {
    const current = await realpath(resolve(path));
    const entries = await readdir(current, { withFileTypes: true });
    return {
      path: current,
      parent: dirname(current) === current ? null : dirname(current),
      root: parse(current).root,
      directories: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM')
      throw new Error('没有权限读取该目录，请选择其他目录');
    if (code === 'ENOENT') throw new Error('目录不存在，请检查路径或选择其他目录');
    if (code === 'ENOTDIR') throw new Error('请选择文件夹，而不是文件');
    throw new Error('无法读取服务器目录，请检查路径和访问权限');
  }
}
