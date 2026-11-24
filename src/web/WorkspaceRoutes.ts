import { timingSafeEqual } from 'crypto';
import { isAbsolute } from 'path';
import { z } from 'zod';
import type { HttpServer, RequestHandler } from '../core/HttpServer';
import { GitHubError } from '../utils/errors';
import { createLocalStory, listLocalStories, readLocalStory, storyId } from '../workspace/Story';
import type { StoryRunner } from '../workspace/StoryRunner';
import { readLocalWorkspaceFile } from '../workspace/WorkspaceFile';
import { listWorkspaceDirectory } from '../workspace/WorkspaceTree';
import { listServerDirectories } from '../workspace/ServerDirectories';
import { WorkspaceHistory } from '../workspace/WorkspaceHistory';
import {
  addWorkspaceProject,
  cloneWorkspace,
  initializeWorkspace,
  inspectWorkspace,
  Workspace,
} from '../workspace/Workspace';
import type { GitHubApiClient } from './GitHubExplorer';
import {
  listGitHubWorkspaceDirectory,
  readGitHubStory,
  readGitHubWorkspace,
  readGitHubWorkspaceFile,
} from './GitHubWorkspace';

export interface WorkspaceWebAccess {
  host?: string;
  token?: string;
  defaultRoot?: string;
}

interface WorkspaceRouteServices {
  cloneGitHub?: (repository: string) => Promise<Workspace>;
  directoryRoot?: string;
  history?: WorkspaceHistory;
}

const endpoint = '/api/console/workspace';
const responseHeaders = { 'Cache-Control': 'no-store' };
const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const workspacePath = z.string().trim().min(1).max(4096).refine(isAbsolute, '工作区目录必须使用服务器上的绝对路径，请点击“选择目录”填写');
const remote = z.string().trim().min(1).max(2048);
const description = z.string().trim().min(1).max(20000);
const story = z.string().regex(storyId);
const session = z.string().refine((id) => storyId.test(id) || /^session-[0-9a-f-]{36}$/.test(id));
const runId = z.string().uuid();
const directory = z.string().max(4096).default('');
const file = z.string().min(1).max(4096);
const payload = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('server-directories'), path: z.string().trim().min(1).max(4096).optional() }),
  z.object({ operation: z.literal('recent-workspaces') }),
  z.object({ operation: z.literal('show'), path: workspacePath }),
  z.object({ operation: z.literal('workspace-tree'), path: workspacePath, directory }),
  z.object({ operation: z.literal('github-tree'), repository: remote, directory }),
  z.object({ operation: z.literal('workspace-file'), path: workspacePath, file }),
  z.object({ operation: z.literal('github-file'), repository: remote, file }),
  z.object({ operation: z.literal('init'), path: workspacePath }),
  z.object({ operation: z.literal('clone'), path: workspacePath, remote }),
  z.object({ operation: z.literal('github'), repository: remote }),
  z.object({ operation: z.literal('clone-github'), repository: remote }),
  z.object({ operation: z.literal('github-story'), repository: remote, id: story }),
  z.object({ operation: z.literal('stories'), path: workspacePath }),
  z.object({ operation: z.literal('sessions'), path: workspacePath }),
  z.object({ operation: z.literal('session'), path: workspacePath, id: session }),
  z.object({ operation: z.literal('story'), path: workspacePath, id: story }),
  z.object({
    operation: z.literal('run-story'),
    path: workspacePath,
    id: session.optional(),
    description,
  }),
  z.object({
    operation: z.literal('latest-story-run'),
    path: workspacePath,
    id: session.optional(),
    knownRunId: runId.optional(),
  }),
  z.object({ operation: z.literal('story-run'), id: runId, path: workspacePath.optional() }),
  z.object({ operation: z.literal('stop-story-run'), id: runId }),
  z.object({
    operation: z.literal('create-story'),
    path: workspacePath,
    description,
    name: z.string().trim().min(1).max(80).optional(),
  }),
  z.object({
    operation: z.literal('add'),
    path: workspacePath,
    name: z.string().trim().min(1).max(255),
    purpose: z.string().trim().min(1).max(300),
    remote: remote.optional(),
  }),
]);

function isLocalRequest(headers: Parameters<RequestHandler>[1], address?: string): boolean {
  const { host, origin } = headers;
  if (!address || !localAddresses.includes(address)) return false;
  if (headers.forwarded || Object.keys(headers).some((name) => name.startsWith('x-forwarded-')))
    return false;
  if (typeof host !== 'string' || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))
    return false;
  return origin === undefined || origin === `http://${host}`;
}

function hasToken(authorization: string | string[] | undefined, expected: Buffer): boolean {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authorization.slice(7));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function registerWorkspaceRoutes(
  server: HttpServer,
  access: WorkspaceWebAccess = {},
  github?: () => GitHubApiClient,
  storyRunner?: StoryRunner,
  services: WorkspaceRouteServices = {},
): void {
  const secret = access.token?.trim();
  const token = secret && secret.length >= 32 ? Buffer.from(secret) : undefined;
  const local = !secret && ['localhost', '127.0.0.1', '::1'].includes(access.host ?? '');
  const mode = token ? 'token' : local ? 'local' : 'disabled';
  const configuredRoot = access.defaultRoot?.trim();
  const defaultRoot = configuredRoot && isAbsolute(configuredRoot) ? configuredRoot : undefined;

  server.register('GET', endpoint, async (_body, headers, _query, address) => {
    const requestMode = mode === 'local' && !isLocalRequest(headers, address) ? 'disabled' : mode;
    return {
      status: 200,
      body: {
        mode: requestMode,
        ...(requestMode === 'local' && defaultRoot ? { defaultRoot } : {}),
      },
      headers: responseHeaders,
    };
  });

  server.register('POST', endpoint, async (body, headers, _query, address) => {
    const permitted = token
      ? hasToken(headers.authorization, token)
      : local && isLocalRequest(headers, address);
    if (!permitted) {
      return {
        status: token ? 401 : 403,
        body: { error: token ? '工作区访问令牌无效' : '当前连接无法访问工作区' },
        headers: responseHeaders,
      };
    }
    if (
      typeof headers['content-type'] !== 'string' ||
      !/^application\/json(?:\s*;|$)/i.test(headers['content-type'])
    ) {
      return {
        status: 415,
        body: { error: '请求必须使用 application/json' },
        headers: responseHeaders,
      };
    }

    let operation: z.infer<typeof payload>;
    let validationMessage = '请检查填写的工作区、仓库或 Story 信息';
    try {
      const parsed = payload.safeParse(JSON.parse(body.toString('utf8')));
      if (!parsed.success) {
        validationMessage = parsed.error.issues.find((issue) => issue.code === 'custom' && issue.path[0] === 'path')?.message || validationMessage;
        throw new Error();
      }
      operation = parsed.data;
    } catch {
      return {
        status: 400,
        body: { error: validationMessage },
        headers: responseHeaders,
      };
    }

    try {
      const result = await runOperation(operation, github, storyRunner, services);
      return {
        status: operation.operation === 'run-story' ? 202 : 200,
        body: result,
        headers: responseHeaders,
      };
    } catch (error) {
      const status = error instanceof GitHubError ? (error.status ?? 502) : 400;
      return { status, body: { error: (error as Error).message }, headers: responseHeaders };
    }
  });
}

async function runOperation(
  request: z.infer<typeof payload>,
  github?: () => GitHubApiClient,
  storyRunner?: StoryRunner,
  services: WorkspaceRouteServices = {},
) {
  switch (request.operation) {
    case 'server-directories':
      return listServerDirectories(request.path ?? services.directoryRoot ?? process.cwd());
    case 'recent-workspaces':
      return { workspaces: services.history?.list() ?? [] };
    case 'clone-github':
      if (!services.cloneGitHub) throw new Error('GitHub 克隆服务不可用');
      return rememberWorkspace(await services.cloneGitHub(request.repository), services.history);
    case 'show':
      return rememberWorkspace(await inspectWorkspace(request.path), services.history);
    case 'workspace-tree':
      return { entries: await listWorkspaceDirectory(request.path, request.directory) };
    case 'workspace-file':
      return readLocalWorkspaceFile(request.path, request.file);
    case 'init':
      return rememberWorkspace(await initializeWorkspace(request.path), services.history);
    case 'clone':
      return rememberWorkspace(await cloneWorkspace(request.remote, request.path), services.history);
    case 'github':
    case 'github-story':
    case 'github-file':
    case 'github-tree': {
      if (!github) throw new Error('GitHub 读取服务不可用');
      const client = github();
      if (request.operation === 'github-file') {
        return readGitHubWorkspaceFile(client, request.repository, request.file);
      }
      if (request.operation === 'github-tree') {
        return {
          entries: await listGitHubWorkspaceDirectory(
            client,
            request.repository,
            request.directory,
          ),
        };
      }
      return request.operation === 'github'
        ? readGitHubWorkspace(client, request.repository)
        : readGitHubStory(client, request.repository, request.id);
    }
    case 'stories': {
      const sessions = await listLocalStories(request.path);
      return {
        stories: sessions.map(({ id }) => id),
        titles: Object.fromEntries(sessions.map(({ id, title }) => [id, title])),
      };
    }
    case 'story':
      return readLocalStory(request.path, request.id);
    case 'session':
      if (!storyRunner) throw new Error('会话执行服务不可用');
      return storyRunner.session(request.path, request.id);
    case 'sessions':
      if (!storyRunner) throw new Error('Story 执行服务不可用');
      return { sessions: await storyRunner.listSessions(request.path) };
    case 'run-story':
    case 'latest-story-run':
    case 'story-run':
    case 'stop-story-run':
      if (!storyRunner) throw new Error('Story 执行服务不可用');
      if (request.operation === 'run-story')
        return storyRunner.start(request.path, request.description, request.id);
      if (request.operation === 'latest-story-run')
        return storyRunner.latest(request.path, request.id, request.knownRunId);
      if (request.operation === 'stop-story-run') return storyRunner.cancel(request.id);
      return request.path
        ? storyRunner.getForWorkspace(request.path, request.id)
        : storyRunner.get(request.id);
    case 'create-story':
      return createLocalStory(request.path, request.description, request.name);
    case 'add':
      await addWorkspaceProject(request.path, request.name, request.purpose, request.remote);
      return inspectWorkspace(request.path);
  }
}

function rememberWorkspace(workspace: Workspace, history?: WorkspaceHistory) {
  if (!history) return workspace;
  try {
    return { ...workspace, recentWorkspaces: history.remember(workspace.root) };
  } catch {
    return { ...workspace, historyWarning: '工作区已打开，但无法保存到最近列表，请检查实例数据目录和工作区记录文件' };
  }
}
