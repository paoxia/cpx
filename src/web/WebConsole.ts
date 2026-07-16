import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { AgentTaskManager, CodingAgentProvider } from '../agents/AgentTaskManager';
import { HttpServer } from '../core/HttpServer';
import { Logger } from '../utils/Logger';

interface ConsoleSettings {
  defaultProvider: CodingAgentProvider;
  codexModel: string;
  claudeModel: string;
}

interface SettingsPayload extends Partial<ConsoleSettings> {
  openaiApiKey?: string;
  anthropicApiKey?: string;
}

const DEFAULT_SETTINGS: ConsoleSettings = {
  defaultProvider: 'codex',
  codexModel: '',
  claudeModel: 'sonnet',
};

const STATIC_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const API_HEADERS = { 'Cache-Control': 'no-store' };

/** 注册开发控制台页面、设置和 Agent 任务 API。 */
export class WebConsole {
  private settings: ConsoleSettings;
  private settingsPath: string;
  private taskManager: AgentTaskManager;
  private logger: Logger;
  private hasOpenaiApiKey = false;
  private hasAnthropicApiKey = false;

  constructor(httpServer: HttpServer, storagePath: string, logger: Logger) {
    this.logger = logger.child('WebConsole');
    const dataDir = resolve(dirname(storagePath));
    this.settingsPath = join(dataDir, 'console-settings.json');
    this.settings = this.loadSettings();
    this.taskManager = new AgentTaskManager(join(dataDir, 'workspaces'), logger);
    this.registerAssets(httpServer);
    this.registerApi(httpServer);
  }

  async stop(): Promise<void> {
    await this.taskManager.stop();
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
          'Cache-Control': asset.route === '/' ? 'no-cache' : 'public, max-age=300',
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
          model?: string;
          repository?: string;
          baseBranch?: string;
          prompt?: string;
          createPullRequest?: boolean;
        }>(body);
        const provider = payload.provider ?? this.settings.defaultProvider;
        const model = payload.model ?? this.modelFor(provider);
        const task = this.taskManager.create({
          provider,
          model,
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
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const stored = JSON.parse(
        readFileSync(this.settingsPath, 'utf8'),
      ) as Partial<ConsoleSettings>;
      return validateSettings({ ...DEFAULT_SETTINGS, ...stored });
    } catch (error) {
      this.logger.warn(`控制台设置读取失败，使用默认值: ${errorMessage(error)}`);
      return { ...DEFAULT_SETTINGS };
    }
  }

  private updateSettings(payload: SettingsPayload): void {
    this.settings = validateSettings({
      ...this.settings,
      ...(payload.defaultProvider ? { defaultProvider: payload.defaultProvider } : {}),
      ...(payload.codexModel !== undefined ? { codexModel: payload.codexModel.trim() } : {}),
      ...(payload.claudeModel !== undefined ? { claudeModel: payload.claudeModel.trim() } : {}),
    });

    const secrets: { openaiApiKey?: string; anthropicApiKey?: string } = {};
    if (payload.openaiApiKey?.trim()) {
      secrets.openaiApiKey = payload.openaiApiKey.trim();
      this.hasOpenaiApiKey = true;
    }
    if (payload.anthropicApiKey?.trim()) {
      secrets.anthropicApiKey = payload.anthropicApiKey.trim();
      this.hasAnthropicApiKey = true;
    }
    this.taskManager.setSecrets(secrets);
    writeFileSync(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
  }

  private modelFor(provider: CodingAgentProvider): string | undefined {
    const value = provider === 'codex' ? this.settings.codexModel : this.settings.claudeModel;
    return value || undefined;
  }

  private publicSettings(): ConsoleSettings & {
    hasOpenaiApiKey: boolean;
    hasAnthropicApiKey: boolean;
  } {
    return {
      ...this.settings,
      hasOpenaiApiKey: this.hasOpenaiApiKey || Boolean(process.env.OPENAI_API_KEY),
      hasAnthropicApiKey: this.hasAnthropicApiKey || Boolean(process.env.ANTHROPIC_API_KEY),
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

function validateSettings(settings: ConsoleSettings): ConsoleSettings {
  if (settings.defaultProvider !== 'codex' && settings.defaultProvider !== 'claude') {
    throw new Error('默认 Agent 必须是 codex 或 claude');
  }
  for (const [name, value] of [
    ['Codex 模型', settings.codexModel],
    ['Claude 模型', settings.claudeModel],
  ] as const) {
    if (value && !/^[a-zA-Z0-9._:/-]+$/.test(value)) {
      throw new Error(`${name}包含不支持的字符`);
    }
  }
  return settings;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
