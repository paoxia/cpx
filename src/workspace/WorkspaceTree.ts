import { lstatSync, readdirSync } from 'fs';
import { join } from 'path';
import { findStoryDocument, storyIdForDirectory } from './Story';
import { inspectWorkspace } from './Workspace';

export interface WorkspaceTreeEntry {
  name: string;
  type: 'directory' | 'file' | 'link';
  repository?: boolean;
  storyId?: string;
  url?: string;
}

export function workspaceDirectoryParts(directory: string): string[] {
  if (!directory) return [];
  const parts = directory.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part === '.git' ||
        part.includes('\\') ||
        part.includes('\0'),
    )
  ) {
    throw new Error('工作区目录无效');
  }
  return parts;
}

export function sortWorkspaceEntries(entries: WorkspaceTreeEntry[]): WorkspaceTreeEntry[] {
  return entries.sort((left, right) => {
    const directoryOrder = Number(right.type === 'directory') - Number(left.type === 'directory');
    return directoryOrder || left.name.localeCompare(right.name, 'zh-CN');
  });
}

export async function listWorkspaceDirectory(
  path: string,
  directory: string,
): Promise<WorkspaceTreeEntry[]> {
  const workspace = await inspectWorkspace(path);
  let target = workspace.root;
  const parts = workspaceDirectoryParts(directory);
  for (const part of parts) {
    target = join(target, part);
    if (!lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('目录不存在，或指向工作区外的位置');
    }
  }
  const repositories = new Set(
    directory === 'code'
      ? workspace.projects.filter((project) => project.present).map((project) => project.name)
      : [],
  );
  const storyId = storyIdForDirectory(parts);
  const storyDocument = storyId ? findStoryDocument(target) : undefined;
  return sortWorkspaceEntries(
    readdirSync(target, { withFileTypes: true }).flatMap((entry): WorkspaceTreeEntry[] => {
      if (entry.name === '.git' || entry.name === '.DS_Store') return [];
      if (entry.isDirectory())
        return [{ name: entry.name, type: 'directory', repository: repositories.has(entry.name) }];
      if (entry.name === storyDocument && entry.isFile())
        return [{ name: entry.name, type: 'file', storyId }];
      if (entry.isFile() || entry.isSymbolicLink())
        return [{ name: entry.name, type: entry.isFile() ? 'file' : 'link' }];
      return [];
    }),
  );
}
