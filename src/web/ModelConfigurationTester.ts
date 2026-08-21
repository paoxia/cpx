import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { AgentReasoningEffort, CodingAgentProvider } from '../agents/AgentTaskManager';
import { AGENT_ADAPTERS } from '../agents/agentAdapters';
import { AgentProcessError, classifyAgentError } from '../agents/errorClassifier';
import { Logger } from '../utils/Logger';

export interface ModelTestConfiguration {
  provider: CodingAgentProvider;
  model?: string;
  reasoningEffort?: AgentReasoningEffort;
  baseUrl?: string;
  apiKey?: string;
  prompt?: string;
}

export interface ModelConfigurationTestResult {
  success: boolean;
  provider: CodingAgentProvider;
  model?: string;
  message: string;
  response?: string;
  durationMs: number;
}

export interface ModelConfigurationTestRunner {
  test(configuration: ModelTestConfiguration): Promise<ModelConfigurationTestResult>;
}

type SpawnCommand = typeof spawn;

const TEST_PROMPT =
  'Reply with exactly CPX_MODEL_OK. Do not use tools, inspect files, or modify anything.';
const CUSTOM_PROMPT_PREFIX =
  'This is a model configuration conversation test. Do not use tools, inspect files, or modify anything. Reply directly to the user message below.';
const MAX_OUTPUT_LENGTH = 32 * 1024;
const MAX_RESPONSE_LENGTH = 16 * 1024;
const MODEL_TEST_EXTRA_ARGS: Partial<Record<CodingAgentProvider, string[]>> = {
  codex: ['--skip-git-repo-check'],
};

/** 通过与任务执行相同的官方 CLI、模型参数和密钥环境变量验证单条模型配置。 */
export class ModelConfigurationTester implements ModelConfigurationTestRunner {
  private readonly logger: Logger;

  constructor(
    private readonly workingDirectory: string,
    logger: Logger,
    private readonly spawnCommand: SpawnCommand = spawn,
    private readonly timeoutMs = 45_000,
  ) {
    this.logger = logger.child('ModelConfigurationTester');
  }

  test(configuration: ModelTestConfiguration): Promise<ModelConfigurationTestResult> {
    const startedAt = Date.now();
    const adapter = AGENT_ADAPTERS[configuration.provider];
    const env: NodeJS.ProcessEnv = { ...process.env };
    adapter.configureEnvironment(env, configuration.apiKey, configuration.baseUrl);
    const args = adapter.buildArgs(
      configuration.model,
      configuration.baseUrl,
      configuration.reasoningEffort,
    );
    args.splice(1, 0, ...(MODEL_TEST_EXTRA_ARGS[configuration.provider] ?? []));
    const sensitiveValues = Array.from(
      new Set(
        [configuration.apiKey, env[adapter.apiKeyEnvVar], env.OPENAI_API_KEY].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    );

    return new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      let settled = false;
      let output = '';

      const finish = (success: boolean, message: string, response?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const durationMs = Date.now() - startedAt;
        if (success) {
          this.logger.info(`${adapter.displayName} 模型配置测试成功 (${durationMs}ms)`);
        } else {
          this.logger.warn(`${adapter.displayName} 模型配置测试失败 (${durationMs}ms)`);
        }
        resolve({
          success,
          provider: configuration.provider,
          ...(configuration.model ? { model: configuration.model } : {}),
          message,
          ...(response ? { response } : {}),
          durationMs,
        });
      };

      try {
        child = this.spawnCommand(adapter.command, args, {
          cwd: this.workingDirectory,
          env,
          shell: adapter.useShellOnWindows && process.platform === 'win32',
          windowsHide: true,
        });
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        this.logger.warn(`${adapter.displayName} 模型配置测试失败 (${durationMs}ms)`);
        resolve({
          success: false,
          provider: configuration.provider,
          ...(configuration.model ? { model: configuration.model } : {}),
          message: launchErrorMessage(adapter.displayName, error),
          durationMs,
        });
        return;
      }

      const timeout = setTimeout(() => {
        child.kill();
        finish(false, `${adapter.displayName} 测试超时，请检查网络、模型名称和账号状态。`);
      }, this.timeoutMs);
      timeout.unref();

      const append = (chunk: Buffer | string): void => {
        output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT_LENGTH);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.stdin.once('error', (error) =>
        finish(false, launchErrorMessage(adapter.displayName, error)),
      );
      child.once('error', (error) => finish(false, launchErrorMessage(adapter.displayName, error)));
      child.once('close', (code) => {
        if (settled) return;
        if (code === 0 && output.trim()) {
          finish(
            true,
            `${adapter.displayName} 已成功响应，模型配置可用。`,
            extractAgentResponse(output, sensitiveValues),
          );
          return;
        }
        const processError = new AgentProcessError(adapter.command, code, output, output);
        finish(
          false,
          failureMessage(
            adapter.displayName,
            processError,
            sensitiveValues,
            output.trim() ? undefined : 'CLI 未返回响应',
          ),
        );
      });
      const prompt = configuration.prompt?.trim()
        ? `${CUSTOM_PROMPT_PREFIX}\n\nUser message:\n${configuration.prompt.trim()}`
        : TEST_PROMPT;
      child.stdin.end(prompt);
    });
  }
}

function extractAgentResponse(output: string, sensitiveValues: string[]): string | undefined {
  const candidates: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (typeof event.result === 'string' && event.result.trim()) {
        candidates.push(event.result);
      }
      if (typeof event.text === 'string' && event.text.trim()) {
        candidates.push(event.text);
      }
      const item = event.item as { text?: unknown } | undefined;
      if (typeof item?.text === 'string' && item.text.trim()) {
        candidates.push(item.text);
      }
      const message = event.message as
        { content?: Array<{ type?: unknown; text?: unknown }> } | undefined;
      const messageText = message?.content
        ?.filter((content) => content.type === 'text' && typeof content.text === 'string')
        .map((content) => content.text as string)
        .join('\n');
      if (messageText?.trim()) {
        candidates.push(messageText);
      }
    } catch {
      // CLI 使用 JSONL 输出；忽略无法解析的诊断行，避免把内部事件原样返回页面。
    }
  }
  const response = candidates.at(-1);
  return response ? sanitizeResponse(response, sensitiveValues) : undefined;
}

function launchErrorMessage(displayName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found|not recognized|不是内部或外部命令/i.test(message)) {
    return `未找到 ${displayName} CLI，请先在服务运行环境中安装。`;
  }
  return `${displayName} CLI 无法启动：${sanitizeDetail(message)}`;
}

function failureMessage(
  displayName: string,
  error: AgentProcessError,
  sensitiveValues: string[],
  fallbackDetail?: string,
): string {
  const kind = classifyAgentError(error);
  const prefix =
    kind === 'auth'
      ? '鉴权失败，请检查 API Key 或 CLI 登录状态'
      : kind === 'rate_limit'
        ? '额度不足或请求受限，请检查账号额度'
        : `${displayName} 调用失败，请检查 CLI、网络和模型名称`;
  const detail = fallbackDetail || lastNonEmptyLine(error.stderr);
  return detail ? `${prefix}：${sanitizeDetail(detail, sensitiveValues)}` : `${prefix}。`;
}

function lastNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function sanitizeDetail(value: string, sensitiveValues: string[] = []): string {
  const withoutKeys = sensitiveValues.reduce(
    (result, sensitiveValue) => result.split(sensitiveValue).join('[REDACTED]'),
    value,
  );
  return (
    withoutKeys
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 300)
  );
}

function sanitizeResponse(value: string, sensitiveValues: string[]): string {
  const withoutKeys = sensitiveValues.reduce(
    (result, sensitiveValue) => result.split(sensitiveValue).join('[REDACTED]'),
    value,
  );
  const sanitized = withoutKeys
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
  if (sanitized.length <= MAX_RESPONSE_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_RESPONSE_LENGTH)}\n\n[回复已截断]`;
}
