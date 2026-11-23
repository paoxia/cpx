import { execFileSync, spawn } from 'child_process';
import { once } from 'events';
import { createServer, Server } from 'http';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubWorkspaceClone } from '../../../src/web/GitHubWorkspaceClone';
import { initializeWorkspace } from '../../../src/workspace/Workspace';

const password = 'fixture-github-access-token';
let temporary: string;
let server: Server;
let cloner: GitHubWorkspaceClone;
let authorized: number;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

beforeEach(async () => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'cpx-github-clone-')));
  const source = (await initializeWorkspace(join(temporary, 'source'))).root;
  git(source, 'add', '.');
  git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
    '-c', 'commit.gpgSign=false', 'commit', '-m', 'Fixture');
  mkdirSync(join(temporary, 'octocat'));
  git(temporary, 'clone', '--bare', source, 'octocat/workspace.git');
  authorized = 0;
  server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(`x-access-token:${password}`).toString('base64')}`) {
      request.resume();
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
      response.end();
      return;
    }
    authorized++;
    const url = new URL(request.url!, 'http://localhost');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: temporary,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: request.headers['content-length'] || '',
        REMOTE_USER: 'fixture',
      },
    });
    request.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf('\r\n\r\n');
      if (split < 0) { response.writeHead(500); response.end(); return; }
      for (const header of output.subarray(0, split).toString().split('\r\n')) {
        const colon = header.indexOf(':');
        if (colon < 0) continue;
        const name = header.slice(0, colon);
        const value = header.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') response.statusCode = Number.parseInt(value, 10);
        else response.setHeader(name, value);
      }
      response.end(output.subarray(split + 4));
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', `url.http://127.0.0.1:${address.port}/.insteadOf`);
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/');
  vi.stubEnv('NO_PROXY', '127.0.0.1');
  vi.stubEnv('no_proxy', '127.0.0.1');
  cloner = new GitHubWorkspaceClone(join(temporary, 'workspaces'), () => password);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(temporary, { recursive: true, force: true });
});

describe('Clone GitHub 到本地工作区', () => {
  it('通过已连接的密码完成真实 Git HTTP 认证，返回完整本地文件与历史', async () => {
    const [workspace, duplicate] = await Promise.all([
      cloner.clone('git@github.com:octocat/workspace.git'),
      cloner.clone('https://github.com/octocat/workspace'),
    ]);
    expect(workspace).toEqual(duplicate);
    expect(workspace).toEqual({ root: join(temporary, 'workspaces/octocat/workspace'), branch: 'main', projects: [] });
    expect(git(workspace.root, 'rev-parse', 'HEAD')).toBe(git(join(temporary, 'source'), 'rev-parse', 'HEAD'));
    expect(readFileSync(join(workspace.root, 'AGENTS.md'), 'utf8')).toContain('工作区规约');
    expect(git(workspace.root, 'config', '--local', '--get', 'remote.origin.url')).toBe('https://github.com/octocat/workspace.git');
    expect(readFileSync(join(workspace.root, '.git/config'), 'utf8')).not.toContain(password);
    expect(authorized).toBeGreaterThan(0);
    writeFileSync(join(workspace.root, 'draft.md'), 'keep my changes\n');
    const count = authorized;
    expect(await cloner.clone('octocat/workspace')).toEqual(workspace);
    expect(authorized).toBe(count);
    expect(git(workspace.root, 'status', '--short')).toContain('draft.md');
  });

  it('失败时保留目标和已有文件，清理未完成的克隆并允许重试', async () => {
    const bad = new GitHubWorkspaceClone(join(temporary, 'workspaces'), () => 'wrong-token');
    await expect(bad.clone('octocat/workspace')).rejects.toThrow('克隆工作区失败');
    expect(existsSync(join(temporary, 'workspaces/octocat/workspace'))).toBe(false);
    expect(readdirSync(join(temporary, 'workspaces/octocat'))).toEqual([]);
    const workspace = await cloner.clone('octocat/workspace');
    git(workspace.root, 'remote', 'set-url', 'origin', 'https://github.com/another/workspace.git');
    writeFileSync(join(workspace.root, 'draft.md'), 'keep\n');
    await expect(cloner.clone('octocat/workspace')).rejects.toThrow('其他仓库');
    expect(readFileSync(join(workspace.root, 'draft.md'), 'utf8')).toBe('keep\n');
  });

  it('拒绝非 GitHub 地址和符号链接路径，不把凭据发送给其他服务', async () => {
    await expect(cloner.clone('https://elsewhere.example/octocat/workspace')).rejects.toThrow('GitHub');
    await expect(cloner.clone('octocat/..')).rejects.toThrow('GitHub');
    await expect(cloner.clone('https://user:secret@github.com/octocat/workspace')).rejects.toThrow('GitHub');
    expect(authorized).toBe(0);
    mkdirSync(join(temporary, 'workspaces'));
    symlinkSync(join(temporary, 'source'), join(temporary, 'workspaces/octocat'));
    await expect(cloner.clone('octocat/workspace')).rejects.toThrow('已有内容已保留');
    expect(authorized).toBe(0);
  });
});
