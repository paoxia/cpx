import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import type { AgentReasoningEffort } from '../agents/AgentTaskManager';

export interface CodexCatalogModel {
  id: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: AgentReasoningEffort;
  supportedReasoningEfforts: AgentReasoningEffort[];
}

export interface CodexModelCatalogSnapshot {
  models: CodexCatalogModel[];
  fetchedAt: number;
  source: 'codex-cli';
}

export interface CodexModelCatalogReader {
  list(): Promise<CodexModelCatalogSnapshot>;
}

type SpawnCommand = typeof spawn;
const MAX_OUTPUT_LENGTH = 4 * 1024 * 1024;
const EFFORTS = new Set<AgentReasoningEffort>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

/** 读取 Codex 交互式 `/model` 使用的同一模型目录。 */
export class CodexModelCatalog implements CodexModelCatalogReader {
  constructor(
    private readonly spawnCommand: SpawnCommand = spawn,
    private readonly timeoutMs = 20_000,
  ) {}

  async list(): Promise<CodexModelCatalogSnapshot> {
    const result = await this.run();
    if (!result.available) throw new Error('未找到 codex CLI，请重新构建镜像');
    if (result.code !== 0) {
      throw new Error(lastNonEmptyLine(result.output) || 'Codex 模型目录读取失败');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.output);
    } catch {
      throw new Error('Codex CLI 返回了无效的模型目录');
    }
    const models = normalizeCatalog(parsed);
    if (models.length === 0) throw new Error('Codex 当前账号没有返回可选模型');
    return { models, fetchedAt: Date.now(), source: 'codex-cli' };
  }

  private run(): Promise<{ available: boolean; code: number; output: string }> {
    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnCommand('codex', ['debug', 'models'], {
          env: process.env,
          shell: process.platform === 'win32',
          windowsHide: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolve({ available: !message.includes('ENOENT'), code: 1, output: message });
        return;
      }
      let output = '';
      let settled = false;
      const finish = (value: { available: boolean; code: number; output: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const append = (chunk: Buffer | string): void => {
        output = `${output}${String(chunk)}`;
        if (output.length > MAX_OUTPUT_LENGTH) {
          child.kill();
          finish({ available: true, code: 1, output: 'Codex 模型目录超过大小限制' });
        }
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish({ available: true, code: 1, output: '读取 Codex 模型目录超时' });
      }, this.timeoutMs);
      timeout.unref();
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('error', (error) =>
        finish({ available: !error.message.includes('ENOENT'), code: 1, output: error.message }),
      );
      child.once('close', (code) => finish({ available: true, code: code ?? 1, output }));
    });
  }
}

function normalizeCatalog(value: unknown): CodexCatalogModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return [];
  return value.models
    .filter(
      (model): model is Record<string, unknown> =>
        isRecord(model) &&
        typeof model.slug === 'string' &&
        (model.visibility === undefined || model.visibility === 'list'),
    )
    .map((model) => {
      const supported = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
            .map((level) => (isRecord(level) ? level.effort : undefined))
            .filter((effort): effort is AgentReasoningEffort =>
              typeof effort === 'string' && EFFORTS.has(effort as AgentReasoningEffort),
            )
        : [];
      const configuredDefault = model.default_reasoning_level;
      const defaultReasoningEffort =
        typeof configuredDefault === 'string' && EFFORTS.has(configuredDefault as AgentReasoningEffort)
          ? (configuredDefault as AgentReasoningEffort)
          : supported.includes('medium')
            ? 'medium'
            : supported[0] || 'high';
      return {
        id: model.slug as string,
        displayName:
          typeof model.display_name === 'string' ? model.display_name : (model.slug as string),
        description: typeof model.description === 'string' ? model.description : '',
        defaultReasoningEffort,
        supportedReasoningEfforts: supported.length ? supported : [defaultReasoningEffort],
      };
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function lastNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}
