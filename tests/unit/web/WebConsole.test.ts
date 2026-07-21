import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestHandler } from '../../../src/core/HttpServer';
import { WebConsole } from '../../../src/web/WebConsole';
import { Logger } from '../../../src/utils/Logger';
import { GitHubError } from '../../../src/utils/errors';
import type { GitHubApiClient } from '../../../src/web/GitHubExplorer';
import type { AgentAuthService } from '../../../src/web/AgentAuthManager';

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
    expect((response.body as Buffer).toString('utf8')).toContain('id="github-tab"');
    expect((response.body as Buffer).toString('utf8')).toContain('id="models-tab"');
  });

  it('应按顺序持久化模型配置和独立 API Key，且响应不返回密钥', async () => {
    const getSettings = server.handler('GET', '/api/console/settings');
    const updateSettings = server.handler('POST', '/api/console/settings');
    expect((await getSettings(Buffer.alloc(0), {}, {})).body).toMatchObject({
      version: 2,
      modelConfigs: [
        { provider: 'codex', model: '' },
        { provider: 'claude', model: 'sonnet' },
        { provider: 'codebuddy', model: '' },
      ],
    });

    const response = await updateSettings(
      Buffer.from(
        JSON.stringify({
          modelConfigs: [
            {
              id: 'claude-opus',
              provider: 'claude',
              model: 'opus',
              apiKey: 'secret-claude',
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
      version: 2,
      modelConfigs: [
        { id: 'claude-opus', provider: 'claude', model: 'opus', hasApiKey: true },
        { id: 'codex-main', provider: 'codex', model: 'gpt-5.1-codex', hasApiKey: false },
      ],
    });
    expect(response.headers).toEqual({ 'Cache-Control': 'no-store' });
    expect(JSON.stringify(response.body)).not.toContain('secret-claude');

    const settingsPath = join(TMP_DIR, 'console-settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      version: number;
      modelConfigs: Array<{ id: string; apiKey?: string }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.modelConfigs.map((configuration) => configuration.id)).toEqual([
      'claude-opus',
      'codex-main',
    ]);
    expect(stored.modelConfigs[0].apiKey).toBe('secret-claude');
  });

  it('应对错误设置和错误任务请求返回 400', async () => {
    const settingsResponse = await server.handler('POST', '/api/console/settings')(
      Buffer.from('{bad json'),
      {},
      {},
    );
    expect(settingsResponse).toMatchObject({ status: 400 });

    const taskResponse = await server.handler('POST', '/api/console/tasks')(
      Buffer.from(JSON.stringify({ repository: 'not-github', prompt: 'test' })),
      {},
      {},
    );
    expect(taskResponse).toMatchObject({ status: 400 });
  });

  it('应返回空任务列表以及明确的查询和取消错误', async () => {
    const list = await server.handler('GET', '/api/console/tasks')(Buffer.alloc(0), {}, {});
    expect(list).toMatchObject({ status: 200, body: { tasks: [] } });

    const detail = await server.handler('GET', '/api/console/task')(Buffer.alloc(0), {}, {});
    expect(detail).toMatchObject({ status: 400, body: { error: 'id is required' } });

    const cancel = await server.handler('POST', '/api/console/cancel')(
      Buffer.from(JSON.stringify({ id: 'missing' })),
      {},
      {},
    );
    expect(cancel).toMatchObject({ status: 409 });
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
            { id: 'same', provider: 'claude' },
          ],
        }),
      ),
      {},
      {},
    );
    expect(duplicate).toMatchObject({ status: 400 });
  });

  it('更新配置留空时应保留原密钥，显式清除时应删除', async () => {
    const updateSettings = server.handler('POST', '/api/console/settings');
    await updateSettings(
      Buffer.from(
        JSON.stringify({
          modelConfigs: [{ id: 'cb', provider: 'codebuddy', model: 'cb-pro', apiKey: 'secret-cb' }],
        }),
      ),
      {},
      {},
    );
    const retained = await updateSettings(
      Buffer.from(
        JSON.stringify({ modelConfigs: [{ id: 'cb', provider: 'codebuddy', model: 'cb-next' }] }),
      ),
      {},
      {},
    );
    expect(retained.body).toMatchObject({
      modelConfigs: [{ id: 'cb', model: 'cb-next', hasApiKey: true }],
    });

    const settingsPath = join(TMP_DIR, 'console-settings.json');
    expect(readFileSync(settingsPath, 'utf8')).toContain('secret-cb');

    const cleared = await updateSettings(
      Buffer.from(
        JSON.stringify({
          modelConfigs: [{ id: 'cb', provider: 'codebuddy', model: 'cb-next', clearApiKey: true }],
        }),
      ),
      {},
      {},
    );
    expect(cleared.body).toMatchObject({ modelConfigs: [{ id: 'cb', hasApiKey: false }] });
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('secret-cb');
  });

  it('应将旧版固定模型设置迁移为有序模型配置', async () => {
    await webConsole.stop();
    writeFileSync(
      join(TMP_DIR, 'console-settings.json'),
      JSON.stringify({
        defaultProvider: 'claude',
        codexModel: 'gpt-5.1-codex',
        claudeModel: 'opus',
        codebuddyModel: 'cb-pro',
        fallbackOrder: ['codex', 'claude', 'codebuddy'],
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
      version: 2,
      modelConfigs: [
        { provider: 'claude', model: 'opus' },
        { provider: 'codex', model: 'gpt-5.1-codex' },
        { provider: 'codebuddy', model: 'cb-pro' },
      ],
    });
    expect(readFileSync(join(TMP_DIR, 'console-settings.json'), 'utf8')).toContain('"version": 2');
  });

  it('应验证 GitHub Token、分页读取全部仓库并在成功后持久化', async () => {
    await webConsole.stop();
    const requestedPages: number[] = [];
    const tokens: string[] = [];
    const persistedTokens: string[] = [];
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
    const status = await server.handler('GET', '/api/console/github')(Buffer.alloc(0), {}, {});
    expect(status.body).toMatchObject({
      hasToken: true,
      connected: true,
      repositoryCount: 101,
    });
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
      submitInput: () => {
        throw new Error('Codex 不接受输入');
      },
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
      { agentAuth: { codex: codexAuth } },
    );

    const before = await server.handler('GET', '/api/console/agent-auth')(
      Buffer.alloc(0),
      {},
      { provider: 'codex' },
    );
    expect(before.body).toMatchObject({ authenticated: true, authMethod: 'chatgpt' });

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

    const cancelledResponse = await server.handler(
      'POST',
      '/api/console/agent-auth/cancel',
    )(Buffer.from(JSON.stringify({ provider: 'codex' })), {}, {});
    expect(cancelledResponse.status).toBe(200);
    expect(cancelled).toBe(true);

    const duplicateCancel = await server.handler(
      'POST',
      '/api/console/agent-auth/cancel',
    )(Buffer.from(JSON.stringify({ provider: 'codex' })), {}, {});
    expect(duplicateCancel.status).toBe(409);
  });
});
