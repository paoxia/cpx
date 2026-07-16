import { randomUUID } from 'crypto';
import { ConfigManager } from '../config/ConfigManager';
import { Logger } from '../utils/Logger';
import { EventBus } from './EventBus';
import { HttpServer } from './HttpServer';
import { CommandParser } from './CommandParser';
import { CommandRouter } from './CommandRouter';
import { ResponseFormatter } from './ResponseFormatter';
import { DatabaseService } from '../storage/Database';
import { PermissionManager } from '../permissions/PermissionManager';
import { PendingConfirmationStore } from '../permissions/PendingConfirmationStore';
import { AuditLogger } from '../permissions/AuditLogger';
import { DingTalkWebhook } from '../integrations/dingtalk/DingTalkWebhook';
import { DingTalkClient } from '../integrations/dingtalk/DingTalkClient';
import { FeishuWebhook } from '../integrations/feishu/FeishuWebhook';
import { FeishuClient } from '../integrations/feishu/FeishuClient';
import { GitHubClient } from '../github/GitHubClient';
import { GitHubService } from '../github/GitHubService';
import { SkillInstaller } from '../skills/SkillInstaller';
import { SkillLoader } from '../skills/SkillLoader';
import { SkillManager } from '../skills/SkillManager';
import { MCPManager } from '../mcp/MCPManager';
import { WebConsole } from '../web/WebConsole';
import type { AppConfig, Command, CommandResult, CommandSource } from './types';
import type { ParsedUserInfo } from './CommandParser';

const VERSION = '1.0.0';

/**
 * AgentSystem 编排根：装配并管理所有模块的生命周期
 */
export class AgentSystem {
  private config: AppConfig;
  private logger: Logger;
  private configManager: ConfigManager;
  private eventBus: EventBus;
  private httpServer: HttpServer;
  private parser: CommandParser;
  private router: CommandRouter;
  private formatter: ResponseFormatter;
  private database: DatabaseService;
  private permissionManager: PermissionManager;
  private confirmationStore: PendingConfirmationStore;
  private auditLogger: AuditLogger;
  private dingTalkWebhook: DingTalkWebhook;
  private dingTalkClient: DingTalkClient;
  private feishuWebhook: FeishuWebhook;
  private feishuClient: FeishuClient;
  private githubService?: GitHubService;
  private skillInstaller: SkillInstaller;
  private skillLoader: SkillLoader;
  private skillManager: SkillManager;
  private mcpManager: MCPManager;
  private webConsole: WebConsole;
  private running = false;
  private resultPusher?: (source: CommandSource, message: unknown) => Promise<void>;

  constructor(configDir: string = './config') {
    this.configManager = new ConfigManager(configDir);
    this.config = this.configManager.load();
    this.logger = new Logger(this.config.logging.level, this.config.logging.file);
    this.eventBus = new EventBus();
    this.httpServer = new HttpServer(this.config.server.port, this.config.server.host, this.logger);
    this.parser = new CommandParser();
    this.router = new CommandRouter(this.logger);
    this.formatter = new ResponseFormatter();

    // 存储与权限
    this.database = new DatabaseService(this.config.storage.path, this.logger);
    this.confirmationStore = new PendingConfirmationStore(
      this.database,
      this.config.permissions.confirmationTtl,
    );
    this.permissionManager = new PermissionManager(this.config.permissions, this.confirmationStore);
    this.auditLogger = new AuditLogger(this.database);
    this.router.setPermissionChecker((cmd) => this.permissionManager.check(cmd));

    // 钉钉/飞书集成
    this.dingTalkWebhook = new DingTalkWebhook(
      this.config.dingtalk.secret,
      this.config.dingtalk.enableVerify,
      this.logger,
    );
    this.dingTalkClient = new DingTalkClient(this.config.dingtalk.webhookUrl, this.logger);
    this.feishuWebhook = new FeishuWebhook(
      this.config.feishu.appSecret,
      this.config.feishu.enableVerify,
      this.logger,
    );
    this.feishuClient = new FeishuClient(this.config.feishu.webhookUrl, this.logger);

    // GitHub 服务
    if (this.config.github.token) {
      const ghClient = new GitHubClient(this.config.github.token, this.logger);
      this.githubService = new GitHubService(
        ghClient,
        this.logger,
        this.config.github.defaultRepo,
        this.config.github.defaultBranch,
      );
    } else {
      this.logger.warn('GitHub token 未配置，github_* 命令不可用');
    }

    // Skill 系统
    this.skillInstaller = new SkillInstaller(
      this.config.skills.installPath,
      this.database,
      this.logger,
    );
    this.skillLoader = new SkillLoader(this.config.skills.installPath, this.database, this.logger);

    // MCP 服务（在 SkillManager 之前实例化，以便注入）
    this.mcpManager = new MCPManager(this.config.mcp, this.database, this.logger);

    // Web 开发控制台：模型配置、GitHub 工作区和 Codex/Claude Code 任务
    this.webConsole = new WebConsole(this.httpServer, this.config.storage.path, this.logger);

    this.skillManager = new SkillManager(
      this.skillLoader,
      this.logger,
      this.config.skills.executionTimeout,
      this.githubService,
      this.mcpManager,
    );

    // 结果推送器：按来源路由到对应客户端
    this.setResultPusher(async (source, message) => {
      if (source === 'dingtalk') {
        await this.dingTalkClient.push(message as Record<string, unknown>);
      } else if (source === 'feishu') {
        await this.feishuClient.push(message as Record<string, unknown>);
      }
    });

    this.registerBasicHandlers();
    this.registerConfirmationHandlers();
    this.registerGitHubHandlers();
    this.registerSkillHandlers();
    this.registerMcpHandlers();
    this.registerWebhookEndpoints();
    this.registerTestEndpoint();
  }

  /** 设置结果推送回调（由集成层注入） */
  setResultPusher(pusher: (source: CommandSource, message: unknown) => Promise<void>): void {
    this.resultPusher = pusher;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getLogger(): Logger {
    return this.logger;
  }

  getRouter(): CommandRouter {
    return this.router;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getHttpServer(): HttpServer {
    return this.httpServer;
  }

  getDatabase(): DatabaseService {
    return this.database;
  }

  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  /** 处理原始命令文本（webhook 和 CLI 共用入口） */
  async processCommand(rawText: string, userInfo: ParsedUserInfo): Promise<CommandResult> {
    let command: Command;
    try {
      command = this.parser.parse(rawText, userInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`命令解析失败: ${message}`);
      return {
        commandId: randomUUID(),
        success: false,
        message: `命令解析失败: ${message}`,
      };
    }

    this.auditLogger.record({
      action: 'command_received',
      userId: command.userId,
      source: command.source,
      commandId: command.id,
      operation: command.name,
      result: 'success',
    });

    this.eventBus.emit('command:parsed', command);
    const result = await this.router.dispatch(command);

    this.auditLogger.record({
      action: result.success ? 'command_completed' : 'command_failed',
      userId: command.userId,
      source: command.source,
      commandId: command.id,
      operation: command.name,
      result: result.success ? 'success' : 'failure',
      details: result.message,
    });

    if (result.success) {
      this.eventBus.emit('command:completed', result);
    } else {
      this.eventBus.emit('command:failed', result);
    }

    // 推送结果到来源平台
    if (userInfo.source !== 'cli' && this.resultPusher) {
      try {
        const formatted = this.formatter.format(result, userInfo.source);
        await this.resultPusher(userInfo.source, formatted);
      } catch (err) {
        this.logger.error(`结果推送失败: ${(err as Error).message}`);
      }
    }

    return result;
  }

  /** 启动系统 */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('系统已在运行');
      return;
    }
    this.logger.info('Agent System 启动中...');
    this.configManager.startWatching();
    this.configManager.setOnReload(() => {
      this.config = this.configManager.getConfig();
      this.logger.setLevel(this.config.logging.level);
      this.permissionManager.updateConfig(this.config.permissions);
      this.logger.info('权限配置已热更新');
    });
    this.confirmationStore.startExpiryCleanup();
    await this.httpServer.start();
    await this.mcpManager.start();
    this.running = true;
    this.logger.info(`Agent System v${VERSION} 已启动`);
  }

  /** 停止系统 */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.logger.info('Agent System 停止中...');
    this.confirmationStore.stopExpiryCleanup();
    this.configManager.stopWatching();
    await this.webConsole.stop();
    await this.mcpManager.stop();
    await this.httpServer.stop();
    this.eventBus.destroy();
    this.skillLoader.unloadAll();
    this.database.close();
    this.running = false;
    this.logger.info('Agent System 已停止');
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 注册基础命令处理器 */
  private registerBasicHandlers(): void {
    this.router.register('version', async () => ({
      commandId: '',
      success: true,
      message: `Agent System v${VERSION}`,
    }));

    this.router.register('help', async () => ({
      commandId: '',
      success: true,
      message: this.getHelpText(),
    }));
  }

  /** 注册确认/取消命令处理器 */
  private registerConfirmationHandlers(): void {
    this.router.register('confirm', async (command) => {
      const id = command.args.id as string;
      if (!id) {
        return { commandId: command.id, success: false, message: '缺少确认 ID' };
      }
      const result = this.permissionManager.confirm(id, command.userId, command.source);
      if (!result.ok) {
        return { commandId: command.id, success: false, message: result.reason ?? '确认失败' };
      }

      this.auditLogger.record({
        action: 'dangerous_op_confirm',
        userId: command.userId,
        source: command.source,
        operation: result.confirmation!.operation,
        result: 'success',
        details: id,
      });

      // 重派原命令（带 confirmed=true）
      const original = this.confirmationStore.getOriginalCommand(id);
      if (!original) {
        return { commandId: command.id, success: false, message: '无法恢复原命令，请重新发起' };
      }
      original.confirmed = true;
      const dispatchResult = await this.router.dispatch(original);
      return dispatchResult;
    });

    this.router.register('cancel', async (command) => {
      const id = command.args.id as string;
      if (!id) {
        return { commandId: command.id, success: false, message: '缺少确认 ID' };
      }
      const result = this.permissionManager.reject(id, command.userId);
      if (!result.ok) {
        return { commandId: command.id, success: false, message: result.reason ?? '取消失败' };
      }
      this.auditLogger.record({
        action: 'dangerous_op_reject',
        userId: command.userId,
        source: command.source,
        operation: 'cancel',
        result: 'success',
        details: id,
      });
      return { commandId: command.id, success: true, message: `已取消操作 ${id}` };
    });
  }

  /** 注册 Skill 命令处理器 */
  private registerSkillHandlers(): void {
    this.router.register('skill_execute', async (command) => {
      const skillName = command.args.skill as string;
      if (!skillName) {
        return { commandId: command.id, success: false, message: '缺少 Skill 名称' };
      }
      const rest = { ...command.args };
      delete rest.skill;
      try {
        const result = await this.skillManager.execute(skillName, rest, command.id);
        this.auditLogger.record({
          action: 'skill_execute',
          userId: command.userId,
          source: command.source,
          commandId: command.id,
          operation: `execute ${skillName}`,
          result: 'success',
          details: result.message,
        });
        return {
          commandId: command.id,
          success: result.success,
          message: result.message,
          data: result.data,
        };
      } catch (err) {
        return { commandId: command.id, success: false, message: (err as Error).message };
      }
    });

    this.router.register('list_skills', async (command) => {
      const skills = this.skillInstaller.listInstalled();
      if (skills.length === 0) {
        return { commandId: command.id, success: true, message: '尚未安装任何 Skill' };
      }
      const lines = skills.map(
        (s) =>
          `• ${s.manifest.name}@${s.manifest.version} [${s.source}] ${s.loaded ? '(已加载)' : '(未加载)'}`,
      );
      return {
        commandId: command.id,
        success: true,
        message: `已安装 Skill (${skills.length}):\n${lines.join('\n')}`,
      };
    });
  }

  /** 注册 MCP 命令处理器 */
  private registerMcpHandlers(): void {
    this.router.register('list_mcp', async (command) => {
      const conns = this.mcpManager.list();
      if (conns.length === 0) {
        return { commandId: command.id, success: true, message: '尚未连接 MCP' };
      }
      const lines = conns.map(
        (c) => `• ${c.name} [${c.transport}] ${c.status}${c.pid ? ` pid=${c.pid}` : ''}`,
      );
      return {
        commandId: command.id,
        success: true,
        message: `已连接 MCP (${conns.length}):\n${lines.join('\n')}`,
      };
    });

    this.router.register('mcp_call', async (command) => {
      const connectionId = command.args.connectionId as string;
      const method = command.args.method as string;
      if (!connectionId || !method) {
        return { commandId: command.id, success: false, message: '缺少连接标识或方法名' };
      }
      const params = command.args.params as Record<string, unknown> | undefined;
      try {
        const result = await this.mcpManager.call(connectionId, method, params);
        this.auditLogger.record({
          action: 'mcp_call',
          userId: command.userId,
          source: command.source,
          commandId: command.id,
          operation: `call ${connectionId}.${method}`,
          result: 'success',
        });
        return {
          commandId: command.id,
          success: true,
          message: `MCP ${connectionId}.${method} 调用成功`,
          data: result,
        };
      } catch (err) {
        this.auditLogger.record({
          action: 'mcp_call',
          userId: command.userId,
          source: command.source,
          commandId: command.id,
          operation: `call ${connectionId}.${method}`,
          result: 'failure',
          details: (err as Error).message,
        });
        return { commandId: command.id, success: false, message: (err as Error).message };
      }
    });

    this.router.register('mcp_connect', async (command) => {
      const name = command.args.name as string;
      if (!name) {
        return { commandId: command.id, success: false, message: '缺少 MCP 连接名称' };
      }
      // 从已加载的配置中查找
      const cfg = this.config.mcp.connections.find((c) => c.name === name);
      if (!cfg) {
        return { commandId: command.id, success: false, message: `配置中未找到 MCP 连接: ${name}` };
      }
      try {
        const conn = await this.mcpManager.connect(cfg);
        return {
          commandId: command.id,
          success: true,
          message: `已连接 MCP: ${conn.name} (${conn.transport})${conn.pid ? ` pid=${conn.pid}` : ''}`,
        };
      } catch (err) {
        return { commandId: command.id, success: false, message: (err as Error).message };
      }
    });

    this.router.register('mcp_disconnect', async (command) => {
      const id = command.args.id as string;
      if (!id) {
        return { commandId: command.id, success: false, message: '缺少 MCP 连接标识' };
      }
      try {
        await this.mcpManager.disconnect(id);
        return { commandId: command.id, success: true, message: `已断开 MCP: ${id}` };
      } catch (err) {
        return { commandId: command.id, success: false, message: (err as Error).message };
      }
    });
  }

  getSkillInstaller(): SkillInstaller {
    return this.skillInstaller;
  }

  getSkillManager(): SkillManager {
    return this.skillManager;
  }

  getMcpManager(): MCPManager {
    return this.mcpManager;
  }

  /** 注册 GitHub 命令处理器 */
  private registerGitHubHandlers(): void {
    this.router.register('github_read', async (command) => {
      if (!this.githubService) {
        return { commandId: command.id, success: false, message: 'GitHub 未配置（缺少 token）' };
      }
      const file = command.args.file as string;
      const repo = command.args.repo as string | undefined;
      const branch = command.args.branch as string | undefined;
      try {
        const { content } = await this.githubService.readFile(repo ?? '', file, branch);
        return {
          commandId: command.id,
          success: true,
          message: `文件 ${file} 内容：\n\n${content.slice(0, 2000)}${content.length > 2000 ? '\n...(已截断)' : ''}`,
          data: { file, content },
        };
      } catch (err) {
        return { commandId: command.id, success: false, message: (err as Error).message };
      }
    });

    this.router.register('github_modify', async (command) => {
      if (!this.githubService) {
        return { commandId: command.id, success: false, message: 'GitHub 未配置（缺少 token）' };
      }
      const file = command.args.file as string;
      const description = command.args.description as string;
      const repo = command.args.repo as string | undefined;
      const baseBranch = command.args.branch as string | undefined;
      try {
        const { prUrl, branch } = await this.githubService.modifyAndCreatePR(
          file,
          description,
          repo,
          baseBranch,
        );
        this.auditLogger.record({
          action: 'github_op',
          userId: command.userId,
          source: command.source,
          commandId: command.id,
          operation: `modify ${file}`,
          result: 'success',
          details: prUrl,
        });
        return {
          commandId: command.id,
          success: true,
          message: `已修改 ${file} 并创建 PR\n分支: ${branch}`,
          prUrl,
        };
      } catch (err) {
        return { commandId: command.id, success: false, message: (err as Error).message };
      }
    });

    this.router.register('github_create', async (command) => {
      if (!this.githubService) {
        return { commandId: command.id, success: false, message: 'GitHub 未配置（缺少 token）' };
      }
      const file = command.args.file as string;
      const description = command.args.description as string;
      const repo = command.args.repo as string | undefined;
      const baseBranch = command.args.branch as string | undefined;
      try {
        const { prUrl, branch } = await this.githubService.createFileAndPR(
          file,
          description,
          repo,
          baseBranch,
        );
        this.auditLogger.record({
          action: 'github_op',
          userId: command.userId,
          source: command.source,
          commandId: command.id,
          operation: `create ${file}`,
          result: 'success',
          details: prUrl,
        });
        return {
          commandId: command.id,
          success: true,
          message: `已创建 ${file} 并创建 PR\n分支: ${branch}`,
          prUrl,
        };
      } catch (err) {
        return { commandId: command.id, success: false, message: (err as Error).message };
      }
    });
  }

  /** 注册钉钉/飞书 Webhook 端点 */
  private registerWebhookEndpoints(): void {
    // 钉钉 webhook
    this.httpServer.register('POST', '/webhook/dingtalk', async (body, headers) => {
      const timestamp = (headers.timestamp as string) ?? '';
      const sign = (headers.sign as string) ?? '';

      if (!this.dingTalkWebhook.verify(timestamp, sign)) {
        return { status: 403, body: { error: '签名校验失败' } };
      }

      const parsed = this.dingTalkWebhook.parse(body);
      if (!parsed) {
        return { status: 400, body: { error: '无法解析消息' } };
      }

      // 异步处理命令，立即返回 200 防止钉钉重试
      this.processCommand(parsed.text, parsed.userInfo).catch((err) => {
        this.logger.error(`钉钉命令处理异常: ${(err as Error).message}`);
      });
      return { status: 200, body: { success: true } };
    });

    // 飞书 webhook
    this.httpServer.register('POST', '/webhook/feishu', async (body, headers) => {
      // URL 验证（challenge）
      const verification = this.feishuWebhook.isUrlVerification(body);
      if (verification) {
        return { status: 200, body: { challenge: verification.challenge } };
      }

      // 签名校验
      const timestamp = (headers['x-lark-request-timestamp'] as string) ?? '';
      const signature = (headers['x-lark-signature'] as string) ?? '';
      if (!this.feishuWebhook.verify(timestamp, body.toString('utf8'), signature)) {
        return { status: 403, body: { error: '签名校验失败' } };
      }

      const parsed = this.feishuWebhook.parse(body);
      if (!parsed) {
        return { status: 400, body: { error: '无法解析消息' } };
      }

      this.processCommand(parsed.text, parsed.userInfo).catch((err) => {
        this.logger.error(`飞书命令处理异常: ${(err as Error).message}`);
      });
      return { status: 200, body: { success: true } };
    });
  }

  /** 注册测试端点 /command（用于无钉钉/飞书时测试命令管道） */
  private registerTestEndpoint(): void {
    this.httpServer.register('POST', '/command', async (body) => {
      let payload: { text?: string; userId?: string; userName?: string; source?: CommandSource };
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return { status: 400, body: { error: 'Invalid JSON' } };
      }
      if (!payload.text) {
        return { status: 400, body: { error: 'text is required' } };
      }
      const userInfo: ParsedUserInfo = {
        userId: payload.userId ?? 'test-user',
        userName: payload.userName ?? 'Tester',
        source: payload.source ?? 'cli',
      };
      const result = await this.processCommand(payload.text, userInfo);
      return { status: 200, body: result };
    });
  }

  private getHelpText(): string {
    return [
      'Agent System 可用命令：',
      '',
      '• version / 版本 - 查看版本',
      '• help / 帮助 - 显示此帮助',
      '• 修改 <file> <description> - 修改 GitHub 文件并创建 PR',
      '• 新建文件 <file> <description> - 创建 GitHub 文件',
      '• 读取文件 <file> - 读取 GitHub 文件内容',
      '• 执行 <skill> [json] - 执行 Skill 插件',
      '• 调用mcp <连接> <方法> [参数] - 调用 MCP 方法',
      '• 连接mcp <名称> - 连接 MCP 服务',
      '• 断开mcp <标识> - 断开 MCP 连接',
      '• 确认 <id> - 确认危险操作',
      '• 取消 <id> - 取消危险操作',
      '• 列出 skill/mcp/agent - 列出资源',
    ].join('\n');
  }
}
