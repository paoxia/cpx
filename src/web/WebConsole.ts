import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join, resolve } from 'path';
import {
  AgentModelConfiguration,
  AgentTaskManager,
  CodingAgentProvider,
} from '../agents/AgentTaskManager';
import { HttpServer } from '../core/HttpServer';
import { GitHubClient } from '../github/GitHubClient';
import { Logger } from '../utils/Logger';
import {
  AgentAuthManager,
  AgentAuthProvider,
  AgentAuthService,
  isAgentAuthProvider,
} from './AgentAuthManager';
import { GitHubClientFactory, GitHubConnection, inspectGitHubAccount } from './GitHubExplorer';
import { ModelConfigurationTester, ModelConfigurationTestRunner } from './ModelConfigurationTester';

interface StoredModelConfiguration {
  id: string;
  provider: CodingAgentProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

interface ConsoleSettings {
  version: 3;
  modelConfigs: StoredModelConfiguration[];
}

interface ModelConfigurationPayload {
  id?: string;
  provider?: CodingAgentProvider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  prompt?: string;
}

interface SettingsPayload {
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
  agentAuth?: Partial<Record<AgentAuthProvider, AgentAuthService>>;
  modelTester?: ModelConfigurationTestRunner;
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
  private agentAuth: Record<AgentAuthProvider, AgentAuthService>;
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
    this.agentAuth = {
      codex: options.agentAuth?.codex ?? new AgentAuthManager('codex', this.logger),
      claude: options.agentAuth?.claude ?? new AgentAuthManager('claude', this.logger),
    };
    this.modelTester = options.modelTester ?? new ModelConfigurationTester(dataDir, this.logger);
    this.registerAssets(httpServer);
    this.registerApi(httpServer);
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.taskManager.stop(),
      ...Object.values(this.agentAuth).map((service) => service.stop()),
    ]);
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
        configuration = normalizeModelConfigurationPayloads(
          [payload],
          this.settings.modelConfigs,
        )[0];
        prompt = normalizeModelTestPrompt(payload.prompt);
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }

      try {
        return {
          status: 200,
          body: await this.modelTester.test({
            provider: configuration.provider,
            ...(configuration.baseUrl ? { baseUrl: configuration.baseUrl } : {}),
            apiKey: configuration.apiKey,
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
        const service = this.agentAuthService(query.provider);
        return { status: 200, body: await service.getStatus(), headers: API_HEADERS };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('POST', '/api/console/agent-auth/login', async (body) => {
      try {
        const payload = parseJson<{ provider?: string }>(body);
        const service = this.agentAuthService(payload.provider);
        return { status: 202, body: await service.startLogin(), headers: API_HEADERS };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('POST', '/api/console/agent-auth/input', async (body) => {
      try {
        const payload = parseJson<{ provider?: string; input?: string }>(body);
        const service = this.agentAuthService(payload.provider);
        return {
          status: 200,
          body: service.submitInput(payload.input ?? ''),
          headers: API_HEADERS,
        };
      } catch (error) {
        return { status: 400, body: { error: errorMessage(error) }, headers: API_HEADERS };
      }
    });

    httpServer.register('POST', '/api/console/agent-auth/cancel', async (body) => {
      try {
        const payload = parseJson<{ provider?: string }>(body);
        const service = this.agentAuthService(payload.provider);
        return service.cancelLogin()
          ? { status: 200, body: { success: true }, headers: API_HEADERS }
          : { status: 409, body: { error: '当前没有进行中的登录' }, headers: API_HEADERS };
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
        validateGitHubToken(this.githubToken);
        const connection = await inspectGitHubAccount(this.githubClientFactory(this.githubToken!));
        this.githubConnection = connection;
        return { status: 200, body: connection, headers: API_HEADERS };
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
          prompt?: string;
          createPullRequest?: boolean;
          useFallback?: boolean;
        }>(body);
        const usesLegacySelection = Boolean(
          payload.provider || payload.providers || payload.model !== undefined,
        );
        const task = this.taskManager.create({
          ...(usesLegacySelection
            ? {
                provider: payload.provider,
                providers: payload.providers,
                model: payload.model,
              }
            : {
                configurations: this.executionConfigurations(payload.useFallback !== false),
              }),
          repository: payload.repository ?? '',
          baseBranch: payload.baseBranch,
          prompt: payload.prompt ?? '',
          createPullRequest: payload.createPullRequest,
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
        const validated = validateStoredSettings(stored.modelConfigs);
        const hadModelOverrides = stored.modelConfigs.some(
          (configuration) =>
            isRecord(configuration) &&
            typeof configuration.model === 'string' &&
            configuration.model.trim().length > 0,
        );
        if (
          stored.version !== 3 ||
          validated.modelConfigs.length !== stored.modelConfigs.length ||
          hadModelOverrides
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

  private agentAuthService(provider: unknown): AgentAuthService {
    if (!isAgentAuthProvider(provider)) {
      throw new Error('provider 必须是 codex 或 claude');
    }
    return this.agentAuth[provider];
  }

  private updateSettings(payload: SettingsPayload): void {
    if (!Array.isArray(payload.modelConfigs)) {
      throw new Error('modelConfigs 必须是数组');
    }
    const nextSettings: ConsoleSettings = {
      version: 3,
      modelConfigs: normalizeModelConfigurationPayloads(
        payload.modelConfigs,
        this.settings.modelConfigs,
      ),
    };
    this.persistSettings(nextSettings);
    this.settings = nextSettings;
  }

  private persistSettings(settings: ConsoleSettings): void {
    writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  private executionConfigurations(useFallback: boolean): AgentModelConfiguration[] {
    const configurations = useFallback
      ? this.settings.modelConfigs
      : this.settings.modelConfigs.slice(0, 1);
    return configurations.map((configuration) => ({
      id: configuration.id,
      provider: configuration.provider,
      ...(configuration.baseUrl ? { baseUrl: configuration.baseUrl } : {}),
      apiKey: configuration.apiKey,
    }));
  }

  private publicSettings(): {
    version: 3;
    modelConfigs: Array<{
      id: string;
      provider: CodingAgentProvider;
      model: string;
      baseUrl: string;
      hasApiKey: boolean;
      apiKeySource: 'file' | 'environment' | 'none';
    }>;
  } {
    return {
      version: 3,
      modelConfigs: this.settings.modelConfigs.map((configuration) => {
        const hasEnvironmentApiKey = Boolean(apiKeyFromEnvironment(configuration.provider));
        return {
          id: configuration.id,
          provider: configuration.provider,
          model: configuration.model,
          baseUrl: configuration.baseUrl ?? '',
          hasApiKey: Boolean(configuration.apiKey) || hasEnvironmentApiKey,
          apiKeySource: configuration.apiKey
            ? 'file'
            : hasEnvironmentApiKey
              ? 'environment'
              : 'none',
        };
      }),
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

const VALID_PROVIDERS: readonly CodingAgentProvider[] = ['codex', 'claude'];
function createDefaultSettings(): ConsoleSettings {
  return {
    version: 3,
    modelConfigs: [
      { id: 'default-codex', provider: 'codex', model: '' },
      { id: 'default-claude', provider: 'claude', model: '' },
    ],
  };
}

function validateStoredSettings(modelConfigs: unknown[]): ConsoleSettings {
  const supported = modelConfigs.filter(
    (configuration) =>
      isRecord(configuration) &&
      (configuration.provider === 'codex' || configuration.provider === 'claude'),
  );
  if (supported.length === 0) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  return {
    version: 3,
    modelConfigs: normalizeModelConfigurationPayloads(
      supported as ModelConfigurationPayload[],
      [],
      true,
    ),
  };
}

function normalizeModelConfigurationPayloads(
  payloads: ModelConfigurationPayload[],
  existing: StoredModelConfiguration[],
  trustStoredApiKeys = false,
): StoredModelConfiguration[] {
  if (payloads.length === 0) {
    throw new Error('至少需要一条模型配置');
  }
  if (payloads.length > 20) {
    throw new Error('模型配置不能超过 20 条');
  }
  const existingById = new Map(existing.map((configuration) => [configuration.id, configuration]));
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
    const baseUrl = normalizeBaseUrl(payload.baseUrl, index);
    const submittedApiKey = payload.apiKey?.trim() || undefined;
    const existingConfiguration = existingById.get(id);
    const apiKey = payload.clearApiKey
      ? undefined
      : submittedApiKey ||
        (existingConfiguration?.provider === payload.provider
          ? existingConfiguration.apiKey
          : undefined);
    if (apiKey && (apiKey.length > 4096 || /\s/.test(apiKey))) {
      throw new Error(`第 ${index + 1} 条 API Key 格式无效`);
    }
    return {
      id,
      provider: payload.provider,
      model: '',
      ...(baseUrl ? { baseUrl } : {}),
      ...(trustStoredApiKeys || submittedApiKey || existingById.has(id) ? { apiKey } : {}),
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
      provider,
      model: '',
    })),
  );
}

function apiKeyFromEnvironment(provider: CodingAgentProvider): string | undefined {
  return {
    codex: process.env.CODEX_API_KEY,
    claude: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  }[provider];
}

function normalizeBaseUrl(value: string | undefined, index: number): string | undefined {
  const normalized = value?.trim().replace(/\/+$/, '') || undefined;
  if (!normalized) return undefined;
  if (normalized.length > 2048) {
    throw new Error(`第 ${index + 1} 条 Base URL 不能超过 2048 个字符`);
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`第 ${index + 1} 条 Base URL 必须是有效的 HTTP(S) 地址`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`第 ${index + 1} 条 Base URL 不能包含凭据或 URL 片段`);
  }
  return normalized;
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
