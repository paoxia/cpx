import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestHandler } from '../../../src/core/HttpServer';
import { WebConsole } from '../../../src/web/WebConsole';
import { Logger } from '../../../src/utils/Logger';
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
    expect(html).toContain('id="integrations-tab"');
    expect(html).toContain('id="codex-tab"');
    expect(html).toContain('WebSocket 长连接');
    expect(html).toContain('Agent 设置');
    expect(html).not.toContain('Claude Code');
    expect(html).toContain('Codex 配置方案');
    expect(html).toContain('id="github-create-token"');
    expect(html).toContain('id="repository-picker"');
    expect(html).toContain('id="branch-picker"');
    expect(html).toContain('id="task-branch"');
    expect(html).toContain('id="new-task-button"');
    expect(html).toContain('class="thread-composer new-task-mode"');
    expect(html).not.toContain('id="create-pr"');
    expect(html).not.toContain('完成后创建 Pull Request');
    expect(html).toContain('选择已有 Token 授权的项目');
    expect(html).toContain('contents=write');
    expect(html).toContain('pull_requests=write');
    expect(html).toContain('id="codex-auth-status"');

    const scriptResponse = await server.handler('GET', '/app.js')(Buffer.alloc(0), {}, {});
    const script = (scriptResponse.body as Buffer).toString('utf8');
    expect(script).toContain('/api/console/integrations');
    expect(script).toContain('/api/console/codex-config');
    expect(script).toContain('/api/console/agent-auth/api-key');
    expect(script).toContain('/api/console/codex-models');
    expect(script).toContain('baseBranch: selectedTaskBaseBranch()');
    expect(script).toContain('runDetailsOpenTaskIds: new Set()');
    expect(script).toContain('rememberRunDetailsState()');
    expect(script).toContain('class="task-list-meta-text"');
    expect(script).not.toContain('/webhook/');

    const stylesResponse = await server.handler('GET', '/styles.css')(Buffer.alloc(0), {}, {});
    const styles = (stylesResponse.body as Buffer).toString('utf8');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(styles).toContain('overflow-x: hidden');
    expect(styles).toContain('-webkit-line-clamp: 2');
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

    const continuation = await server.handler('POST', '/api/console/task/continue')(
      Buffer.from(JSON.stringify({ id: 'missing', prompt: '继续修改' })),
      {},
      {},
    );
    expect(continuation).toMatchObject({ status: 400, body: { error: '任务不存在' } });
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
    const branches = await server.handler('GET', '/api/console/github/branches')(
      Buffer.alloc(0),
      {},
      { repository: 'octocat/repo-1' },
    );
    expect(branches).toMatchObject({
      status: 200,
      body: {
        repository: 'octocat/repo-1',
        branches: [
          { name: 'main', protected: true },
          { name: 'develop', protected: false },
        ],
      },
    });
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
