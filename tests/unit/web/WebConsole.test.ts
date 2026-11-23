import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'url';
import { initializeWorkspace } from '../../../src/workspace/Workspace';
import { WorkspaceHistory } from '../../../src/workspace/WorkspaceHistory';
import type { RequestHandler } from '../../../src/core/HttpServer';
import { WebConsole } from '../../../src/web/WebConsole';
import { registerWorkspaceRoutes } from '../../../src/web/WorkspaceRoutes';
import { Logger } from '../../../src/utils/Logger';
import { WORKSPACE_FILE_LIMIT } from '../../../src/workspace/WorkspaceFile';
import { GitHubError } from '../../../src/utils/errors';
import type { GitHubApiClient } from '../../../src/web/GitHubExplorer';
import type { AgentAuthService } from '../../../src/web/AgentAuthManager';
import { CodexConfigManager } from '../../../src/web/CodexConfigManager';
import type {
  ModelConfigurationTestRunner,
  ModelTestConfiguration,
} from '../../../src/web/ModelConfigurationTester';

const TMP_DIR = join(process.cwd(), 'tmp-test-web-console');

class FakeHttpServer {
  readonly routes = new Map<string, RequestHandler>();

  register(method: string, path: string, handler: RequestHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
  }

  handler(method: string, path: string): RequestHandler {
    const handler = this.routes.get(`${method.toUpperCase()} ${path}`);
    if (!handler) throw new Error(`missing route: ${method} ${path}`);
    return handler;
  }
}

describe('WebConsole', () => {
  let server: FakeHttpServer;
  let webConsole: WebConsole;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await webConsole.stop();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('应注册控制台静态资源并设置安全响应头', async () => {
    const response = await server.handler('GET', '/')(Buffer.alloc(0), {}, {});
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    expect(response.headers).toMatchObject({
      'Content-Security-Policy': expect.stringContaining("default-src 'self'"),
      'X-Content-Type-Options': 'nosniff',
    });
    const html = (response.body as Buffer).toString('utf8');
    expect(html).toContain('id="github-tab"');
    expect(html).toContain('id="workspace-tab"');
    expect(html).toContain('id="workspace-project-form"');
    expect(html).toContain('<option value="clone-github">GitHub</option>');
    expect(html).toContain('id="workspace-browse"');
    expect(html).toContain('id="directory-picker"');
    expect(html).toContain('id="workspace-recent"');
    expect(html).not.toContain('<option value="clone">');
    expect(html).not.toContain('读取 GitHub 工作区');
    expect(html).not.toContain('id="workspace-remote"');
    expect(html).toContain('id="stories-view">');
    expect(html).toContain('id="session-search"');
    expect(html).toContain('id="story-description"');
    expect(html).not.toContain('id="tasks-view"');
    expect(html).not.toContain('repository-tasks');
    expect(html).toContain('id="integrations-tab"');
    expect(html).toContain('id="codex-tab"');
    expect(html).toContain('WebSocket 长连接');
    expect(html).toContain('Agent 设置');
    expect(html).not.toContain('Claude Code');
    expect(html).toContain('Codex 配置方案');
    expect(html).toContain('id="github-create-token"');
    expect(html).not.toContain('id="create-pr"');
    expect(html).not.toContain('完成后创建 Pull Request');
    expect(html).toContain('contents=write');
    expect(html).toContain('pull_requests=write');
    expect(html).toContain('id="codex-auth-status"');

    const scriptResponse = await server.handler('GET', '/app.js')(Buffer.alloc(0), {}, {});
    const script = (scriptResponse.body as Buffer).toString('utf8');
    expect(script).toContain('/api/console/integrations');
    expect(script).toContain('/api/console/codex-config');
    expect(script).toContain('/api/console/agent-auth/api-key');
    expect(script).toContain('/api/console/codex-models');
    expect(script).not.toContain('/webhook/');

    const stylesResponse = await server.handler('GET', '/styles.css')(Buffer.alloc(0), {}, {});
    const styles = (stylesResponse.body as Buffer).toString('utf8');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(styles).toContain('.session-body');
    expect(styles).toContain('.session-dock');
  });

  it('工作区 API 应拒绝默认外部访问，并通过回环连接创建和登记本地项目', async () => {
    const endpoint = '/api/console/workspace';
    const path = join(realpathSync(TMP_DIR), 'local-workspace');
    const input = Buffer.from(JSON.stringify({ operation: 'init', path }));
    const headers = {
      host: '127.0.0.1:4000',
      origin: 'http://127.0.0.1:4000',
      'content-type': 'application/json',
    };
    expect((await server.handler('GET', endpoint)(Buffer.alloc(0), headers, {}, '127.0.0.1')).body).toEqual({ mode: 'disabled' });
    expect((await server.handler('POST', endpoint)(input, headers, {}, '127.0.0.1')).status).toBe(403);

    registerWorkspaceRoutes(server as unknown as import('../../../src/core/HttpServer').HttpServer, {
      host: '127.0.0.1',
      defaultRoot: path,
    });
    const mode = server.handler('GET', endpoint);
    expect((await mode(Buffer.alloc(0), headers, {}, '127.0.0.1')).body).toEqual({ mode: 'local', defaultRoot: path });
    expect((await mode(Buffer.alloc(0), headers, {}, '192.0.2.1')).body).toEqual({ mode: 'disabled' });
    const submit = server.handler('POST', endpoint);
    expect((await submit(input, headers, {}, '192.0.2.1')).status).toBe(403);
    expect((await submit(input, { ...headers, origin: 'http://other.example' }, {}, '127.0.0.1')).status).toBe(403);
    expect((await submit(input, { ...headers, 'x-forwarded-for': '192.0.2.1' }, {}, '127.0.0.1')).status).toBe(403);
    expect((await submit(input, { ...headers, 'content-type': 'text/plain' }, {}, '127.0.0.1')).status).toBe(415);
    expect(existsSync(path)).toBe(false);
    expect((await submit(input, headers, {}, '127.0.0.1')).body).toMatchObject({ root: path, branch: 'main', projects: [] });

    const project = join(path, 'code', 'notes');
    mkdirSync(project);
    execFileSync('git', ['init', '-q'], { cwd: project });
    const add = Buffer.from(JSON.stringify({ operation: 'add', path, name: 'notes', purpose: '知识笔记' }));
    expect((await submit(add, headers, {}, '127.0.0.1')).body).toMatchObject({ projects: [{ name: 'notes', present: true }] });
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toContain('知识笔记');
  });

  it('远程工作区 API 应验证独立令牌和服务器绝对路径', async () => {
    const endpoint = '/api/console/workspace';
    const token = 'workspace-test-access-token-0123456789';
    registerWorkspaceRoutes(server as unknown as import('../../../src/core/HttpServer').HttpServer, { host: '0.0.0.0', token });
    const headers = { 'content-type': 'application/json', host: 'cpx.example' };
    const submit = server.handler('POST', endpoint);
    const mode = await server.handler('GET', endpoint)(Buffer.alloc(0), headers, {}, '192.0.2.1');
    expect(mode.body).toEqual({ mode: 'token' });
    const path = join(realpathSync(TMP_DIR), 'remote-access');
    const input = Buffer.from(JSON.stringify({ operation: 'init', path }));
    expect((await submit(input, { ...headers, authorization: 'Bearer wrong' }, {}, '192.0.2.1')).status).toBe(401);
    const authorized = { ...headers, authorization: `Bearer ${token}` };
    expect(await submit(Buffer.from('{"operation":"init","path":"relative"}'), authorized, {}, '192.0.2.1')).toMatchObject({ status: 400, body: { error: expect.stringContaining('绝对路径') } });
    expect((await submit(input, authorized, {}, '192.0.2.1')).body).toMatchObject({ root: path, branch: 'main' });
    const show = Buffer.from(JSON.stringify({ operation: 'show', path }));
    expect((await submit(show, authorized, {}, '192.0.2.1')).status).toBe(200);
  });

  it('使用 cpx 已配置的 GitHub 凭据读取远端工作区和 Story', async () => {
    await webConsole.stop();
    const revision = 'a'.repeat(40);
    const id = '2026-11-21-example';
    const requests: string[] = [];
    const file = (content: string) => ({ type: 'file', encoding: 'base64', content: Buffer.from(content).toString('base64') });
    const contents: Record<string, unknown> = {
      'README.md': file('# 工作区'),
      'AGENTS.md': file('# 规约'),
      'repos.txt': file('notes git@github.com:octocat/notes.git\n'),
      story: [{ type: 'dir', name: id }, { type: 'file', name: '.gitkeep' }],
      [`story/${id}`]: [{ type: 'file', name: '说明.md' }],
      [`story/${id}/${encodeURIComponent('说明.md')}`]: file('# 示例需求'),
    };
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        workspaceAccess: { host: '127.0.0.1' },
        githubToken: 'github-configured-token',
        githubClientFactory: (token) => {
          expect(token).toBe('github-configured-token');
          return {
            get: async <T>(url: string, params?: Record<string, unknown>) => {
              requests.push(url);
              if (url === '/repos/octocat/desktop/branches/main') return { commit: { sha: revision } } as T;
              const path = url.replace('/repos/octocat/desktop/contents/', '');
              expect(params?.ref).toBe(revision);
              if (!(path in contents)) throw new GitHubError('Not Found', 404);
              return contents[path] as T;
            },
          };
        },
      },
    );
    const submit = (operation: string, extra = {}) => server.handler('POST', '/api/console/workspace')(
      Buffer.from(JSON.stringify({ operation, repository: 'https://github.com/octocat/desktop.git', ...extra })),
      { host: 'localhost:3000', 'content-type': 'application/json' }, {}, '127.0.0.1',
    );
    expect(await submit('github')).toMatchObject({ status: 200, body: {
      source: 'github', repository: 'octocat/desktop', branch: 'main', revision, stories: [id],
      projects: [{ name: 'notes', present: false, remote: 'git@github.com:octocat/notes.git' }],
    } });
    expect(await submit('github-story', { id })).toMatchObject({ status: 200, body: { id, content: '# 示例需求' } });
    expect(await submit('github-tree', { directory: `story/${id}` })).toMatchObject({
      status: 200, body: { entries: [{ type: 'file', name: '说明.md', storyId: id }] },
    });
    expect(await submit('github-file', { file: `story/${id}/说明.md` })).toMatchObject({
      status: 200, body: {
        kind: 'text', content: '# 示例需求',
        url: `https://github.com/octocat/desktop/blob/${revision}/story/${id}/${encodeURIComponent('说明.md')}`,
      },
    });
    const count = requests.length;
    expect(await submit('github', { repository: 'https://elsewhere.example/octocat/desktop' })).toMatchObject({ status: 400 });
    expect(requests).toHaveLength(count);
    delete contents['AGENTS.md'];
    expect(await submit('github')).toMatchObject({ status: 400, body: { error: expect.stringContaining('AGENTS.md') } });
  });

  it('服务器目录与已保存工作区仅向持有正确令牌的客户端开放', async () => {
    const token = 'workspace-browser-access-token-0123456789';
    const parent = join(realpathSync(TMP_DIR), 'directories');
    const workspace = (await initializeWorkspace(join(realpathSync(TMP_DIR), 'saved-workspace'))).root;
    mkdirSync(parent);
    mkdirSync(join(parent, 'folder'));
    const history = new WorkspaceHistory(TMP_DIR);
    registerWorkspaceRoutes(server as unknown as import('../../../src/core/HttpServer').HttpServer,
      { host: '0.0.0.0', token }, undefined, undefined, { directoryRoot: parent, history });
    const submit = (body: object, access?: string) => server.handler('POST', '/api/console/workspace')(
      Buffer.from(JSON.stringify(body)),
      { 'content-type': 'application/json', ...(access ? { authorization: `Bearer ${access}` } : {}) },
      {}, '192.0.2.1');
    for (const operation of ['server-directories', 'recent-workspaces']) {
      expect((await submit({ operation })).status).toBe(401);
      expect((await submit({ operation }, 'wrong')).status).toBe(401);
    }
    expect(await submit({ operation: 'server-directories' }, token)).toMatchObject({ status: 200, body: {
      path: parent, directories: [{ name: 'folder', path: join(parent, 'folder') }],
    } });
    expect(await submit({ operation: 'recent-workspaces' }, token)).toMatchObject({ status: 200, body: { workspaces: [] } });
    expect(await submit({ operation: 'show', path: workspace }, token)).toMatchObject({ status: 200, body: {
      root: workspace, recentWorkspaces: [{ path: workspace, available: true }],
    } });
    expect(await submit({ operation: 'recent-workspaces' }, token)).toMatchObject({ status: 200, body: { workspaces: [{ path: workspace }] } });
    expect(await submit({ operation: 'show', path: '/not/a/workspace' }, token)).toMatchObject({ status: 400 });
    expect(history.list()).toHaveLength(1);
  });

  it('Clone GitHub 接口直接返回可创建会话的持久化本地工作区', async () => {
    const source = (await initializeWorkspace(join(realpathSync(TMP_DIR), 'fixture'))).root;
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
      '-c', 'commit.gpgSign=false', 'commit', '-m', 'Fixture'], { cwd: source });
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(source).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/octocat/workspace.git');
    const endpoint = '/api/console/workspace';
    const input = Buffer.from(JSON.stringify({ operation: 'clone-github', repository: 'octocat/workspace' }));
    const headers = { host: '127.0.0.1:3000', 'content-type': 'application/json' };
    const destination = join(realpathSync(TMP_DIR), 'workspaces/octocat/workspace');
    expect((await server.handler('POST', endpoint)(input, headers, {}, '127.0.0.1')).status).toBe(403);
    expect(existsSync(destination)).toBe(false);
    await webConsole.stop();
    webConsole = new WebConsole(server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'), new Logger('error'), { workspaceAccess: { host: '127.0.0.1' } });
    const submit = (body: object) => server.handler('POST', endpoint)(Buffer.from(JSON.stringify(body)), headers, {}, '127.0.0.1');
    expect(await submit({ operation: 'clone-github', repository: 'octocat/workspace' })).toMatchObject({
      status: 200, body: { root: destination, branch: 'main', projects: [] },
    });
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toContain('工作区');
    expect(await submit({ operation: 'create-story', path: destination, description: '在本地工作区继续开发', name: 'local-clone' })).toMatchObject({ status: 200 });
    expect(await submit({ operation: 'sessions', path: destination })).toMatchObject({ status: 200, body: { sessions: [] } });
    expect(await submit({ operation: 'clone-github', repository: 'octocat/workspace' })).toMatchObject({ status: 200, body: { root: destination } });
    await webConsole.stop();
    webConsole = new WebConsole(server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'), new Logger('error'), { workspaceAccess: { host: '127.0.0.1' } });
    expect(await submit({ operation: 'recent-workspaces' })).toMatchObject({ status: 200, body: {
      workspaces: [{ path: destination, name: 'workspace', available: true }],
    } });
  });

  it('在独立目录创建和读取 Story，无需选择项目', async () => {
    await webConsole.stop();
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      { workspaceAccess: { host: '127.0.0.1' } },
    );
    const path = join(realpathSync(TMP_DIR), 'story-workspace');
    const send = (operation: string, extra = {}) => server.handler('POST', '/api/console/workspace')(
      Buffer.from(JSON.stringify({ operation, path, ...extra })),
      { host: 'localhost:3000', 'content-type': 'application/json' }, {}, '127.0.0.1',
    );
    expect((await send('init')).status).toBe(200);
    const created = await send('create-story', { description: '更新本地流程\n需要补充说明' });
    const { id, directory } = created.body as { id: string; directory: string };
    expect(created.status).toBe(200);
    expect(directory).toBe(join(path, 'story', id));
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-更新本地流程$/);
    expect(await send('stories')).toMatchObject({ status: 200, body: { stories: [id] } });
    expect(await send('sessions')).toMatchObject({ status: 200, body: { sessions: [] } });
    expect((await send('append-story', { id, description: '第二轮要求' })).status).toBe(400);
    expect(await send('story', { id })).toMatchObject({ status: 200, body: { directory, content: expect.stringContaining('需要补充说明') } });
    expect((await send('story', { id: '../README.md' })).status).toBe(400);
    expect((await send('create-story', { description: '更新本地流程' })).status).toBe(400);
    expect(execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim()).toBe('main');
  });

  it('预览工作区内的文本与图片，并拒绝越界或不支持的文件', async () => {
    const root = join(realpathSync(TMP_DIR), 'file-preview-workspace');
    registerWorkspaceRoutes(server as unknown as import('../../../src/core/HttpServer').HttpServer, { host: '127.0.0.1' });
    const submit = server.handler('POST', '/api/console/workspace');
    const send = (payload: object) => submit(
      Buffer.from(JSON.stringify({ ...payload, path: root })),
      { host: 'localhost:3000', 'content-type': 'application/json' }, {}, '127.0.0.1',
    );
    const preview = (file: string) => send({ operation: 'workspace-file', file });
    expect((await send({ operation: 'init' })).status).toBe(200);
    const text = '文件预览\n<script>Text remains literal</script>';
    writeFileSync(join(root, 'code', '示例.txt'), text);
    expect(await preview('code/示例.txt')).toMatchObject({ status: 200, body: { kind: 'text', content: text } });
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZkUAAAAASUVORK5CYII=';
    writeFileSync(join(root, 'picture.png'), Buffer.from(image, 'base64'));
    expect(await preview('picture.png')).toMatchObject({
      status: 200, body: { kind: 'image', imageType: 'image/png', content: image },
    });
    writeFileSync(join(root, 'example.bin'), Buffer.from([0, 255]));
    expect(await preview('example.bin')).toMatchObject({ status: 200, body: { kind: 'unsupported' } });
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(WORKSPACE_FILE_LIMIT + 1));
    expect(await preview('large.txt')).toMatchObject({ status: 200, body: { kind: 'too-large' } });
    for (const file of ['../README.md', '.GIT/config', 'code']) {
      expect((await preview(file)).status).toBe(400);
    }
    if (process.platform !== 'win32') {
      symlinkSync(join(root, 'README.md'), join(root, 'linked.md'));
      symlinkSync(root, join(root, 'linked-directory'));
      expect((await preview('linked.md')).status).toBe(400);
      expect((await preview('linked-directory/README.md')).status).toBe(400);
    }
  });

  it('未配置 GitHub Token 时应返回 fine-grained Token 创建引导', async () => {
    const response = await server.handler('GET', '/api/console/github')(Buffer.alloc(0), {}, {});
    expect(response.body).toMatchObject({
      hasToken: false,
      connected: false,
      tokenSource: 'none',
      requiredPermissions: {
        contents: 'write',
        pullRequests: 'write',
        workflows: 'write',
      },
    });
    expect((response.body as { createTokenUrl: string }).createTokenUrl).toContain(
      'https://github.com/settings/personal-access-tokens/new?',
    );
  });

  it('应持久化多套 Agent 模型配置并丢弃旧地址和密钥字段', async () => {
    const getSettings = server.handler('GET', '/api/console/settings');
    const updateSettings = server.handler('POST', '/api/console/settings');
    expect((await getSettings(Buffer.alloc(0), {}, {})).body).toMatchObject({
      version: 5,
      activeConfigurationId: 'default-codex',
      modelConfigs: [{ provider: 'codex' }],
    });

    const response = await updateSettings(
      Buffer.from(
        JSON.stringify({
          modelConfigs: [
            {
              id: 'codex-deep',
              provider: 'codex',
              model: 'gpt-deep',
              baseUrl: 'https://gateway.example.com/',
              apiKey: 'secret-codex',
            },
            { id: 'codex-main', provider: 'codex', model: 'gpt-5.1-codex' },
          ],
        }),
      ),
      {},
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      version: 5,
      activeConfigurationId: 'codex-deep',
      modelConfigs: [
        {
          id: 'codex-deep',
          provider: 'codex',
          model: 'gpt-deep',
          reasoningEffort: 'high',
        },
        { id: 'codex-main', provider: 'codex' },
      ],
    });
    expect(response.headers).toEqual({ 'Cache-Control': 'no-store' });
    expect(JSON.stringify(response.body)).not.toContain('secret-codex');

    const settingsPath = join(TMP_DIR, 'console-settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      version: number;
      modelConfigs: Array<{ id: string; provider: string }>;
    };
    expect(stored.version).toBe(5);
    expect(stored.modelConfigs.map((configuration) => configuration.id)).toEqual([
      'codex-deep',
      'codex-main',
    ]);
    expect(JSON.stringify(stored)).not.toContain('secret-codex');
    expect(JSON.stringify(stored)).not.toContain('gateway.example.com');
    expect(JSON.stringify(stored)).toContain('gpt-deep');
  });

  it('应使用当前 Agent 关联项测试连通性且只依赖 CLI 配置', async () => {
    await webConsole.stop();
    const tested: ModelTestConfiguration[] = [];
    const modelTester: ModelConfigurationTestRunner = {
      test: async (configuration) => {
        tested.push(configuration);
        return {
          success: true,
          provider: configuration.provider,
          model: configuration.model,
          message: 'Codex 已成功响应，模型配置可用。',
          response: '你好，我是 Codex。',
          durationMs: 123,
        };
      },
    };
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      { modelTester },
    );
    await server.handler('POST', '/api/console/settings')(
      Buffer.from(
        JSON.stringify({
          modelConfigs: [
            {
              id: 'codex-main',
              provider: 'codex',
              model: 'gpt-test',
              baseUrl: 'https://gateway.example.com',
              apiKey: 'secret-key',
            },
          ],
        }),
      ),
      {},
      {},
    );

    const response = await server.handler('POST', '/api/console/model-test')(
      Buffer.from(
        JSON.stringify({
          id: 'codex-main',
          provider: 'codex',
          model: 'gpt-test',
          baseUrl: 'https://gateway.example.com',
          prompt: '请介绍一下自己',
        }),
      ),
      {},
      {},
    );

    expect(response).toMatchObject({
      status: 200,
      body: {
        success: true,
        provider: 'codex',
        response: '你好，我是 Codex。',
        durationMs: 123,
      },
      headers: { 'Cache-Control': 'no-store' },
    });
    expect(tested).toEqual([
      {
        provider: 'codex',
        model: 'gpt-test',
        reasoningEffort: 'high',
        prompt: '请介绍一下自己',
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('secret-key');
  });

  it('模型测试应校验临时关联项且忽略页面提交的旧密钥字段', async () => {
    await webConsole.stop();
    const tested: ModelTestConfiguration[] = [];
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        modelTester: {
          test: async (configuration) => {
            tested.push(configuration);
            return {
              success: false,
              provider: configuration.provider,
              model: configuration.model,
              message: '鉴权失败，请检查 API Key 或 CLI 登录状态。',
              durationMs: 50,
            };
          },
        },
      },
    );

    const invalid = await server.handler('POST', '/api/console/model-test')(
      Buffer.from(JSON.stringify({ provider: 'unknown', model: 'bad model' })),
      {},
      {},
    );
    expect(invalid.status).toBe(400);

    const response = await server.handler('POST', '/api/console/model-test')(
      Buffer.from(
        JSON.stringify({
          id: 'temporary-codex',
          provider: 'codex',
          model: 'gpt-test',
          apiKey: 'temporary-secret',
        }),
      ),
      {},
      {},
    );
    expect(response).toMatchObject({ status: 200, body: { success: false } });
    expect(tested).toEqual([{ provider: 'codex', model: 'gpt-test', reasoningEffort: 'high' }]);
    expect(existsSync(join(TMP_DIR, 'console-settings.json'))).toBe(false);
  });

  it('应对错误设置返回 400', async () => {
    const response = await server.handler('POST', '/api/console/settings')(Buffer.from('{bad json'), {}, {});
    expect(response).toMatchObject({ status: 400 });
  });

  it('应保存 Codex 运行配置并通过消息平台接口隐藏 Secret', async () => {
    await webConsole.stop();
    server = new FakeHttpServer();
    const savedPlatforms: string[] = [];
    const publicConfiguration = {
      dingtalk: {
        platform: 'dingtalk' as const,
        displayName: '钉钉',
        enabled: true,
        configured: true,
        state: 'connected' as const,
        message: '已连接',
        hasClientId: true,
        hasClientSecret: true,
      },
      feishu: {
        platform: 'feishu' as const,
        displayName: '飞书',
        enabled: false,
        configured: false,
        state: 'disabled' as const,
        message: '未启用',
        hasAppId: false,
        hasAppSecret: false,
      },
    };
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        codexConfig: new CodexConfigManager(join(TMP_DIR, 'codex')),
        getMessagingConfiguration: () => publicConfiguration,
        saveMessagingConfiguration: async (platform, config) => {
          savedPlatforms.push(
            `${platform}:${config.enabled}:${config.clientId}:${config.clientSecret}`,
          );
          return publicConfiguration;
        },
      },
    );

    const codex = await server.handler('POST', '/api/console/codex-config')(
      Buffer.from(
        JSON.stringify({
          model: 'gpt-5.2-codex',
          modelReasoningEffort: 'high',
          approvalPolicy: 'never',
          sandboxMode: 'workspace-write',
          webSearch: 'cached',
        }),
      ),
      {},
      {},
    );
    expect(codex).toMatchObject({ status: 200, body: { model: 'gpt-5.2-codex' } });

    const integration = await server.handler('POST', '/api/console/integrations')(
      Buffer.from(
        JSON.stringify({
          platform: 'dingtalk',
          enabled: true,
          clientId: 'ding-id',
          clientSecret: 'ding-secret',
        }),
      ),
      {},
      {},
    );
    expect(integration).toMatchObject({ status: 200, body: publicConfiguration });
    expect(JSON.stringify(integration.body)).not.toContain('ding-secret');
    expect(savedPlatforms).toEqual(['dingtalk:true:ding-id:ding-secret']);
  });

  it('只注册会话工作台的工作区入口', () => {
    expect(server.routes.has('POST /api/console/workspace')).toBe(true);
    for (const route of [
      'GET /api/console/tasks', 'POST /api/console/tasks', 'GET /api/console/task',
      'POST /api/console/task/continue', 'POST /api/console/cancel', 'GET /api/console/github/branches',
    ]) {
      expect(server.routes.has(route)).toBe(false);
    }
  });

  it('应拒绝未知 Agent、空配置列表和重复配置 ID', async () => {
    const updateSettings = server.handler('POST', '/api/console/settings');
    const unknownProvider = await updateSettings(
      Buffer.from(
        JSON.stringify({ modelConfigs: [{ id: 'bad', provider: 'unknown', model: '' }] }),
      ),
      {},
      {},
    );
    expect(unknownProvider).toMatchObject({ status: 400 });

    const empty = await updateSettings(Buffer.from(JSON.stringify({ modelConfigs: [] })), {}, {});
    expect(empty).toMatchObject({ status: 400 });

    const duplicate = await updateSettings(
      Buffer.from(
        JSON.stringify({
          modelConfigs: [
            { id: 'same', provider: 'codex' },
            { id: 'same', provider: 'codex' },
          ],
        }),
      ),
      {},
      {},
    );
    expect(duplicate).toMatchObject({ status: 400 });
  });

  it('应将 v3 配置迁移为可切换的 v5 配置并删除旧密钥与地址', async () => {
    await webConsole.stop();
    const settingsPath = join(TMP_DIR, 'console-settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        version: 3,
        modelConfigs: [
          {
            id: 'association',
            provider: 'codex',
            model: 'gpt-old',
            baseUrl: 'https://gateway.example.com',
            apiKey: 'codex-secret',
          },
        ],
      }),
    );
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
    );

    const response = await server.handler('GET', '/api/console/settings')(Buffer.alloc(0), {}, {});
    expect(response.body).toEqual({
      version: 5,
      activeConfigurationId: 'association',
      modelConfigs: [
        {
          id: 'association',
          name: 'Codex 配置 1',
          provider: 'codex',
          model: 'gpt-old',
          reasoningEffort: 'high',
        },
      ],
    });
    const persisted = readFileSync(settingsPath, 'utf8');
    expect(persisted).not.toContain('codex-secret');
    expect(persisted).not.toContain('gateway.example.com');
    expect(persisted).toContain('gpt-old');
  });

  it('应将旧版固定模型设置迁移为有序 Agent 配置且清除模型覆盖', async () => {
    await webConsole.stop();
    writeFileSync(
      join(TMP_DIR, 'console-settings.json'),
      JSON.stringify({
        defaultProvider: 'legacy-provider',
        codexModel: 'gpt-5.1-codex',
        fallbackOrder: ['codex', 'legacy-provider'],
      }),
    );
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
    );

    const response = await server.handler('GET', '/api/console/settings')(Buffer.alloc(0), {}, {});
    expect(response.body).toMatchObject({
      version: 5,
      modelConfigs: [{ provider: 'codex' }],
    });
    expect(readFileSync(join(TMP_DIR, 'console-settings.json'), 'utf8')).toContain('"version": 5');
  });

  it('应验证 GitHub Token、分页读取全部仓库并在成功后持久化', async () => {
    await webConsole.stop();
    const requestedPages: number[] = [];
    const requestedBranchPages: number[] = [];
    const tokens: string[] = [];
    const persistedTokens: string[] = [];
    const activatedTokens: string[] = [];
    const repositories = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: `repo-${index + 1}`,
      full_name: `octocat/repo-${index + 1}`,
      owner: { login: 'octocat' },
      private: index === 0,
      html_url: `https://github.com/octocat/repo-${index + 1}`,
      description: null,
      fork: false,
      archived: false,
      language: 'TypeScript',
      stargazers_count: index,
      updated_at: '2026-07-21T00:00:00Z',
      default_branch: 'main',
    }));
    const client: GitHubApiClient = {
      get: async <T>(url: string, params?: Record<string, unknown>): Promise<T> => {
        if (url === '/user') {
          return {
            login: 'octocat',
            name: 'The Octocat',
            avatar_url: 'https://avatars.githubusercontent.com/u/1',
            html_url: 'https://github.com/octocat',
          } as T;
        }
        if (url === '/repos/octocat/repo-1/branches') {
          requestedBranchPages.push(Number(params?.page));
          return [
            { name: 'main', protected: true },
            { name: 'develop', protected: false },
          ] as T;
        }
        const page = Number(params?.page);
        requestedPages.push(page);
        return repositories.slice((page - 1) * 100, page * 100) as T;
      },
    };
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        githubClientFactory: (token) => {
          tokens.push(token);
          return client;
        },
        persistGitHubToken: (token) => persistedTokens.push(token),
        onGitHubTokenConnected: (token) => activatedTokens.push(token),
      },
    );

    const response = await server.handler('POST', '/api/console/github/connect')(
      Buffer.from(JSON.stringify({ token: 'github_pat_runtime-only' })),
      {},
      {},
    );

    expect(response).toMatchObject({
      status: 200,
      body: {
        user: { login: 'octocat', name: 'The Octocat' },
      },
      headers: { 'Cache-Control': 'no-store' },
    });
    expect((response.body as { repositories: unknown[] }).repositories).toHaveLength(101);
    expect(requestedPages).toEqual([1, 2]);
    expect(tokens).toEqual(['github_pat_runtime-only']);
    expect(persistedTokens).toEqual(['github_pat_runtime-only']);
    expect(activatedTokens).toEqual(['github_pat_runtime-only']);
    const status = await server.handler('GET', '/api/console/github')(Buffer.alloc(0), {}, {});
    expect(status.body).toMatchObject({
      hasToken: true,
      connected: true,
      tokenSource: 'file',
      repositoryCount: 101,
    });
    expect(await webConsole.getGitHubBranches('octocat/repo-1')).toEqual([
      { name: 'main', protected: true },
      { name: 'develop', protected: false },
    ]);
    expect(requestedBranchPages).toEqual([1]);
    expect(tokens).toEqual(['github_pat_runtime-only', 'github_pat_runtime-only']);
  });

  it('GitHub Token 无效时应返回鉴权错误且不建立连接或写入配置', async () => {
    await webConsole.stop();
    const persistedTokens: string[] = [];
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        githubClientFactory: () => ({
          get: async () => {
            throw new GitHubError('GitHub API 错误 (401): Bad credentials', 401);
          },
        }),
        persistGitHubToken: (token) => persistedTokens.push(token),
      },
    );

    const response = await server.handler('POST', '/api/console/github/connect')(
      Buffer.from(JSON.stringify({ token: 'invalid-token' })),
      {},
      {},
    );
    expect(response).toMatchObject({ status: 401 });
    const status = await server.handler('GET', '/api/console/github')(Buffer.alloc(0), {}, {});
    expect(status.body).toMatchObject({ hasToken: false, connected: false });
    expect(persistedTokens).toEqual([]);
  });

  it('已有配置 Token 时应直接读取验证且不重复写入配置', async () => {
    await webConsole.stop();
    const tokens: string[] = [];
    const persistedTokens: string[] = [];
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        githubToken: 'github_pat_from_config',
        githubClientFactory: (token) => {
          tokens.push(token);
          return {
            get: async <T>(url: string): Promise<T> =>
              (url === '/user'
                ? {
                    login: 'octocat',
                    name: null,
                    avatar_url: '',
                    html_url: 'https://github.com/octocat',
                  }
                : []) as T,
          };
        },
        persistGitHubToken: (token) => persistedTokens.push(token),
      },
    );

    const response = await server.handler('POST', '/api/console/github/connect')(
      Buffer.from('{}'),
      {},
      {},
    );

    expect(response.status).toBe(200);
    expect(tokens).toEqual(['github_pat_from_config']);
    expect(persistedTokens).toEqual([]);
  });

  it('应标识由环境变量管理的 GitHub Token', async () => {
    await webConsole.stop();
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        githubToken: 'github_pat_from_environment',
        githubTokenSource: 'environment',
      },
    );

    const status = await server.handler('GET', '/api/console/github')(Buffer.alloc(0), {}, {});
    expect(status.body).toMatchObject({
      hasToken: true,
      connected: false,
      tokenSource: 'environment',
    });

    const replace = await server.handler('POST', '/api/console/github/connect')(
      Buffer.from(JSON.stringify({ token: 'github_pat_replacement' })),
      {},
      {},
    );
    expect(replace).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('环境变量管理') },
    });
  });

  it('应通过控制台启动、查询和取消 Codex 设备码登录', async () => {
    await webConsole.stop();
    let waiting = false;
    let cancelled = false;
    const codexAuth: AgentAuthService = {
      getStatus: async () =>
        waiting
          ? {
              provider: 'codex',
              displayName: 'Codex',
              loginMode: 'device-code',
              state: 'waiting',
              authenticated: false,
              cliAvailable: true,
              verificationUrl: 'https://auth.openai.com/device',
              userCode: 'ABCD-EFGH',
            }
          : {
              provider: 'codex',
              displayName: 'Codex',
              loginMode: 'device-code',
              state: 'authenticated',
              authenticated: true,
              cliAvailable: true,
              authMethod: 'chatgpt',
            },
      startLogin: async () => {
        waiting = true;
        return {
          provider: 'codex',
          displayName: 'Codex',
          loginMode: 'device-code',
          state: 'waiting',
          authenticated: false,
          cliAvailable: true,
          message: '请在浏览器完成设备授权。',
        };
      },
      loginWithApiKey: async () => ({
        provider: 'codex',
        displayName: 'Codex',
        loginMode: 'device-code',
        state: 'authenticated',
        authenticated: true,
        cliAvailable: true,
        authMethod: 'API Key',
      }),
      cancelLogin: () => {
        if (!waiting) return false;
        waiting = false;
        cancelled = true;
        return true;
      },
      stop: async () => undefined,
    };
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
      {
        agentAuth: codexAuth,
        codexModels: {
          list: async () => ({
            source: 'codex-cli',
            fetchedAt: 1,
            models: [
              {
                id: 'gpt-test',
                displayName: 'GPT Test',
                description: 'test model',
                defaultReasoningEffort: 'medium',
                supportedReasoningEfforts: ['low', 'medium', 'high'],
              },
            ],
          }),
        },
      },
    );

    const before = await server.handler('GET', '/api/console/agent-auth')(
      Buffer.alloc(0),
      {},
      { provider: 'codex' },
    );
    expect(before.body).toMatchObject({ authenticated: true, authMethod: 'chatgpt' });

    const models = await server.handler('GET', '/api/console/codex-models')(
      Buffer.alloc(0),
      {},
      {},
    );
    expect(models).toMatchObject({
      status: 200,
      body: { source: 'codex-cli', models: [{ id: 'gpt-test' }] },
    });

    const started = await server.handler('POST', '/api/console/agent-auth/login')(
      Buffer.from(JSON.stringify({ provider: 'codex' })),
      {},
      {},
    );
    expect(started).toMatchObject({ status: 202, body: { state: 'waiting' } });

    const waitingStatus = await server.handler('GET', '/api/console/agent-auth')(
      Buffer.alloc(0),
      {},
      { provider: 'codex' },
    );
    expect(waitingStatus.body).toMatchObject({
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
    });

    const cancelledResponse = await server.handler('POST', '/api/console/agent-auth/cancel')(
      Buffer.from(JSON.stringify({ provider: 'codex' })),
      {},
      {},
    );
    expect(cancelledResponse.status).toBe(200);
    expect(cancelled).toBe(true);

    const duplicateCancel = await server.handler('POST', '/api/console/agent-auth/cancel')(
      Buffer.from(JSON.stringify({ provider: 'codex' })),
      {},
      {},
    );
    expect(duplicateCancel.status).toBe(409);
  });
});
