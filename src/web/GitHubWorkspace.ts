import { GitHubError } from '../utils/errors';
import { storyDocuments, storyId, storyIdForDirectory } from '../workspace/Story';
import { workspaceProjects } from '../workspace/Workspace';
import { WORKSPACE_FILE_LIMIT, workspaceFilePreview } from '../workspace/WorkspaceFile';
import {
  sortWorkspaceEntries,
  workspaceDirectoryParts,
  WorkspaceTreeEntry,
} from '../workspace/WorkspaceTree';
import type { GitHubApiClient } from './GitHubExplorer';

interface GitHubContent {
  type: string;
  name: string;
  size?: number;
  encoding?: string;
  content?: string;
}

export function normalizeGitHubRepository(value: string): string {
  const address = value
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\/$/, '')
    .replace(/\.git$/i, '');
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(address) || /\/(?:\.|\.\.)$/.test(address)) {
    throw new Error('请输入 GitHub 仓库的 owner/repo 或仓库主页地址');
  }
  return address;
}

async function mainRevision(client: GitHubApiClient, repository: string): Promise<string> {
  try {
    const branch = await client.get<{ commit: { sha: string } }>(
      `/repos/${repository}/branches/main`,
    );
    return branch.commit.sha;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) {
      throw new GitHubError(
        '无法读取 GitHub 仓库的 main 分支，请检查仓库地址、分支和 GitHub 访问权限',
        404,
      );
    }
    throw error;
  }
}

async function readContent(
  client: GitHubApiClient,
  repository: string,
  revision: string,
  path: string,
): Promise<GitHubContent | GitHubContent[] | undefined> {
  try {
    return await client.get<GitHubContent | GitHubContent[]>(
      `/repos/${repository}/contents${path ? `/${path}` : ''}`,
      { ref: revision },
    );
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined;
    throw error;
  }
}

export async function listGitHubWorkspaceDirectory(
  client: GitHubApiClient,
  value: string,
  directory: string,
): Promise<WorkspaceTreeEntry[]> {
  const repository = normalizeGitHubRepository(value);
  const revision = await mainRevision(client, repository);
  const parts = workspaceDirectoryParts(directory);
  const base = `https://github.com/${repository}`;
  if (directory === 'code') {
    const manifest = fileText(await readContent(client, repository, revision, 'repos.txt')) || '';
    return workspaceProjects(manifest).map(({ name, remote }) => {
      const github = remote?.match(
        /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/i,
      )?.[1];
      return {
        name,
        type: 'link',
        repository: true,
        ...(github ? { url: `https://github.com/${github}` } : {}),
      };
    });
  }
  const path = parts.map(encodeURIComponent).join('/');
  const entries = await readContent(client, repository, revision, path);
  if (!Array.isArray(entries)) throw new Error('GitHub 工作区目录不可读取');
  const recordId = storyIdForDirectory(parts);
  const document =
    recordId &&
    storyDocuments.find((file) =>
      entries.some((entry) => entry.type === 'file' && entry.name === file),
    );
  const result = entries.map(({ name, type }): WorkspaceTreeEntry => {
    if (type === 'dir') return { name, type: 'directory' };
    const file = [...parts, name].map(encodeURIComponent).join('/');
    return {
      name,
      type: type === 'file' ? 'file' : 'link',
      url: `${base}/blob/${revision}/${file}`,
      ...(name === document && type === 'file' ? { storyId: recordId } : {}),
    };
  });
  if (!directory && !result.some(({ name }) => name === 'code'))
    result.push({ name: 'code', type: 'directory' });
  return sortWorkspaceEntries(result);
}

function fileText(data: GitHubContent | GitHubContent[] | undefined): string | undefined {
  return !Array.isArray(data) &&
    data?.type === 'file' &&
    data.encoding === 'base64' &&
    typeof data.content === 'string'
    ? Buffer.from(data.content, 'base64').toString('utf8')
    : undefined;
}

export async function readGitHubWorkspace(client: GitHubApiClient, value: string) {
  const repository = normalizeGitHubRepository(value);
  const revision = await mainRevision(client, repository);
  const paths = ['README.md', 'AGENTS.md', 'repos.txt', 'story'];
  const [readme, agents, manifest, directory] = await Promise.all(
    paths.map((path) => readContent(client, repository, revision, path)),
  );
  const manifestText = fileText(manifest);
  if (
    fileText(readme) === undefined ||
    fileText(agents) === undefined ||
    manifestText === undefined
  ) {
    throw new Error(
      'GitHub 仓库的 main 分支需要包含 README.md、AGENTS.md 和 repos.txt 才能作为工作区打开',
    );
  }
  const stories = Array.isArray(directory)
    ? directory
        .filter((entry) => entry.type === 'dir' && storyId.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()
    : [];
  const url = `https://github.com/${repository}`;
  return {
    source: 'github' as const,
    repository,
    url,
    revision,
    branch: 'main',
    projects: workspaceProjects(manifestText),
    stories,
  };
}

export async function readGitHubStory(client: GitHubApiClient, value: string, id: string) {
  const repository = normalizeGitHubRepository(value);
  const revision = await mainRevision(client, repository);
  const directory = `story/${encodeURIComponent(id)}`;
  const files = await readContent(client, repository, revision, directory);
  const file =
    Array.isArray(files) &&
    storyDocuments.find((name) =>
      files.some((entry) => entry.type === 'file' && entry.name === name),
    );
  if (!file) throw new Error('该 Story 缺少可读取的需求说明');
  const content = fileText(
    await readContent(client, repository, revision, `${directory}/${encodeURIComponent(file)}`),
  );
  if (content === undefined) throw new Error('无法读取远端 Story 的需求说明');
  return {
    id,
    file,
    content,
    url: `https://github.com/${repository}/blob/${revision}/${directory}/${encodeURIComponent(file)}`,
  };
}

export async function readGitHubWorkspaceFile(
  client: GitHubApiClient,
  value: string,
  file: string,
) {
  const parts = workspaceDirectoryParts(file);
  if (!parts.length) throw new Error('请选择文件');
  const repository = normalizeGitHubRepository(value);
  const revision = await mainRevision(client, repository);
  const path = parts.map(encodeURIComponent).join('/');
  const data = await readContent(client, repository, revision, path);
  if (Array.isArray(data) || data?.type !== 'file') throw new Error('GitHub 文件不可读取');
  const url = `https://github.com/${repository}/blob/${revision}/${path}`;
  if (data.size !== undefined && data.size > WORKSPACE_FILE_LIMIT) {
    return { kind: 'too-large' as const, url };
  }
  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    return { kind: 'unsupported' as const, url };
  }
  return { ...workspaceFilePreview(Buffer.from(data.content, 'base64')), url };
}
