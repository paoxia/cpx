import { Logger } from '../utils/Logger';
import { SkillError } from '../utils/errors';
import { SkillLoader } from './SkillLoader';
import type { GitHubService } from '../github/GitHubService';
import type { MCPManagerLike, SkillContext, SkillResult } from '../core/types';

/**
 * Skill 管理器：编排 Skill 的执行
 */
export class SkillManager {
  private loader: SkillLoader;
  private logger: Logger;
  private githubService?: GitHubService;
  private mcpManager?: MCPManagerLike;
  private executionTimeout: number;

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
  ): Promise<SkillResult> {
    const installed = this.loader.getInstalled(name);
    if (!installed) {
      throw new SkillError(`Skill 未安装: ${name}。请先运行 install 命令。`);
    }

    const permissions = installed.manifest.permissions;
    const module = this.loader.getModule(name) ?? this.loader.load(name);

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
      const result = await Promise.race([
        module.execute(ctx),
        new Promise<SkillResult>((_, reject) =>
          setTimeout(
            () => reject(new SkillError(`Skill 执行超时（${this.executionTimeout}ms）`)),
            this.executionTimeout,
          ),
        ),
      ]);
      return result;
    } catch (err) {
      if (err instanceof SkillError) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new SkillError(`Skill ${name} 执行失败: ${message}`);
    }
  }
}
