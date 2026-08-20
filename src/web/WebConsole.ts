import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join, resolve } from 'path';
import {
  AgentModelConfiguration,
  AgentReasoningEffort,
  AgentTask,
  AgentTaskManager,
  CodingAgentProvider,
} from '../agents/AgentTaskManager';
import { HttpServer } from '../core/HttpServer';
import { GitHubClient } from '../github/GitHubClient';
import { Logger } from '../utils/Logger';
import {
  AgentAuthManager,
  AgentAuthService,
} from './AgentAuthManager';
import { CodexConfigManager, CodexRuntimeConfiguration } from './CodexConfigManager';
import { CodexModelCatalog, CodexModelCatalogReader } from './CodexModelCatalog';
import {
  GitHubClientFactory,
  GitHubConnection,
  inspectGitHubAccount,
  listGitHubBranches,
} from './GitHubExplorer';
import { ModelConfigurationTester, ModelConfigurationTestRunner } from './ModelConfigurationTester';
import {
  isMessagingPlatform,
  MessagingPlatform,
  PublicMessagingConfiguration,
} from '../integrations/MessagingIntegrationManager';
import type { DingTalkConfig, FeishuConfig } from '../core/types';

interface StoredModelConfiguration {
  id: string;
  name: string;
  provider: CodingAgentProvider;
  model?: string;
  reasoningEffort: AgentReasoningEffort;
}

interface ConsoleSettings {
  version: 5;
  activeConfigurationId: string;
  modelConfigs: StoredModelConfiguration[];
}

interface ModelConfigurationPayload {
  id?: string;
  name?: string;
  provider?: CodingAgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  prompt?: string;
}

interface SettingsPayload {
  activeConfigurationId?: string;
  modelConfigs?: ModelConfigurationPayload[];
}

const DEFAULT_SETTINGS: ConsoleSettings = createDefaultSettings();

const STATIC_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const API_HEADERS = { 'Cache-Control': 'no-store' };

export type GitHubTokenSource = 'none' | 'file' | 'environment';

export const GITHUB_TOKEN_CREATE_URL =
  'https://github.com/settings/personal-access-tokens/new?' +
  new URLSearchParams({
    name: 'cpx',
    description: 'Used by cpx to modify code and create pull requests',
    expires_in: '90',
    contents: 'write',
    pull_requests: 'write',
    workflows: 'write',
  }).toString();

const GITHUB_TOKEN_PERMISSIONS = {
  contents: 'write',
  pullRequests: 'write',
  workflows: 'write',
} as const;

export interface WebConsoleOptions {
  githubToken?: string;
  githubTokenSource?: GitHubTokenSource;
  githubClientFactory?: GitHubClientFactory;
  persistGitHubToken?: (token: string) => void;
  onGitHubTokenConnected?: (token: string) => void;
  agentAuth?: AgentAuthService;
  codexConfig?: CodexConfigManager;
  codexModels?: CodexModelCatalogReader;
  getMessagingConfiguration?: () => PublicMessagingConfiguration;
  saveMessagingConfiguration?: (
    platform: MessagingPlatform,
    config: Partial<DingTalkConfig & FeishuConfig>,
  ) => Promise<PublicMessagingConfiguration>;
  modelTester?: ModelConfigurationTestRunner;
}

export interface ConsoleCodingTaskRequest {
  repository: string;
  baseBranch?: string;
  taskBranch?: string;
  prompt: string;
  createPullRequest?: boolean;
  useFallback?: boolean;
}

/** 注册开发控制台页面、设置和 Agent 任务 API。 */
export class WebConsole {
  private settings: ConsoleSettings;
  private settingsPath: string;
  private taskManager: AgentTaskManager;
  private logger: Logger;
  private githubToken?: string;
  private githubTokenSource: GitHubTokenSource;
  private githubConnection?: GitHubConnection;
  private githubClientFactory: GitHubClientFactory;
  private persistGitHubToken?: (token: string) => void;
  private onGitHubTokenConnected?: (token: string) => void;
  private agentAuth: AgentAuthService;
  private codexConfig: CodexConfigManager;
  private codexModels: CodexModelCatalogReader;
  private getMessagingConfiguration?: () => PublicMessagingConfiguration;
  private saveMessagingConfiguration?: WebConsoleOptions['saveMessagingConfiguration'];
  private modelTester: ModelConfigurationTestRunner;

  constructor(
    httpServer: HttpServer,
    storagePath: string,
    logger: Logger,
    options: WebConsoleOptions = {},
  ) {
    this.logger = logger.child('WebConsole');
    const dataDir = resolve(dirname(storagePath));
    this.settingsPath = join(dataDir, 'console-settings.json');
    this.settings = this.loadSettings();
    this.taskManager = new AgentTaskManager(join(dataDir, 'workspaces'), logger);
    this.githubToken = options.githubToken?.trim() || undefined;
    this.githubTokenSource = this.githubToken ? (options.githubTokenSource ?? 'file') : 'none';
    if (this.githubToken) {
      this.taskManager.setSecrets({ githubToken: this.githubToken });
    }
    this.githubClientFactory =
      options.githubClientFactory ?? ((token) => new GitHubClient(token, this.logger));
    this.persistGitHubToken = options.persistGitHubToken;
    this.onGitHubTokenConnected = options.onGitHubTokenConnected;
    this.agentAuth = options.agentAuth ?? new AgentAuthManager(this.logger);
    this.codexConfig = options.codexConfig ?? new CodexConfigManager();
    this.codexModels = options.codexModels ?? new CodexModelCatalog();
    this.getMessagingConfiguration = options.getMessagingConfiguration;
    this.saveMessagingConfiguration = options.saveMessagingConfiguration;
    this.modelTester = options.modelTester ?? new ModelConfigurationTester(dataDir, this.logger);
    this.registerAssets(httpServer);
    this.registerApi(httpServer);
  }

  async inspectGitHub(): Promise<GitHubConnection> {
    validateGitHubToken(this.githubToken);
    const connection = await inspectGitHubAccount(this.githubClientFactory(this.githubToken!));
    this.githubConnection = connection;
    return connection;
  }

  async getGitHubBranches(repository: string) {
    validateGitHubToken(this.githubToken);
    return listGitHubBranches(this.githubClientFactory(this.githubToken!), repository);
  }

  createCodingTask(request: ConsoleCodingTaskRequest): AgentTask {
    return this.taskManager.create({
      configurations: this.executionConfigurations(request.useFallback !== false),
      repository: request.repository,
      baseBranch: request.baseBranch,
      taskBranch: request.taskBranch,
      prompt: request.prompt,
      createPullRequest: request.createPullRequest,
    });
  }

  listCodingTasks(): AgentTask[] {
    return this.taskManager.list();
  }

  getCodingTask(reference: string): AgentTask | undefined {
    const exact = this.taskManager.get(reference);
    if (exact) {
      return exact;
    }
    const matches = this.taskManager.list().filter((task) => task.id.startsWith(reference));
    return matches.length === 1 ? matches[0] : undefined;
  }

  cancelCodingTask(reference: string): boolean {
    const task = this.getCodingTask(reference);
    return task ? this.taskManager.cancel(task.id) : false;
  }

  waitForCodingTask(id: string): Promise<AgentTask> {
    return this.taskManager.waitForTerminal(id);
  }

  async stop(): Promise<void> {
    await Promise.all([this.taskManager.stop(), this.agentAuth.stop()]);
  }

  private registerAssets(httpServer: HttpServer): void {
    const publicDir = findPublicDir();
    const assets = [
      { route: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' },
      { route: '/app.js', file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
      { route: '/styles.css', file: 'styles.css', contentType: 'text/css; charset=utf-8' },
    ];
    for (const asset of assets) {
      const content = readFileSync(join(publicDir, asset.file));
      httpServer.register('GET', asset.route, async () => ({
        status: 200,
        body: content,
        contentType: asset.contentType,
        headers: {
          'Cache-Control': 'no-cache',
          ...STATIC_SECURITY_HEADERS,
        },
      }));
    }
  }

  private registerApi(httpServer: HttpServer): void {
    httpServer.register('GET', '/api/console/settings', async () => ({
      status: 200,
      body: this.publicSettings(),
      headers: API_HEADERS,
    }));

    httpServer.register('POST', '/api/console/settings', async (body) => {
      try {
        const payload = parseJson<SettingsPayload>(body);
        this.updateSettings(payload);
        return { status: 200, body: this.publicSettings(), headers: API_HEADERS };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) } };
      }
    });

    httpServer.register('POST', '/api/console/model-test', async (body) => {
      let configuration: StoredModelConfiguration;
      let prompt: string | undefined;
      try {
        const payload = parseJson<ModelConfigurationPayload>(body);
        configuration = normalizeModelConfigurationPayloads([payload])[0];
        prompt = normalizeModelTestPrompt(payload.prompt);
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }

      try {
        return {
          status: 200,
          body: await this.modelTester.test({
            provider: configuration.provider,
            ...(configuration.model ? { model: configuration.model } : {}),
            reasoningEffort: configuration.reasoningEffort,
            ...(prompt ? { prompt } : {}),
          }),
          headers: API_HEADERS,
        };
      } catch (error) {
        this.logger.error(`模型配置测试失败: ${errorMessage(error)}`);
        return {
          status: 502,
          body: { error: '模型配置测试服务暂时不可用' },
          headers: API_HEADERS,
        };
      }
    });

    httpServer.register('GET', '/api/console/agent-auth', async (_body, _headers, query) => {
      try {
        this.assertCodexProvider(query.provider);
        return { status: 200, body: await this.agentAuth.getStatus(), headers: API_HEADERS };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('POST', '/api/console/agent-auth/login', async (body) => {
      try {
        const payload = parseJson<{ provider?: string }>(body);
        this.assertCodexProvider(payload.provider);
        return { status: 202, body: await this.agentAuth.startLogin(), headers: API_HEADERS };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('POST', '/api/console/agent-auth/api-key', async (body) => {
      try {
        const payload = parseJson<{ provider?: string; apiKey?: string }>(body);
        if (payload.provider !== 'codex') throw new Error('API Key 登录只支持 codex');
        return {
          status: 200,
          body: await this.agentAuth.loginWithApiKey(payload.apiKey ?? ''),
          headers: API_HEADERS,
        };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('POST', '/api/console/agent-auth/cancel', async (body) => {
      try {
        const payload = parseJson<{ provider?: string }>(body);
        this.assertCodexProvider(payload.provider);
        return this.agentAuth.cancelLogin()
          ? { status: 200, body: { success: true }, headers: API_HEADERS }
          : { status: 409, body: { error: '当前没有进行中的登录' }, headers: API_HEADERS };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('GET', '/api/console/codex-config', async () => {
      try {
        return { status: 200, body: this.codexConfig.getConfig(), headers: API_HEADERS };
      } catch (error) {
        return { status: 500, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('GET', '/api/console/codex-models', async () => {
      try {
        const auth = await this.agentAuth.getStatus();
        if (!auth.authenticated) {
          return { status: 409, body: { error: '请先登录 Codex，再刷新模型列表' }, headers: API_HEADERS };
        }
        return { status: 200, body: await this.codexModels.list(), headers: API_HEADERS };
      } catch (error) {
        return { status: 502, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('POST', '/api/console/codex-config', async (body) => {
      try {
        const payload = parseJson<CodexRuntimeConfiguration>(body);
        return {
          status: 200,
          body: this.codexConfig.saveConfig(payload),
          headers: API_HEADERS,
        };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('GET', '/api/console/integrations', async () => {
      if (!this.getMessagingConfiguration) {
        return { status: 503, body: { error: '消息平台服务未初始化' }, headers: API_HEADERS };
      }
      return { status: 200, body: this.getMessagingConfiguration(), headers: API_HEADERS };
    });

    httpServer.register('POST', '/api/console/integrations', async (body) => {
      try {
        if (!this.saveMessagingConfiguration) throw new Error('消息平台服务未初始化');
        const payload = parseJson<{
          platform?: MessagingPlatform;
          enabled?: boolean;
          clientId?: string;
          clientSecret?: string;
          appId?: string;
          appSecret?: string;
        }>(body);
        if (!isMessagingPlatform(payload.platform)) throw new Error('消息平台无效');
        if (typeof payload.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
        const config = normalizeMessagingPayload(payload.platform, payload);
        return {
          status: 200,
          body: await this.saveMessagingConfiguration(payload.platform, config),
          headers: API_HEADERS,
        };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('GET', '/api/console/github', async () => ({
      status: 200,
      body: {
        hasToken: Boolean(this.githubToken),
        connected: Boolean(this.githubConnection),
        tokenSource: this.githubTokenSource,
        createTokenUrl: GITHUB_TOKEN_CREATE_URL,
        requiredPermissions: GITHUB_TOKEN_PERMISSIONS,
        user: this.githubConnection?.user,
        repositoryCount: this.githubConnection?.repositories.length ?? 0,
      },
      headers: API_HEADERS,
    }));

    httpServer.register('POST', '/api/console/github/connect', async (body) => {
      try {
        const payload = parseJson<{ token?: string }>(body);
        const submittedToken = payload.token?.trim();
        if (submittedToken && this.githubTokenSource === 'environment') {
          throw new Error(
            'GitHub Token 由 AGENT_GITHUB_TOKEN 环境变量管理，请更新环境变量并重启服务',
          );
        }
        const token = submittedToken || this.githubToken;
        validateGitHubToken(token);
        const connection = await inspectGitHubAccount(this.githubClientFactory(token!));
        if (submittedToken) {
          this.persistGitHubToken?.(token);
          this.githubTokenSource = 'file';
        }
        this.githubToken = token;
        this.githubConnection = connection;
        this.taskManager.setSecrets({ githubToken: token });
        this.onGitHubTokenConnected?.(token);
        return {
          status: 200,
          body: { ...connection, tokenSource: this.githubTokenSource },
          headers: API_HEADERS,
        };
      } catch (error) {
        return githubErrorResponse(error);
      }
    });

    httpServer.register('GET', '/api/console/github/repositories', async () => {
      try {
        const connection = await this.inspectGitHub();
        return { status: 200, body: connection, headers: API_HEADERS };
      } catch (error) {
        return githubErrorResponse(error);
      }
    });

    httpServer.register('GET', '/api/console/github/branches', async (_body, _headers, query) => {
      try {
        validateGitHubToken(this.githubToken);
        if (!query.repository) {
          throw new Error('repository is required');
        }
        const branches = await this.getGitHubBranches(query.repository);
        return {
          status: 200,
          body: { repository: query.repository, branches },
          headers: API_HEADERS,
        };
      } catch (error) {
        return githubErrorResponse(error);
      }
    });

    httpServer.register('GET', '/api/console/tasks', async () => ({
      status: 200,
      body: { tasks: this.taskManager.list() },
      headers: API_HEADERS,
    }));

    httpServer.register('GET', '/api/console/task', async (_body, _headers, query) => {
      if (!query.id) {
        return { status: 400, body: { error: 'id is required' } };
      }
      const task = this.taskManager.get(query.id);
      return task
        ? { status: 200, body: task, headers: API_HEADERS }
        : { status: 404, body: { error: '任务不存在' }, headers: API_HEADERS };
    });

    httpServer.register('POST', '/api/console/tasks', async (body) => {
      try {
        const payload = parseJson<{
          provider?: CodingAgentProvider;
          providers?: CodingAgentProvider[];
          model?: string;
          repository?: string;
          baseBranch?: string;
          taskBranch?: string;
          prompt?: string;
          createPullRequest?: boolean;
          useFallback?: boolean;
        }>(body);
        const usesLegacySelection = Boolean(
          payload.provider || payload.providers || payload.model !== undefined,
        );
        const task = usesLegacySelection
          ? this.taskManager.create({
              provider: payload.provider,
              providers: payload.providers,
              model: payload.model,
              repository: payload.repository ?? '',
              baseBranch: payload.baseBranch,
              taskBranch: payload.taskBranch,
              prompt: payload.prompt ?? '',
              createPullRequest: payload.createPullRequest,
            })
          : this.createCodingTask({
              repository: payload.repository ?? '',
              baseBranch: payload.baseBranch,
              taskBranch: payload.taskBranch,
              prompt: payload.prompt ?? '',
              createPullRequest: payload.createPullRequest,
              useFallback: payload.useFallback,
            });
        return { status: 202, body: task };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) } };
      }
    });

    httpServer.register('POST', '/api/console/cancel', async (body) => {
      try {
        const payload = parseJson<{ id?: string }>(body);
        if (!payload.id) {
          return { status: 400, body: { error: 'id is required' } };
        }
        return this.taskManager.cancel(payload.id)
          ? { status: 200, body: { success: true } }
          : { status: 409, body: { error: '任务不存在或已结束' } };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) } };
      }
    });
  }

  private loadSettings(): ConsoleSettings {
    if (!existsSync(this.settingsPath)) {
      return structuredClone(DEFAULT_SETTINGS);
    }
    try {
      const stored = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as unknown;
      if (isRecord(stored) && Array.isArray(stored.modelConfigs)) {
        const validated = validateStoredSettings(
          stored.modelConfigs,
          typeof stored.activeConfigurationId === 'string'
            ? stored.activeConfigurationId
            : undefined,
        );
        if (
          stored.version !== 5 ||
          validated.modelConfigs.length !== stored.modelConfigs.length
        ) {
          this.persistSettings(validated);
        }
        return validated;
      }
      const migrated = migrateLegacySettings(stored);
      this.persistSettings(migrated);
      return migrated;
    } catch (error) {
      this.logger.warn(`控制台设置读取失败，使用默认值: ${errorMessage(error)}`);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private assertCodexProvider(provider: unknown): asserts provider is 'codex' {
    if (provider !== 'codex') {
      throw new Error('provider 必须是 codex');
    }
  }

  private updateSettings(payload: SettingsPayload): void {
    if (!Array.isArray(payload.modelConfigs)) {
      throw new Error('modelConfigs 必须是数组');
    }
    const modelConfigs = normalizeModelConfigurationPayloads(payload.modelConfigs);
    const nextSettings: ConsoleSettings = {
      version: 5,
      activeConfigurationId: payload.activeConfigurationId?.trim() || modelConfigs[0].id,
      modelConfigs,
    };
    if (!nextSettings.modelConfigs.some((item) => item.id === nextSettings.activeConfigurationId)) {
      throw new Error('当前配置不存在');
    }
    this.persistSettings(nextSettings);
    this.settings = nextSettings;
  }

  private persistSettings(settings: ConsoleSettings): void {
    writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  private executionConfigurations(useFallback: boolean): AgentModelConfiguration[] {
    const active = this.settings.modelConfigs.find(
      (item) => item.id === this.settings.activeConfigurationId,
    )!;
    const configurations = useFallback
      ? [active, ...this.settings.modelConfigs.filter((item) => item.id !== active.id)]
      : [active];
    return configurations.map((configuration) => ({ ...configuration }));
  }

  private publicSettings(): {
    version: 5;
    activeConfigurationId: string;
    modelConfigs: StoredModelConfiguration[];
  } {
    return {
      version: 5,
      activeConfigurationId: this.settings.activeConfigurationId,
      modelConfigs: this.settings.modelConfigs.map((configuration) => ({ ...configuration })),
    };
  }
}

function findPublicDir(): string {
  const candidates = [resolve(process.cwd(), 'public'), resolve(__dirname, '../../public')];
  const found = candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
  if (!found) {
    throw new Error('找不到控制台静态资源 public/index.html');
  }
  return found;
}

function parseJson<T>(body: Buffer): T {
  try {
    return JSON.parse(body.toString('utf8')) as T;
  } catch {
    throw new Error('请求体必须是有效 JSON');
  }
}

const VALID_PROVIDERS: readonly CodingAgentProvider[] = ['codex'];
const VALID_REASONING_EFFORTS: readonly AgentReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
function createDefaultSettings(): ConsoleSettings {
  return {
    version: 5,
    activeConfigurationId: 'default-codex',
    modelConfigs: [
      {
        id: 'default-codex',
        name: 'Codex 默认配置',
        provider: 'codex',
        reasoningEffort: 'high',
      },
    ],
  };
}

function validateStoredSettings(
  modelConfigs: unknown[],
  activeConfigurationId?: string,
): ConsoleSettings {
  const supported = modelConfigs.filter(
    (configuration) =>
      isRecord(configuration) &&
      VALID_PROVIDERS.includes(configuration.provider as CodingAgentProvider),
  );
  if (supported.length === 0) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  const normalized = normalizeModelConfigurationPayloads(supported as ModelConfigurationPayload[]);
  return {
    version: 5,
    activeConfigurationId: normalized.some((item) => item.id === activeConfigurationId)
      ? activeConfigurationId!
      : normalized[0].id,
    modelConfigs: normalized,
  };
}

function normalizeModelConfigurationPayloads(
  payloads: ModelConfigurationPayload[],
): StoredModelConfiguration[] {
  if (payloads.length === 0) {
    throw new Error('至少需要一条模型配置');
  }
  if (payloads.length > 20) {
    throw new Error('模型配置不能超过 20 条');
  }
  const ids = new Set<string>();
  return payloads.map((payload, index) => {
    const id = payload.id?.trim() || randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`第 ${index + 1} 条模型配置 ID 无效`);
    }
    if (ids.has(id)) {
      throw new Error(`模型配置 ID 重复: ${id}`);
    }
    ids.add(id);
    if (!payload.provider || !VALID_PROVIDERS.includes(payload.provider)) {
      throw new Error(`第 ${index + 1} 条模型配置的 Agent 无效`);
    }
    const name = payload.name?.trim() || `Codex 配置 ${index + 1}`;
    if (name.length > 60 || /[\r\n\0]/.test(name)) {
      throw new Error(`第 ${index + 1} 条配置名称无效`);
    }
    const model = payload.model?.trim() || undefined;
    if (model && !/^[a-zA-Z0-9._:/-]{1,128}$/.test(model)) {
      throw new Error(`第 ${index + 1} 条模型名称无效`);
    }
    const reasoningEffort = payload.reasoningEffort ?? 'high';
    if (!VALID_REASONING_EFFORTS.includes(reasoningEffort)) {
      throw new Error(`第 ${index + 1} 条推理强度无效`);
    }
    return {
      id,
      name,
      provider: payload.provider,
      ...(model ? { model } : {}),
      reasoningEffort,
    };
  });
}

function migrateLegacySettings(stored: unknown): ConsoleSettings {
  if (!isRecord(stored)) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  const fallbackOrder = Array.isArray(stored.fallbackOrder)
    ? stored.fallbackOrder.filter(
        (provider): provider is CodingAgentProvider =>
          typeof provider === 'string' && VALID_PROVIDERS.includes(provider as CodingAgentProvider),
      )
    : [];
  const defaultProvider = VALID_PROVIDERS.includes(stored.defaultProvider as CodingAgentProvider)
    ? (stored.defaultProvider as CodingAgentProvider)
    : 'codex';
  const order = [
    defaultProvider,
    ...fallbackOrder.filter((provider) => provider !== defaultProvider),
  ];
  return validateStoredSettings(
    order.map((provider) => ({
      id: `migrated-${provider}`,
      name: 'Codex 迁移配置',
      provider,
    })),
    `migrated-${defaultProvider}`,
  );
}

function normalizeModelTestPrompt(value: string | undefined): string | undefined {
  const normalized = value?.trim() || undefined;
  if (!normalized) return undefined;
  if (normalized.length > 4000) {
    throw new Error('测试内容不能超过 4000 个字符');
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateGitHubToken(token?: string): asserts token is string {
  if (!token) {
    throw new Error('请先输入 GitHub Token');
  }
  if (token.length > 1024 || /\s/.test(token)) {
    throw new Error('GitHub Token 格式无效');
  }
}

function githubErrorResponse(error: unknown): {
  status: number;
  body: { error: string };
  headers: Record<string, string>;
} {
  const statusCode =
    error && typeof error === 'object' && 'statusCode' in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : 400;
  const status = statusCode >= 400 && statusCode < 500 ? statusCode : 502;
  return { status, body: { error: errorMessage(error) }, headers: API_HEADERS };
}

function normalizeMessagingPayload(
  platform: MessagingPlatform,
  payload: {
    enabled?: boolean;
    clientId?: string;
    clientSecret?: string;
    appId?: string;
    appSecret?: string;
  },
): Partial<DingTalkConfig & FeishuConfig> {
  const enabled = Boolean(payload.enabled);
  if (platform === 'dingtalk') {
    return {
      enabled,
      ...(normalizeCredential(payload.clientId, 'Client ID') ? { clientId: payload.clientId!.trim() } : {}),
      ...(normalizeCredential(payload.clientSecret, 'Client Secret')
        ? { clientSecret: payload.clientSecret!.trim() }
        : {}),
    };
  }
  return {
    enabled,
    ...(normalizeCredential(payload.appId, 'App ID') ? { appId: payload.appId!.trim() } : {}),
    ...(normalizeCredential(payload.appSecret, 'App Secret')
      ? { appSecret: payload.appSecret!.trim() }
      : {}),
  };
}

function normalizeCredential(value: string | undefined, label: string): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 4096 || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${label} 格式无效`);
  }
  return normalized;
}
