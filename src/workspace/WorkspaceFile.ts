import { constants, lstatSync } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import { TextDecoder } from 'util';
import { inspectWorkspace } from './Workspace';
import { localWorkspaceDirectory, workspaceDirectoryParts } from './WorkspaceTree';

export const WORKSPACE_FILE_LIMIT = 1024 * 1024;

export async function readLocalWorkspaceFile(path: string, file: string) {
  const parts = workspaceDirectoryParts(file);
  const name = parts.pop();
  if (!name) throw new Error('请选择文件');
  const { root } = await inspectWorkspace(path);
  const target = join(localWorkspaceDirectory(root, parts), name);
  if (!lstatSync(target, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('只能预览工作区内的普通文件');
  }
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ELOOP' || error.code === 'ENOENT') {
      throw new Error('文件不存在，或属于符号链接');
    }
    throw error;
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('只能预览普通文件');
    if (stat.size > WORKSPACE_FILE_LIMIT) return { kind: 'too-large' as const };

    const data = Buffer.alloc(WORKSPACE_FILE_LIMIT + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return workspaceFilePreview(data.subarray(0, length));
  } finally {
    await handle.close();
  }
}

export function workspaceFilePreview(data: Buffer) {
  if (data.length > WORKSPACE_FILE_LIMIT) return { kind: 'too-large' as const };
  const imageType = workspaceImageType(data);
  if (imageType) return { kind: 'image' as const, imageType, content: data.toString('base64') };

  const prefix = data.subarray(0, 2).toString('hex');
  const encoding = prefix === 'fffe' ? 'utf-16le' : prefix === 'feff' ? 'utf-16be' : 'utf-8';
  try {
    const content = new TextDecoder(encoding, { fatal: true }).decode(data);
    if (!content.includes('\0')) return { kind: 'text' as const, content };
  } catch {
    // A file with invalid text encoding cannot be rendered as text.
  }
  return { kind: 'unsupported' as const };
}

function workspaceImageType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (data.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6))) return 'image/gif';
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}
