import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { AgentModelConfiguration, AgentPlatformToolContext } from './AgentTaskManager';
import { AGENT_ADAPTERS } from './agentAdapters';
import { AgentProcessError, classifyAgentError } from './errorClassifier';
import { Logger } from '../utils/Logger';

export interface MessagingCoordinatorRequest {
  scopeId: string;
  prompt: string;
  threadId?: string;
  configurations: AgentModelConfiguration[];
  platformTools: AgentPlatformToolContext;
}

export interface MessagingCoordinatorResult {
  response: string;
  threadId?: string;
}

export interface MessagingCoordinatorRunner {
  run(request: MessagingCoordinatorRequest): Promise<MessagingCoordinatorResult>;
  stop(): Promise<void>;
}

type SpawnCommand = typeof spawn;

const MAX_OUTPUT_LENGTH = 128 * 1024;
const MAX_RESPONSE_LENGTH = 16 * 1024;
const COORDINATOR_PROMPT = `你是 cpx 消息平台的协调 Agent。用户正在通过飞书或钉钉用自然语言操作开发工作台。

工作原则：
- 你当前不在项目仓库中，不要读取或修改本地文件，也不要运行 shell 命令。
- 需要了解 GitHub 仓库或分支时，必须调用 cpx_platform 提供的 GitHub 工具。
- 需要修改代码时，调用 task_create 创建隔离开发任务，把用户的完整需求作为 prompt 传入。
- 仓库不明确时，先查询仓库；仍有多个合理候选时直接向用户追问，不要擅自创建任务。
- 可以用任务工具查询、继续、停止用户在当前平台拥有的任务。
- 不得声称已经执行未通过工具完成的操作。
- 简洁回复；任务创建后告诉用户任务已开始，完成结果会由 cpx 自动推送。

用户消息：`;

/** 在非 Git 目录中运行只读 Codex 协调会话，由受限 MCP 工具执行平台操作。 */
export class MessagingCoordinator implements MessagingCoordinatorRunner {
  private readonly workingDirectory: string;
  private readonly logger: Logger;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(
    workingDirectory: string,
    logger: Logger,
    private readonly spawnCommand: SpawnCommand = spawn,
    private readonly timeoutMs = 90_000,
  ) {
    this.workingDirectory = resolve(workingDirectory);
    this.logger = logger.child('MessagingCoordinator');
    mkdirSync(this.workingDirectory, { recursive: true, mode: 0o700 });
  }

  async run(request: MessagingCoordinatorRequest): Promise<MessagingCoordinatorResult> {
    let lastError: unknown;
    for (const configuration of request.configurations) {
      try {
        return await this.runConfiguration(request, configuration);
      } catch (error) {
        lastError = error;
        const kind = classifyAgentError(error instanceof Error ? error : new Error(String(error)));
        if (kind !== 'auth' && kind !== 'rate_limit') throw error;
        this.logger.warn(
          `协调 Agent 配置 ${configuration.name ?? configuration.id} 不可用，尝试下一项`,
        );
      }
    }
    throw lastError instanceof Error ? lastError : new Error('所有 Codex 配置均不可用');
  }

  async stop(): Promise<void> {
    for (const process of this.processes.values()) process.kill();
    this.processes.clear();
  }

  private runConfiguration(
    request: MessagingCoordinatorRequest,
    configuration: AgentModelConfiguration,
  ): Promise<MessagingCoordinatorResult> {
    const adapter = AGENT_ADAPTERS[configuration.provider];
    const resume = Boolean(request.threadId);
    const args = resume
      ? adapter.buildResumeArgs(
          request.threadId!,
          configuration.model,
          configuration.baseUrl,
          configuration.reasoningEffort,
        )
      : adapter.buildArgs(
          configuration.model,
          configuration.baseUrl,
          configuration.reasoningEffort,
        );
    if (resume) {
      // `--sandbox` belongs to `codex exec`, while `--skip-git-repo-check` is
      // accepted by the `resume` subcommand. Keep each option before the
      // command level that owns it so Clap does not reject the second turn.
      args.splice(1, 0, '--sandbox', 'read-only');
      const resumeIndex = args.indexOf('resume');
      args.splice(resumeIndex + 1, 0, '--skip-git-repo-check');
    } else {
      args.splice(1, 0, '--skip-git-repo-check', '--sandbox', 'read-only');
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    adapter.configureEnvironment(env, configuration.apiKey, configuration.baseUrl);
    configurePlatformTools(args, env, request.platformTools, resume);

    return new Promise((resolvePromise, reject) => {
      let child: ChildProcessWithoutNullStreams;
      let stdout = '';
      let stderr = '';
      let stdoutBuffer = '';
      let threadId = request.threadId;
      let response = '';
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.processes.delete(request.scopeId);
        if (error) {
          reject(error);
          return;
        }
        if (!response.trim()) {
          reject(new Error('Codex 协调会话未返回文本回复'));
          return;
        }
        resolvePromise({
          response: response.trim().slice(0, MAX_RESPONSE_LENGTH),
          ...(threadId ? { threadId } : {}),
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
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.processes.set(request.scopeId, child);

      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error('Codex 协调会话超时'));
      }, this.timeoutMs);
      timeout.unref();

      child.stdout.on('data', (chunk: Buffer | string) => {
        const text = String(chunk);
        stdout = `${stdout}${text}`.slice(-MAX_OUTPUT_LENGTH);
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const event = parseAgentEvent(line);
          if (event.threadId) threadId = event.threadId;
          if (event.response) response = event.response;
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${String(chunk)}`.slice(-MAX_OUTPUT_LENGTH);
      });
      child.once('error', (error) => finish(error));
      child.once('close', (code) => {
        if (settled) return;
        const finalEvent = parseAgentEvent(stdoutBuffer);
        if (finalEvent.threadId) threadId = finalEvent.threadId;
        if (finalEvent.response) response = finalEvent.response;
        if (code !== 0) {
          finish(new AgentProcessError(adapter.command, code, stderr, stdout));
          return;
        }
        finish();
      });
      child.stdin.once('error', (error) => finish(error));
      child.stdin.end(resume ? request.prompt : `${COORDINATOR_PROMPT}\n${request.prompt}`);
    });
  }
}

function configurePlatformTools(
  args: string[],
  env: NodeJS.ProcessEnv,
  context: AgentPlatformToolContext,
  resume: boolean,
): void {
  env.CPX_PLATFORM_TOOL_URL = context.endpoint;
  env.CPX_PLATFORM_TOOL_TOKEN = context.token;
  env.CPX_PLATFORM_TOOL_TASK_ID = context.taskId;
  env.CPX_PLATFORM_NAME = context.platform;

  const server = platformMcpServerCommand();
  const config = [
    `mcp_servers.cpx_platform.command=${JSON.stringify(server.command)}`,
    `mcp_servers.cpx_platform.args=${JSON.stringify(server.args)}`,
    'mcp_servers.cpx_platform.env_vars=["CPX_PLATFORM_TOOL_URL","CPX_PLATFORM_TOOL_TOKEN","CPX_PLATFORM_TOOL_TASK_ID","CPX_PLATFORM_NAME"]',
    'mcp_servers.cpx_platform.default_tools_approval_mode="approve"',
    'mcp_servers.cpx_platform.required=true',
  ];
  const insertionIndex = resume ? Math.max(3, args.length - 2) : Math.max(2, args.length - 1);
  args.splice(insertionIndex, 0, ...config.flatMap((value) => ['--config', value]));
}

function platformMcpServerCommand(): { command: string; args: string[] } {
  const compiled = join(__dirname, 'platformMcpServer.js');
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  const source = join(__dirname, 'platformMcpServer.ts');
  return { command: process.execPath, args: [require.resolve('tsx/cli'), source] };
}

function parseAgentEvent(line: string): { threadId?: string; response?: string } {
  if (!line.trim()) return {};
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const rawThreadId = event.thread_id ?? event.threadId;
    const threadId =
      typeof rawThreadId === 'string' && rawThreadId.trim() ? rawThreadId.trim() : undefined;
    let response: string | undefined;
    if (event.type === 'result' && typeof event.result === 'string') {
      response = event.result.trim() || undefined;
    }
    if (event.type === 'assistant') {
      const message = event.message as
        { content?: Array<{ type?: string; text?: string }> } | undefined;
      response = message?.content
        ?.filter((item) => item.type === 'text' && item.text)
        .map((item) => item.text)
        .join('\n')
        .trim();
    }
    const item = event.item as { type?: string; text?: string } | undefined;
    if (item?.type === 'agent_message' && item.text?.trim()) response = item.text.trim();
    return { ...(threadId ? { threadId } : {}), ...(response ? { response } : {}) };
  } catch {
    return {};
  }
}
