import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { inspectWorkspace } from './Workspace';

const validName = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u;
export const storyId = /^\d{4}-\d{2}-\d{2}-[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u;
export const storyDocuments = ['说明.md', 'README.md', '需求与验证.md'];

export function storyIdForDirectory(parts: string[]): string | undefined {
  if (parts.length === 2 && parts[0] === 'story' && storyId.test(parts[1])) return parts[1];
  return undefined;
}

function storyDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) throw new Error(`工作区中的 ${name} 必须是普通目录`);
  return directory;
}

export async function listLocalStories(
  path: string,
): Promise<Array<{ id: string; title?: string }>> {
  const { root } = await inspectWorkspace(path);
  return localStorySummaries(root);
}

export function localStorySummaries(
  root: string,
  sessionIds?: string[],
): Array<{ id: string; title?: string }> {
  const parent = storyDirectory(root, 'story');
  if (!lstatSync(parent, { throwIfNoEntry: false })) return [];
  const ids = sessionIds ?? readdirSync(parent).sort().reverse();
  return ids.flatMap((id) => {
    if (!storyId.test(id)) return [];
    const directory = join(parent, id);
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
    const document = findStoryDocument(directory);
    const title =
      document && readFileSync(join(directory, document), 'utf8').match(/^#\s+(.+)$/m)?.[1];
    return [{ id, title }];
  });
}

export async function readLocalStory(path: string, id: string) {
  if (!storyId.test(id)) throw new Error('Story 目录名无效');
  const { root } = await inspectWorkspace(path);
  const parent = storyDirectory(root, 'story');
  const directory = storyDirectory(parent, id);
  if (!lstatSync(directory, { throwIfNoEntry: false })) throw new Error('Story 目录不存在');
  const file = findStoryDocument(directory);
  return {
    id,
    directory,
    file: file ?? storyDocuments[0],
    content: file ? readFileSync(join(directory, file), 'utf8') : '',
  };
}

export function findStoryDocument(directory: string): string | undefined {
  return storyDocuments.find((name) =>
    lstatSync(join(directory, name), { throwIfNoEntry: false })?.isFile(),
  );
}

export async function createLocalStory(
  path: string,
  description: string,
  requestedName?: string,
  now = new Date(),
  requestedTitle?: string,
) {
  const title =
    (requestedTitle ?? description)
      .split(/\r?\n/, 1)[0]
      .replace(/^#+\s*/, '')
      .trim() || '新需求';
  const defaultName = [...title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')]
    .slice(0, 36)
    .join('')
    .replace(/^-|-$/g, '');
  const name = requestedName ?? (defaultName || '新需求');
  if (!validName.test(name) || name.endsWith('.'))
    throw new Error('请使用字母、数字、中文、点、连字符或下划线作为需求名');
  const { root } = await inspectWorkspace(path);
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  const id = `${date}-${name}`;
  const parent = storyDirectory(root, 'story');
  mkdirSync(parent, { recursive: true });
  const directory = join(parent, id);
  try {
    mkdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Story ${id} 已存在，可从列表继续`);
    }
    throw error;
  }
  const file = storyDocuments[0];
  const content = `# ${title}\n\n## 需求\n\n${description}\n`;
  try {
    writeFileSync(join(directory, file), content, { flag: 'wx' });
  } catch (error) {
    if (readdirSync(directory).length === 0) rmdirSync(directory);
    throw error;
  }
  return { id, directory, file, content };
}
