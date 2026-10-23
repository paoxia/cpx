import { Logger } from '../utils/Logger';
import { SkillError } from '../utils/errors';
import { SkillLoader } from './SkillLoader';
import type { GitHubService } from '../github/GitHubService';
import type { MCPManagerLike, SkillContext, SkillResult } from '../core/types';
import { fork } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { join, sep } from 'path';

/**
 * Skill 管理器：编排 Skill 的执行
 */
export class SkillManager {
  private loader: SkillLoader;
  private logger: Logger;
  private githubService?: GitHubService;
  private mcpManager?: MCPManagerLike;
  private executionTimeout: number;
  private executions = new Set<() => void>();

  constructor(
    loader: SkillLoader,
    logger: Logger,
    executionTimeout: number = 30000,
    githubService?: GitHubService,
    mcpManager?: MCPManagerLike,
  ) {
    this.loader = loader;
    this.logger = logger;
    this.executionTimeout = executionTimeout;
    this.githubService = githubService;
    this.mcpManager = mcpManager;
  }

  setGitHubService(githubService: GitHubService): void {
    this.githubService = githubService;
  }

  /** 执行 Skill */
  async execute(
    name: string,
    args: Record<string, unknown>,
    commandId: string,
    readOnly = false,
    scope?: { repository: string; branch?: string },
  ): Promise<SkillResult> {
    const installed = this.loader.getInstalled(name);
    if (!installed) {
      throw new SkillError(`Skill 未安装: ${name}。请先运行 install 命令。`);
    }

    const permissions = installed.manifest.permissions;

    // 构造 context（按权限注入服务）
    const ctx: SkillContext = {
      commandId,
      args,
      logger: this.logger.child(`Skill:${name}`),
    };

    if (permissions.github && this.githubService) {
      ctx.github = this.githubService;
    }
    if (permissions.mcp && this.mcpManager) {
      ctx.mcp = this.mcpManager;
    }

    // 带超时执行
    try {
      const result = await this.executeProcess(
        installed.path,
        installed.manifest.entry,
        ctx,
        readOnly,
        scope,
      );
      return result;
    } catch (err) {
      if (err instanceof SkillError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new SkillError(`Skill ${name} 执行失败: ${message}`);
    }
  }

  stop(): void {
    for (const stop of this.executions) stop();
  }

  private executeProcess(
    directory: string,
    entry: string,
    ctx: SkillContext,
    readOnly: boolean,
    scope?: { repository: string; branch?: string },
  ): Promise<SkillResult> {
    const entryPath = realpathSync(join(directory, entry));
    if (!entryPath.startsWith(`${realpathSync(directory)}${sep}`))
      throw new SkillError('Skill 入口越出安装目录');
    const compiled = join(__dirname, 'skillProcess.js');
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key)) delete env[key];
    return new Promise((resolvePromise, reject) => {
      const child = fork(existsSync(compiled) ? compiled : join(__dirname, 'skillProcess.ts'), [], {
        env,
        cwd: directory,
        execArgv: existsSync(compiled) ? [] : ['--import', require.resolve('tsx')],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: process.platform !== 'win32',
      });
      let ended = false;
      const finish = (error?: Error, result?: SkillResult): void => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        this.executions.delete(stop);
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill();
        } catch {
          child.kill();
        }
        if (error) reject(error);
        else resolvePromise(result!);
      };
      const stop = (): void => finish(new SkillError('Skill 服务已停止'));
      this.executions.add(stop);
      const timer = setTimeout(
        () => finish(new SkillError(`Skill 执行超时（${this.executionTimeout}ms）`)),
        this.executionTimeout,
      );
      let calls = 0;
      child.on(
        'message',
        (message: {
          type: string;
          id?: number;
          service?: string;
          method?: string;
          args?: unknown[];
          result?: SkillResult;
          error?: string;
        }) => {
          if (!message || typeof message !== 'object' || Array.isArray(message)) {
            finish(new SkillError('Skill 消息无效'));
            return;
          }
          if (++calls > 1000 || JSON.stringify(message).length > 1024 * 1024) {
            finish(new SkillError('Skill 消息超过限制'));
            return;
          }
          if (message.type === 'result') {
            if (
              typeof message.result?.success !== 'boolean' ||
              typeof message.result.message !== 'string'
            )
              finish(new SkillError('Skill 结果无效'));
            else finish(undefined, message.result);
          }
          if (message.type === 'failure') finish(new SkillError(message.error ?? 'Skill 失败'));
          if (message.type === 'rpc') {
            void (async () => {
              try {
                const args = message.args ?? [];
                let result: unknown;
                if (
                  message.service === 'github' &&
                  ctx.github &&
                  ['readFile', 'modifyFile', 'createFile', 'createBranch', 'createPR'].includes(
                    message.method ?? '',
                  )
                ) {
                  if (scope) {
                    const repository = String(args[0])
                      .replace(/^https:\/\/github\.com\//, '')
                      .replace(/^git@github\.com:/, '')
                      .replace(/\.git$/, '');
                    const allowed = scope.repository
                      .replace(/^https:\/\/github\.com\//, '')
                      .replace(/^git@github\.com:/, '')
                      .replace(/\.git$/, '');
                    if (repository.toLowerCase() !== allowed.toLowerCase())
                      throw new Error('扩展不能跨项目访问 GitHub');
                    if (message.method === 'createPR' || message.method === 'createBranch')
                      throw new Error('分支与 PR 由任务管理器维护');
                    if (message.method !== 'readFile' && args[3] !== scope.branch)
                      throw new Error('扩展只能修改当前任务分支');
                  }
                  if (readOnly && message.method !== 'readFile')
                    throw new Error('当前项目扩展仅允许只读操作');
                  const branch = ['modifyFile', 'createFile'].includes(message.method!)
                    ? args[3]
                    : message.method === 'createBranch'
                      ? args[1]
                      : undefined;
                  if (
                    typeof branch === 'string' &&
                    ['main', 'master', 'production'].includes(branch)
                  )
                    throw new Error('禁止修改受保护分支');
                  const service = ctx.github as unknown as Record<
                    string,
                    (...params: unknown[]) => Promise<unknown>
                  >;
                  result = await service[message.method!](...args);
                } else if (message.service === 'mcp' && ctx.mcp && message.method === 'call') {
                  if (
                    readOnly &&
                    ![
                      'tools/list',
                      'resources/list',
                      'resources/read',
                      'prompts/list',
                      'prompts/get',
                    ].includes(String(args[1]))
                  )
                    throw new Error('当前项目扩展仅允许只读 MCP 方法');
                  result = await ctx.mcp.call(
                    String(args[0]),
                    String(args[1]),
                    args[2] as Record<string, unknown> | undefined,
                  );
                } else throw new Error('Skill 未获得该能力');
                if (!ended) child.send({ type: 'reply', id: message.id, result });
              } catch {
                if (!ended)
                  child.send({
                    type: 'reply',
                    id: message.id,
                    error: '扩展能力调用失败或未经授权',
                  });
              }
            })();
          }
        },
      );
      child.on('error', (error) => finish(error));
      child.on('exit', () => finish(new SkillError('Skill 子进程提前退出')));
      child.send({
        type: 'start',
        entry: entryPath,
        input: ctx.args,
        commandId: ctx.commandId,
        github: Boolean(ctx.github),
        mcp: Boolean(ctx.mcp),
      });
    });
  }
}
