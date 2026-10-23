import type { Project } from '../workbench/Workbench';
import { InstanceLock } from '../workbench/InstanceLock';
import { WorkbenchStore } from '../workbench/Store';
import { AccessControl } from '../workbench/Access';
import { MCPConnectionConfigSchema } from '../config/schema';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { dirname, join, resolve } from 'path';
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
import { MessagingIntegrationManager } from '../integrations/MessagingIntegrationManager';
import { GitHubClient } from '../github/GitHubClient';
import { GitHubService } from '../github/GitHubService';
import { SkillInstaller } from '../skills/SkillInstaller';
import { SkillLoader } from '../skills/SkillLoader';
import { SkillManager } from '../skills/SkillManager';
import { MCPManager } from '../mcp/MCPManager';
import { WebConsole } from '../web/WebConsole';
import type { AgentTask } from '../agents/AgentTaskManager';
import { MessagingCoordinator, MessagingCoordinatorRunner } from '../agents/MessagingCoordinator';
import type { AppConfig, Command, CommandResult, CommandSource } from './types';
import type { ParsedUserInfo } from './CommandParser';
import packageMetadata from '../../package.json';

const VERSION = packageMetadata.version;

interface MessagingTaskOrigin {
  isGroup?: boolean;
  source: CommandSource;
  userId: string;
  userName: string;
  commandId: string;
  replyRouteId?: string;
  platformToolToken?: string;
}

interface MessagingCoordinatorConversation {
  isGroup?: boolean;
  id: string;
  key: string;
  source: 'dingtalk' | 'feishu';
  userId: string;
  userName: string;
  replyRouteId?: string;
  token: string;
  threadId?: string;
  activeCommand?: Command;
  queue: Promise<void>;
}

interface PlatformToolOrigin {
  isGroup?: boolean;
  source: 'dingtalk' | 'feishu';
  userId: string;
  userName: string;
  commandId: string;
  replyRouteId?: string;
  token: string;
  scope: 'task' | 'conversation';
}

export interface AgentSystemOptions {
  messagingCoordinator?: MessagingCoordinatorRunner;
}

const MESSAGING_TASK_CONTROL_COMMANDS = new Set([
  'agent_develop',
  'agent_new',
  'agent_task_continue',
  'agent_task_list',
  'agent_task_status',
  'agent_task_cancel',
  'help',
  'version',
  'confirm',
  'cancel',
]);

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
  private store: WorkbenchStore;
  private access: AccessControl;
  private instanceLock: InstanceLock;
  private permissionManager: PermissionManager;
  private confirmationStore: PendingConfirmationStore;
  private auditLogger: AuditLogger;
  private messagingIntegrations: MessagingIntegrationManager;
  private githubService?: GitHubService;
  private skillInstaller: SkillInstaller;
  private skillLoader: SkillLoader;
  private skillManager: SkillManager;
  private mcpManager: MCPManager;
  private webConsole: WebConsole;
  private messagingCoordinator: MessagingCoordinatorRunner;
  private messagingTaskOrigins = new Map<string, MessagingTaskOrigin>();
  private messagingCoordinatorConversations = new Map<string, MessagingCoordinatorConversation>();
  private messagingCoordinatorScopes = new Map<string, MessagingCoordinatorConversation>();
  private detachedMessagingConversations = new Set<string>();
  private running = false;
  private closed = false;
  private resultPusher?: (
    source: CommandSource,
    userId: string,
    message: unknown,
    replyRouteId?: string,
  ) => Promise<void>;

  constructor(configDir: string = './config', options: AgentSystemOptions = {}) {
    this.configManager = new ConfigManager(configDir);
    this.config = this.configManager.load();
    this.logger = new Logger(this.config.logging.level, this.config.logging.file);
    const dataDir = resolve(dirname(this.config.storage.path));
    this.instanceLock = new InstanceLock(dataDir);
    this.messagingCoordinator =
      options.messagingCoordinator ??
      new MessagingCoordinator(join(dataDir, 'messaging-coordinator'), this.logger);
    this.eventBus = new EventBus();
    this.httpServer = new HttpServer(this.config.server.port, this.config.server.host, this.logger);
    this.parser = new CommandParser();
    this.router = new CommandRouter(this.logger);
    this.formatter = new ResponseFormatter();

    // 存储与权限
    this.database = new DatabaseService(this.config.storage.path, this.logger);
    this.store = new WorkbenchStore(this.database);
    this.access = new AccessControl(this.store, dataDir);
    this.access.attach(this.httpServer, (id) => this.webConsole?.getCodingTask(id));
    this.httpServer.use(async ({ method, path }) => {
      if (method !== 'POST') return;
      const operation =
        path === '/api/console/tasks'
          ? 'agent_develop'
          : path.endsWith('/continue') || path.endsWith('/resume') || path.endsWith('/input-run')
            ? 'agent_task_continue'
            : path.endsWith('/cancel')
              ? 'agent_task_cancel'
              : path.endsWith('/publish')
                ? 'agent_publish'
                : undefined;
      if (operation && this.config.permissions.operations.blacklist.includes(operation))
        return { status: 403, body: { error: '该操作已被权限配置禁止' } };
      return;
    });
    this.confirmationStore = new PendingConfirmationStore(
      this.database,
      this.config.permissions.confirmationTtl,
    );
    this.permissionManager = new PermissionManager(this.config.permissions, this.confirmationStore);
    this.auditLogger = new AuditLogger(this.database);
    this.router.setPermissionChecker((cmd) => this.permissionManager.check(cmd));

    // 钉钉/飞书官方 WebSocket 长连接；不开放平台 HTTP 回调端点。
    this.messagingIntegrations = new MessagingIntegrationManager(
      this.config.dingtalk,
      this.config.feishu,
      this.logger,
      (text, userInfo) => this.processCommand(text, userInfo),
      this.store,
    );

    // GitHub 服务
    if (this.config.github.token) {
      this.activateGitHubToken(this.config.github.token);
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

    // Web 开发控制台：模型配置、GitHub 工作区和 Coding Agent 任务
    this.webConsole = new WebConsole(this.httpServer, this.config.storage.path, this.logger, {
      store: this.store,
      access: this.access,
      fence: () => this.instanceLock.assert(),
      protectedBranches: this.config.permissions.git.protectedBranches,
      extensionEndpoint: this.platformToolEndpoint().replace(
        'agent-platform-tool',
        'task-extension',
      ),
      taskGuard: (action, task) => {
        const identity = this.store.get<{ userId: string }>('identity', task.ownerId ?? '');
        const principal = this.access.account(identity?.userId ?? task.ownerId ?? 'admin');
        if (
          !principal ||
          !this.access.canTask(
            principal,
            task,
            action === 'publish' && task.policy !== 'auto' ? 'publish' : 'write',
          )
        )
          throw new Error('任务身份或项目授权已撤销');
        const operation =
          action === 'publish'
            ? 'agent_publish'
            : task.turns.length > 1
              ? 'agent_task_continue'
              : 'agent_develop';
        if (this.config.permissions.operations.blacklist.includes(operation))
          throw new Error('该任务操作被禁止');
        if (
          action === 'publish' &&
          this.config.permissions.git.protectedBranches.includes(task.agentBranch ?? '')
        )
          throw new Error('禁止推送受保护分支');
      },
      extensions: {
        execute: async (input, task) => {
          const [kind, ...parts] = input.name.split(':');
          const name = parts.join(':');
          if (kind === 'skill')
            return this.skillManager.execute(
              name,
              input.args ?? {},
              task.id,
              task.policy !== 'auto',
              { repository: task.repository, branch: task.agentBranch },
            );
          if (kind === 'mcp') {
            const method = input.method ?? 'tools/list';
            if (
              task.policy !== 'auto' &&
              ![
                'tools/list',
                'resources/list',
                'resources/read',
                'prompts/list',
                'prompts/get',
              ].includes(method)
            )
              throw new Error('扩展只允许只读 MCP 方法');
            return this.mcpManager.call(name, method, input.args);
          }
          throw new Error('扩展名称必须使用 skill: 或 mcp: 前缀');
        },
        list: () => ({
          skills: this.skillInstaller.listInstalled(),
          mcp: this.mcpManager.list().map(({ env: _env, ...connection }) => connection),
          isolation: 'Skills run in supervised subprocesses; this is not an OS security sandbox.',
        }),
        perform: async (input) => {
          const action = z
            .enum(['skill-install', 'skill-uninstall', 'mcp-connect', 'mcp-disconnect'])
            .parse(input.action);
          if (action === 'skill-install')
            return this.skillInstaller.install(
              z.enum(['npm', 'local', 'git']).parse(input.source),
              z.string().min(1).max(2048).parse(input.identifier),
            );
          if (action === 'skill-uninstall') {
            const name = z.string().parse(input.name);
            this.skillLoader.unload(name);
            await this.skillInstaller.uninstall(name);
            return { success: true };
          }
          if (action === 'mcp-connect')
            return this.mcpManager.connect(MCPConnectionConfigSchema.parse(input.config));
          await this.mcpManager.disconnect(z.string().parse(input.name));
          return { success: true };
        },
      },
      githubToken: this.config.github.token,
      githubTokenSource: process.env.AGENT_GITHUB_TOKEN?.trim()
        ? 'environment'
        : this.config.github.token
          ? 'file'
          : 'none',
      persistGitHubToken: (token) => this.configManager.saveGitHubToken(token),
      onGitHubTokenConnected: (token) => this.activateGitHubToken(token),
      getMessagingConfiguration: () => this.messagingIntegrations.getPublicConfiguration(),
      saveMessagingConfiguration: async (platform, next) => {
        if (platform === 'dingtalk') {
          const current = this.config.dingtalk;
          this.config = this.configManager.saveMessagingConfig('dingtalk', {
            ...current,
            enabled: Boolean(next.enabled),
            clientId: next.clientId || current.clientId,
            clientSecret: next.clientSecret || current.clientSecret,
          });
        } else {
          const current = this.config.feishu;
          this.config = this.configManager.saveMessagingConfig('feishu', {
            ...current,
            enabled: Boolean(next.enabled),
            appId: next.appId || current.appId,
            appSecret: next.appSecret || current.appSecret,
          });
        }
        const saved = platform === 'dingtalk' ? this.config.dingtalk : this.config.feishu;
        await this.messagingIntegrations.configure(platform, saved);
        return this.messagingIntegrations.getPublicConfiguration();
      },
    });

    this.skillManager = new SkillManager(
      this.skillLoader,
      this.logger,
      this.config.skills.executionTimeout,
      this.githubService,
      this.mcpManager,
    );

    // 结果推送器：按来源路由到对应客户端
    this.setResultPusher((source, userId, message, replyRouteId) =>
      this.messagingIntegrations.push(source, userId, message, replyRouteId),
    );

    this.registerBasicHandlers();
    this.registerConfirmationHandlers();
    this.registerGitHubHandlers();
    this.registerCodingAgentHandlers();
    this.registerSkillHandlers();
    this.registerMcpHandlers();
    this.registerPlatformToolEndpoint();
    this.registerTestEndpoint();
    for (const task of this.webConsole.listCodingTasks()) {
      if (task.origin) {
        const origin = task.origin as MessagingTaskOrigin;
        this.bindMessagingTask(task, {
          id: origin.commandId,
          source: origin.source,
          userId: origin.userId,
          userName: origin.userName,
          replyRouteId: origin.replyRouteId,
        } as Command);
      }
    }
    this.webConsole.workbench?.setNotifier(async (task) => {
      const origin = task.origin;
      if (!origin || !this.resultPusher || !this.canUseMessagingOrigin(origin))
        throw new Error('无可用或已授权的通知路由');
      const recipient = this.access.chat(origin.source, origin.userId);
      if (!recipient || !this.access.canTask(recipient, task, 'read'))
        throw new Error('通知接收者已失去任务权限');
      const result: CommandResult = {
        commandId: origin.commandId,
        success: ['completed', 'review'].includes(task.status),
        message: `${formatCodingTask(task, true)}\n事件：${task.id}:${task.turns[task.turns.length - 1].id}:${task.recoveryCount ?? 0}:${task.status}`,
        prUrl: task.pullRequestUrl,
      };
      await this.resultPusher(
        origin.source as CommandSource,
        origin.userId,
        this.formatter.format(result, origin.source as CommandSource),
        origin.replyRouteId,
      );
    });
  }

  /** 设置结果推送回调（由集成层注入） */
  setResultPusher(
    pusher: (
      source: CommandSource,
      userId: string,
      message: unknown,
      replyRouteId?: string,
    ) => Promise<void>,
  ): void {
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

  getWebConsole(): WebConsole {
    return this.webConsole;
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

  /** 处理原始命令文本（消息长连接、HTTP 测试和 CLI 共用入口） */
  async processCommand(rawText: string, userInfo: ParsedUserInfo): Promise<CommandResult> {
    if (userInfo.source === 'feishu' || userInfo.source === 'dingtalk') {
      const controlText = this.parser.userText(rawText, userInfo.source).trim();
      if (controlText.startsWith('/bind ')) {
        try {
          this.webConsole.workbench?.bind(controlText.slice(6), userInfo.source, userInfo.userId);
          return this.controlReply(userInfo, {
            commandId: randomUUID(),
            success: true,
            message: '平台身份已绑定',
          });
        } catch {
          return this.controlReply(userInfo, {
            commandId: randomUUID(),
            success: false,
            message: '绑定码无效或已过期',
          });
        }
      }
      const principal = this.access.chat(userInfo.source, userInfo.userId);
      if (
        !principal ||
        (userInfo.isGroup && !principal.allowGroups) ||
        (principal.conversations?.length &&
          !principal.conversations.includes(userInfo.replyRouteId ?? ''))
      )
        return this.controlReply(userInfo, {
          commandId: randomUUID(),
          success: false,
          message: '尚未授权此聊天用户或会话，请联系实例管理员添加平台用户或生成绑定码。',
        });
    }
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
    const eventKey = userInfo.messageId
      ? `${userInfo.source}:${userInfo.userId}:${userInfo.messageId}`
      : undefined;
    if (eventKey) {
      const prior = this.store.get<{ commandId: string; result?: CommandResult }>(
        'message-event',
        eventKey,
      );
      if (prior)
        return (
          prior.result ?? {
            commandId: prior.commandId,
            success: true,
            message: '消息已受理，请查询任务状态；服务中断的协调消息可重新发送。',
          }
        );
      this.store.put('message-event', eventKey, { commandId: command.id, createdAt: Date.now() });
    }
    if (command.source !== 'cli') {
      const principal = this.access.chat(command.source, command.userId);
      const allowed = new Set([
        ...MESSAGING_TASK_CONTROL_COMMANDS,
        'agent_chat',
        'github_overview',
        'github_branches',
      ]);
      if (principal?.role !== 'admin' && !allowed.has(command.name))
        return this.controlReply(userInfo, {
          commandId: command.id,
          success: false,
          message: '该操作仅限管理员；请使用已授权项目的开发任务。',
        });
    }
    command = this.delegateMessagingInputToTask(command);

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
    if (eventKey)
      this.store.put('message-event', eventKey, {
        commandId: command.id,
        result,
        createdAt: Date.now(),
      });

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
        await this.resultPusher(userInfo.source, userInfo.userId, formatted, userInfo.replyRouteId);
      } catch (err) {
        this.logger.error(`结果推送失败: ${(err as Error).message}`);
      }
    }

    return result;
  }

  private async controlReply(
    userInfo: ParsedUserInfo,
    result: CommandResult,
  ): Promise<CommandResult> {
    if (this.resultPusher && userInfo.source !== 'cli') {
      try {
        await this.resultPusher(
          userInfo.source,
          userInfo.userId,
          this.formatter.format(result, userInfo.source),
          userInfo.replyRouteId,
        );
      } catch {
        this.logger.warn('控制消息回复未送达');
      }
    }
    return result;
  }

  /** 启动系统 */
  async start(): Promise<void> {
    if (this.closed) throw new Error('实例已经停止，请创建新的 AgentSystem');
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
      this.webConsole
        .getTaskManager()
        .configure({ protectedBranches: this.config.permissions.git.protectedBranches });
      this.logger.info('权限配置已热更新');
    });
    this.confirmationStore.startExpiryCleanup();
    await this.httpServer.start();
    await this.messagingIntegrations.start();
    await this.mcpManager.start();
    this.webConsole.start();
    this.running = true;
    this.logger.info(`Agent System v${VERSION} 已启动`);
  }

  /** 停止系统 */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.logger.info('Agent System 停止中...');
    this.confirmationStore.stopExpiryCleanup();
    this.configManager.stopWatching();
    await this.webConsole.stop();
    await this.messagingCoordinator.stop();
    await this.messagingIntegrations.stop();
    this.skillManager.stop();
    await this.mcpManager.stop();
    await this.httpServer.stop();
    this.eventBus.destroy();
    this.skillLoader.unloadAll();
    this.database.close();
    this.instanceLock.release();
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

    this.router.register('help', async (command) => ({
      commandId: command.id,
      success: true,
      message: this.getHelpText(command.source),
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

  private activateGitHubToken(token: string): void {
    const ghClient = new GitHubClient(token, this.logger);
    this.githubService = new GitHubService(
      ghClient,
      this.logger,
      this.config.github.defaultRepo,
      this.config.github.defaultBranch,
    );
    this.skillManager?.setGitHubService(this.githubService);
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

  /** 注册钉钉/飞书可用的 GitHub 查询与 Coding Agent 开发命令。 */
  private registerCodingAgentHandlers(): void {
    this.router.register('github_overview', async (command) => {
      try {
        const connection = await this.webConsole.inspectGitHub();
        const accessible = connection.repositories.filter((repo) =>
          this.canAccessRepository(repo.fullName, command),
        );
        const repositories = accessible.slice(0, 15);
        const lines = repositories.map((repository) => {
          const visibility = repository.private ? '私有' : '公开';
          return `• ${repository.fullName} [${visibility}] 默认分支: ${repository.defaultBranch}`;
        });
        const remaining =
          accessible.length > repositories.length
            ? `\n其余 ${accessible.length - repositories.length} 个仓库请在 Web 控制台查看。`
            : '';
        return {
          commandId: command.id,
          success: true,
          message: [
            `GitHub 已连接：${connection.user.login}`,
            `可访问仓库：${accessible.length} 个`,
            '',
            lines.join('\n') || '当前 Token 没有可访问的仓库。',
            remaining,
            '',
            '查看分支：查看分支 owner/repo',
            '发起开发：开发 owner/repo#基础分支 需求',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        };
      } catch (error) {
        return {
          commandId: command.id,
          success: false,
          message: `GitHub 查询失败：${errorMessage(error)}`,
        };
      }
    });

    this.router.register('github_branches', async (command) => {
      const repository = command.args.repository as string;
      try {
        if (!this.canAccessRepository(repository, command)) throw new Error('无权访问此项目');
        const branches = await this.webConsole.getGitHubBranches(repository);
        const visible = branches.slice(0, 40);
        const lines = visible.map(
          (branch) => `• ${branch.name}${branch.protected ? '（受保护）' : ''}`,
        );
        const remaining =
          branches.length > visible.length
            ? `\n其余 ${branches.length - visible.length} 个分支已省略。`
            : '';
        return {
          commandId: command.id,
          success: true,
          message: `${repository} 的分支（${branches.length}）：\n${lines.join('\n')}${remaining}`,
        };
      } catch (error) {
        return {
          commandId: command.id,
          success: false,
          message: `分支查询失败：${errorMessage(error)}`,
        };
      }
    });

    this.router.register('agent_develop', async (command) => {
      return this.createMessagingDevelopmentTask(
        command,
        command.args.repository as string,
        command.args.baseBranch as string | undefined,
        command.args.taskBranch as string | undefined,
        command.args.prompt as string,
      );
    });

    this.router.register('agent_new', async (command) => {
      if (command.source !== 'dingtalk' && command.source !== 'feishu') {
        return { commandId: command.id, success: false, message: '该入口仅供消息平台使用。' };
      }
      const key = messagingConversationKey(command);
      this.detachedMessagingConversations.add(key);
      this.store.put('detached-conversation', key, { detached: true });
      this.store.remove('coordinator', key);
      const previous = this.messagingCoordinatorConversations.get(key);
      if (previous) {
        this.messagingCoordinatorConversations.delete(key);
      }
      return {
        commandId: command.id,
        success: true,
        message: '已开始新的对话。直接描述你想完成的事情，Codex 会选择仓库并创建任务。',
      };
    });

    this.router.register('agent_task_continue', async (command) => {
      const task = this.ownedMessagingTask(command.args.id as string, command);
      if (!task) {
        return {
          commandId: command.id,
          success: false,
          message: '任务不存在，或不是你在当前平台创建的任务。',
        };
      }
      return this.continueMessagingTask(command, task, command.args.prompt as string);
    });

    this.router.register('agent_chat', async (command) => {
      const prompt = command.args.prompt as string;
      const task = this.latestMessagingTask(command);
      if (task && isTerminalCodingTask(task)) {
        return this.continueMessagingTask(command, task, prompt);
      }
      if (task) {
        const actor = this.access.chat(command.source, command.userId);
        if (!actor || !this.access.canTask(actor, task, 'write'))
          return { commandId: command.id, success: false, message: '当前身份无权向任务追加要求' };
        const inputId = this.webConsole.getTaskManager().queueInput(task.id, prompt);
        return {
          commandId: command.id,
          success: true,
          message: `要求已保存为待处理消息 ${inputId.slice(0, 8)}，本轮结束后可在任务页执行或撤回。`,
        };
      }
      return this.enqueueMessagingCoordinator(command, prompt);
    });

    this.router.register('agent_task_list', async (command) => {
      const requestedLimit = Number(command.args.limit ?? 5);
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(10, Math.floor(requestedLimit)))
        : 5;
      const tasks = this.webConsole
        .listCodingTasks()
        .filter((task) => this.isMessagingTaskOwner(task.id, command))
        .slice(0, limit);
      if (tasks.length === 0) {
        return {
          commandId: command.id,
          success: true,
          message: '你还没有通过当前平台创建 Coding Agent 任务。',
        };
      }
      return {
        commandId: command.id,
        success: true,
        message: `最近任务：\n${tasks
          .map(
            (task) =>
              `• ${shortTaskId(task.id)} [${codingTaskStatusLabel(task.status)}] ${displayRepository(task.repository)}#${task.baseBranch ?? '默认分支'}`,
          )
          .join('\n')}\n\n查看详情：任务 <ID>`,
      };
    });

    this.router.register('agent_task_status', async (command) => {
      const reference = command.args.id as string | undefined;
      const task = reference
        ? this.ownedMessagingTask(reference, command)
        : this.mostRecentOwnedMessagingTask(command);
      if (!task) {
        return {
          commandId: command.id,
          success: false,
          message: '任务不存在，或不是你在当前平台创建的任务。',
        };
      }
      return {
        commandId: command.id,
        success: task.status !== 'failed',
        message: formatCodingTask(task),
        prUrl: task.pullRequestUrl,
      };
    });

    this.router.register('agent_task_cancel', async (command) => {
      const reference = command.args.id as string | undefined;
      const task = reference
        ? this.ownedMessagingTask(reference, command)
        : this.mostRecentOwnedMessagingTask(command);
      if (!task) {
        return {
          commandId: command.id,
          success: false,
          message: '任务不存在，或不是你在当前平台创建的任务。',
        };
      }
      const actor =
        command.source === 'cli'
          ? this.access.account('admin')
          : this.access.chat(command.source, command.userId);
      if (!actor || !this.access.canTask(actor, task, 'write'))
        return { commandId: command.id, success: false, message: '当前身份无权停止该任务' };
      if (!this.webConsole.cancelCodingTask(task.id)) {
        return {
          commandId: command.id,
          success: false,
          message: `任务 ${shortTaskId(task.id)} 已结束，无法取消。`,
        };
      }
      return {
        commandId: command.id,
        success: true,
        message: `已取消 Coding Agent 任务 ${shortTaskId(task.id)}。`,
      };
    });
  }

  private async createMessagingDevelopmentTask(
    command: Command,
    repository: string,
    requestedBaseBranch: string | undefined,
    taskBranch: string | undefined,
    prompt: string,
    createPullRequest = true,
  ): Promise<CommandResult> {
    try {
      if (!this.canAccessRepository(repository, command)) throw new Error('无权访问此项目');
      const connection = await this.webConsole.inspectGitHub();
      const selectedRepository = connection.repositories.find(
        (candidate) => candidate.fullName.toLowerCase() === repository.toLowerCase(),
      );
      if (!selectedRepository) {
        throw new Error(`当前 GitHub Token 无权访问仓库 ${repository}`);
      }
      if (selectedRepository.archived) {
        throw new Error(`仓库 ${repository} 已归档，不能创建开发任务`);
      }

      const baseBranch = requestedBaseBranch ?? selectedRepository.defaultBranch;
      const branches = await this.webConsole.getGitHubBranches(selectedRepository.fullName);
      if (!branches.some((branch) => branch.name === baseBranch)) {
        throw new Error(`基础分支 ${baseBranch} 不存在`);
      }
      if (taskBranch && branches.some((branch) => branch.name === taskBranch)) {
        throw new Error(`新分支 ${taskBranch} 已存在`);
      }

      const task = this.webConsole.createCodingTask({
        idempotencyKey: command.id,
        repository: selectedRepository.fullName,
        ownerId: this.access.chat(command.source, command.userId)?.id ?? 'admin',
        baseBranch,
        taskBranch,
        prompt,
        createPullRequest,
        useFallback: true,
      });
      this.bindMessagingTask(task, command);
      this.auditLogger.record({
        action: 'agent_delegate',
        userId: command.userId,
        source: command.source,
        commandId: command.id,
        operation: `develop ${selectedRepository.fullName}`,
        result: 'success',
        details: task.id,
      });
      if (command.source !== 'cli') {
        void this.pushCodingTaskCompletion(task.id);
      }

      return {
        commandId: command.id,
        success: true,
        message: [
          `Coding Agent 任务已创建：${shortTaskId(task.id)}`,
          `仓库：${selectedRepository.fullName}`,
          `基础分支：${baseBranch}`,
          `任务分支：${taskBranch ?? '自动创建'}`,
          '后续可直接发送自然语言，继续修改同一个工作区。',
          `查询进度：任务 ${shortTaskId(task.id)}`,
        ].join('\n'),
        data: { taskId: task.id },
      };
    } catch (error) {
      return {
        commandId: command.id,
        success: false,
        message: `开发任务创建失败：${errorMessage(error)}`,
      };
    }
  }

  private continueMessagingTask(command: Command, task: AgentTask, prompt: string): CommandResult {
    try {
      const actor =
        command.source === 'cli'
          ? this.access.account('admin')
          : this.access.chat(command.source, command.userId);
      if (!actor || !this.access.canTask(actor, task, 'write'))
        throw new Error('当前身份无权继续该任务');
      const continued = this.webConsole.continueCodingTask(task.id, prompt, true);
      this.bindMessagingTask(continued, command);
      this.auditLogger.record({
        action: 'agent_delegate',
        userId: command.userId,
        source: command.source,
        commandId: command.id,
        operation: `continue ${continued.id}`,
        result: 'success',
        details: `turn ${continued.turns.length}`,
      });
      if (command.source !== 'cli') {
        void this.pushCodingTaskCompletion(continued.id);
      }
      return {
        commandId: command.id,
        success: true,
        message: [
          `已向任务 ${shortTaskId(continued.id)} 追加第 ${continued.turns.length} 轮指令。`,
          '继续使用原工作区和 Codex 会话，完成后会自动推送结果。',
        ].join('\n'),
        data: { taskId: continued.id, turn: continued.turns.length },
      };
    } catch (error) {
      return {
        commandId: command.id,
        success: false,
        message: `无法继续任务：${errorMessage(error)}`,
      };
    }
  }

  private enqueueMessagingCoordinator(command: Command, prompt: string): CommandResult {
    if (command.source !== 'dingtalk' && command.source !== 'feishu') {
      return {
        commandId: command.id,
        success: false,
        message: '自然语言协调会话仅支持飞书和钉钉。',
      };
    }
    const key = messagingConversationKey(command);
    let conversation = this.messagingCoordinatorConversations.get(key);
    if (!conversation) {
      const saved = this.store.get<{ threadId?: string }>('coordinator', key);
      conversation = {
        threadId: saved?.threadId,
        isGroup: command.isGroup,
        id: randomUUID(),
        key,
        source: command.source,
        userId: command.userId,
        userName: command.userName,
        ...(command.replyRouteId ? { replyRouteId: command.replyRouteId } : {}),
        token: randomUUID(),
        queue: Promise.resolve(),
      };
      this.messagingCoordinatorConversations.set(key, conversation);
      this.messagingCoordinatorScopes.set(conversation.id, conversation);
    }
    const queuedConversation = conversation;
    queuedConversation.queue = queuedConversation.queue
      .then(() => this.runMessagingCoordinatorTurn(queuedConversation, command, prompt))
      .catch((error) => {
        this.logger.error(`消息平台协调会话失败: ${errorMessage(error)}`);
      });

    return {
      commandId: command.id,
      success: true,
      message: 'Codex 已收到你的消息，正在理解需求并调用所需的平台能力。',
      data: { coordinatorId: conversation.id },
    };
  }

  private async runMessagingCoordinatorTurn(
    conversation: MessagingCoordinatorConversation,
    command: Command,
    prompt: string,
  ): Promise<void> {
    conversation.activeCommand = command;
    let result: CommandResult;
    try {
      const response = await this.messagingCoordinator.run({
        scopeId: conversation.id,
        prompt,
        ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
        configurations: this.webConsole.getAgentExecutionConfigurations(true),
        platformTools: {
          endpoint: this.platformToolEndpoint(),
          token: conversation.token,
          taskId: conversation.id,
          platform: conversation.source,
        },
      });
      conversation.threadId = response.threadId ?? conversation.threadId;
      this.store.put('coordinator', conversation.key, { threadId: conversation.threadId });
      result = { commandId: command.id, success: true, message: response.response };
      this.auditLogger.record({
        action: 'agent_delegate',
        userId: command.userId,
        source: command.source,
        commandId: command.id,
        operation: `coordinate ${conversation.id}`,
        result: 'success',
      });
    } catch (error) {
      result = {
        commandId: command.id,
        success: false,
        message: `Codex 协调会话失败：${errorMessage(error)}`,
      };
      this.auditLogger.record({
        action: 'agent_delegate',
        userId: command.userId,
        source: command.source,
        commandId: command.id,
        operation: `coordinate ${conversation.id}`,
        result: 'failure',
        details: errorMessage(error),
      });
    } finally {
      conversation.activeCommand = undefined;
      if (this.messagingCoordinatorConversations.get(conversation.key)?.id !== conversation.id) {
        this.messagingCoordinatorScopes.delete(conversation.id);
      }
    }

    if (!this.resultPusher || !this.canUseMessagingOrigin(conversation)) return;
    try {
      await this.resultPusher(
        conversation.source,
        conversation.userId,
        this.formatter.format(result, conversation.source),
        conversation.replyRouteId,
      );
    } catch (error) {
      this.logger.error(`Codex 协调回复推送失败: ${errorMessage(error)}`);
    }
  }

  private bindMessagingTask(task: AgentTask, command: Command): void {
    const existing = this.messagingTaskOrigins.get(task.id);
    const platformToolToken =
      command.source === 'dingtalk' || command.source === 'feishu' ? randomUUID() : undefined;
    const origin: MessagingTaskOrigin = {
      source: existing?.source ?? command.source,
      userId: existing?.userId ?? command.userId,
      userName: existing?.userName ?? command.userName,
      commandId: command.id,
      isGroup: existing?.isGroup ?? command.isGroup,
      ...(existing?.replyRouteId || command.replyRouteId
        ? { replyRouteId: existing?.replyRouteId ?? command.replyRouteId }
        : {}),
      ...(platformToolToken ? { platformToolToken } : {}),
    };
    this.messagingTaskOrigins.set(task.id, origin);
    this.webConsole.bindCodingTask(task.id, origin);
    this.detachedMessagingConversations.delete(messagingConversationKey(command));
    this.store.remove('detached-conversation', messagingConversationKey(command));
    if (platformToolToken && (command.source === 'dingtalk' || command.source === 'feishu')) {
      this.webConsole.setCodingTaskPlatformTools(task.id, {
        endpoint: this.platformToolEndpoint(),
        token: platformToolToken,
        taskId: task.id,
        platform: command.source,
      });
    }
  }

  private delegateMessagingInputToTask(command: Command): Command {
    if (
      command.source === 'cli' ||
      command.name === 'agent_chat' ||
      MESSAGING_TASK_CONTROL_COMMANDS.has(command.name) ||
      !this.latestMessagingTask(command)
    ) {
      return command;
    }
    return {
      ...command,
      name: 'agent_chat',
      args: { prompt: this.parser.userText(command.rawText, command.source) },
    };
  }

  private platformToolEndpoint(): string {
    const configuredHost = this.config.server.host.trim();
    const host =
      configuredHost === '0.0.0.0'
        ? '127.0.0.1'
        : configuredHost === '::'
          ? '[::1]'
          : configuredHost.includes(':') && !configuredHost.startsWith('[')
            ? `[${configuredHost}]`
            : configuredHost;
    return `http://${host}:${this.config.server.port}/api/internal/agent-platform-tool`;
  }

  private registerPlatformToolEndpoint(): void {
    this.httpServer.register('POST', '/api/internal/agent-platform-tool', async (body, headers) => {
      let payload: { taskId?: string; tool?: string; args?: Record<string, unknown> };
      try {
        payload = JSON.parse(body.toString('utf8')) as typeof payload;
      } catch {
        return { status: 400, body: { error: 'Invalid JSON' } };
      }
      const origin = payload.taskId ? this.platformToolOrigin(payload.taskId) : undefined;
      const authorization = Array.isArray(headers.authorization)
        ? headers.authorization[0]
        : headers.authorization;
      if (
        !origin?.token ||
        !this.canUseMessagingOrigin(origin) ||
        authorization !== `Bearer ${origin.token}`
      ) {
        return { status: 401, body: { error: 'Unauthorized' } };
      }

      try {
        const result = await this.executePlatformTool(
          payload.taskId!,
          payload.tool ?? '',
          payload.args ?? {},
          origin,
        );
        this.auditLogger.record({
          action: 'agent_platform_tool',
          userId: origin.userId,
          source: origin.source,
          commandId: origin.commandId,
          operation: payload.tool ?? 'unknown',
          result: 'success',
          details: `${origin.scope} ${payload.taskId}`,
        });
        return { status: 200, body: { result } };
      } catch (error) {
        this.auditLogger.record({
          action: 'agent_platform_tool',
          userId: origin.userId,
          source: origin.source,
          commandId: origin.commandId,
          operation: payload.tool ?? 'unknown',
          result: 'failure',
          details: errorMessage(error),
        });
        return { status: 400, body: { error: errorMessage(error) } };
      }
    });
  }

  private platformToolOrigin(scopeId: string): PlatformToolOrigin | undefined {
    const task = this.messagingTaskOrigins.get(scopeId);
    if (task?.platformToolToken && (task.source === 'dingtalk' || task.source === 'feishu')) {
      return {
        source: task.source,
        userId: task.userId,
        userName: task.userName,
        commandId: task.commandId,
        ...(task.replyRouteId ? { replyRouteId: task.replyRouteId } : {}),
        token: task.platformToolToken,
        isGroup: task.isGroup,
        scope: 'task',
      };
    }
    const conversation = this.messagingCoordinatorScopes.get(scopeId);
    if (!conversation?.activeCommand) return undefined;
    return {
      source: conversation.source,
      userId: conversation.userId,
      userName: conversation.userName,
      commandId: conversation.activeCommand.id,
      ...(conversation.replyRouteId ? { replyRouteId: conversation.replyRouteId } : {}),
      token: conversation.token,
      isGroup: conversation.isGroup,
      scope: 'conversation',
    };
  }

  private async executePlatformTool(
    scopeId: string,
    tool: string,
    args: Record<string, unknown>,
    origin: PlatformToolOrigin,
  ): Promise<unknown> {
    const command = platformToolCommand(origin, tool, args);
    if (this.config.permissions.operations.blacklist.includes(tool))
      throw new Error('该工具操作被禁止');
    if (
      origin.scope === 'task' &&
      ['platform_send_message', 'task_create', 'task_continue', 'task_cancel'].includes(tool) &&
      this.webConsole.getCodingTask(scopeId)?.status !== 'running'
    )
      throw new Error('任务工具写权限已结束');
    if (tool === 'platform_get_context') {
      return {
        platform: origin.source,
        scope: origin.scope,
        scopeId,
        conversationBound: true,
        defaultRepository: this.config.github.defaultRepo || null,
        capabilities: [
          'platform_send_message',
          'github_list_repositories',
          'github_list_branches',
          'task_create',
          'task_list',
          'task_status',
          'task_continue',
          'task_cancel',
        ],
      };
    }
    if (tool === 'platform_send_message') {
      const text = args.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 6000) {
        throw new Error('text must contain 1 to 6000 characters');
      }
      if (!this.resultPusher) throw new Error('Platform result pusher is unavailable');
      await this.resultPusher(
        origin.source,
        origin.userId,
        platformTextMessage(origin.source, text.trim()),
        origin.replyRouteId,
      );
      return '消息已发送到当前绑定的原会话。';
    }
    if (tool === 'github_list_repositories') {
      const connection = await this.webConsole.inspectGitHub();
      return {
        user: connection.user.login,
        defaultRepository: this.config.github.defaultRepo || null,
        repositories: connection.repositories
          .filter((repo) => this.canAccessRepository(repo.fullName, command))
          .slice(0, 100)
          .map((repository) => ({
            name: repository.fullName,
            private: repository.private,
            archived: repository.archived,
            defaultBranch: repository.defaultBranch,
            description: repository.description,
          })),
      };
    }
    if (tool === 'github_list_branches') {
      const repository = requiredString(args.repository, 'repository');
      if (!this.canAccessRepository(repository, command)) throw new Error('无权访问此项目');
      return {
        repository,
        branches: (await this.webConsole.getGitHubBranches(repository)).slice(0, 200),
      };
    }
    if (tool === 'task_create') {
      const result = await this.createMessagingDevelopmentTask(
        command,
        requiredString(args.repository, 'repository'),
        optionalString(args.baseBranch),
        optionalString(args.taskBranch),
        requiredString(args.prompt, 'prompt'),
        args.createPullRequest === undefined ? true : Boolean(args.createPullRequest),
      );
      if (!result.success) throw new Error(result.message);
      return { message: result.message, data: result.data };
    }
    if (tool === 'task_list') {
      const requested = typeof args.limit === 'number' ? args.limit : 5;
      const limit = Math.max(1, Math.min(10, Math.floor(requested)));
      return this.webConsole
        .listCodingTasks()
        .filter((task) => this.isMessagingTaskOwner(task.id, command))
        .slice(0, limit)
        .map(platformTaskSummary);
    }
    const taskId = requiredString(args.taskId, 'taskId');
    const task = this.ownedMessagingTask(taskId, command);
    if (!task) throw new Error('任务不存在，或不属于当前平台用户');
    if (tool === 'task_status') return platformTaskSummary(task);
    if (tool === 'task_continue') {
      const result = this.continueMessagingTask(
        command,
        task,
        requiredString(args.prompt, 'prompt'),
      );
      if (!result.success) throw new Error(result.message);
      return { message: result.message, data: result.data };
    }
    if (tool === 'task_cancel') {
      const actor = this.access.chat(command.source, command.userId);
      if (!actor || !this.access.canTask(actor, task, 'write'))
        throw new Error('当前身份无权停止该任务');
      if (!this.webConsole.cancelCodingTask(task.id)) throw new Error('任务已结束，无法停止');
      return `已停止任务 ${shortTaskId(task.id)}。`;
    }
    throw new Error(`Unsupported platform tool: ${tool}`);
  }

  private canUseMessagingOrigin(origin: {
    source: string;
    userId: string;
    isGroup?: boolean;
    replyRouteId?: string;
  }): boolean {
    if (origin.source === 'cli') return true;
    const account = this.access.chat(origin.source, origin.userId);
    return Boolean(
      account &&
      (!origin.isGroup || account.allowGroups) &&
      (!account.conversations?.length || account.conversations.includes(origin.replyRouteId ?? '')),
    );
  }

  private canAccessRepository(
    repository: string,
    command: Pick<Command, 'source' | 'userId'>,
  ): boolean {
    if (command.source === 'cli') return true;
    const principal = this.access.chat(command.source, command.userId);
    if (!principal) return false;
    if (principal.role === 'admin') return true;
    return this.store
      .list<Project>('project')
      .some(
        (project) =>
          displayRepository(project.repository).toLowerCase() ===
            displayRepository(repository).toLowerCase() &&
          this.access.canProject(principal, project.id),
      );
  }

  private latestMessagingTask(command: Command): AgentTask | undefined {
    if (
      this.detachedMessagingConversations.has(messagingConversationKey(command)) ||
      this.store.get('detached-conversation', messagingConversationKey(command))
    ) {
      return undefined;
    }
    return this.mostRecentOwnedMessagingTask(command);
  }

  private mostRecentOwnedMessagingTask(command: Command): AgentTask | undefined {
    return this.webConsole.listCodingTasks().find((task) => {
      const origin = this.messagingTaskOrigins.get(task.id);
      if (task.archivedAt || !this.isMessagingTaskOwner(task.id, command)) return false;
      if (!origin || origin.source !== command.source || origin.userId !== command.userId) {
        return false;
      }
      return (
        !command.replyRouteId ||
        !origin.replyRouteId ||
        origin.replyRouteId === command.replyRouteId
      );
    });
  }

  private ownedMessagingTask(reference: string, command: Command): AgentTask | undefined {
    const task = this.webConsole.getCodingTask(reference);
    return task && this.isMessagingTaskOwner(task.id, command) ? task : undefined;
  }

  private isMessagingTaskOwner(taskId: string, command: Command): boolean {
    const task = this.webConsole.getCodingTask(taskId);
    const principal =
      command.source === 'cli'
        ? this.access.account('admin')
        : this.access.chat(command.source, command.userId);
    return Boolean(task && principal && this.access.canTask(principal, task, 'read'));
  }

  private async pushCodingTaskCompletion(taskId: string): Promise<void> {
    const origin = this.messagingTaskOrigins.get(taskId);
    if (!origin || origin.source === 'cli' || !this.resultPusher) {
      return;
    }
    try {
      const task = await this.webConsole.waitForCodingTask(taskId);
      if (this.webConsole.workbench) {
        this.webConsole.workbench.terminal({ ...task, origin });
        await this.webConsole.workbench.tick();
        return;
      }
      const success = task.status === 'completed' || task.status === 'review';
      const result: CommandResult = {
        commandId: origin.commandId,
        success,
        message: formatCodingTask(task, true),
        prUrl: task.pullRequestUrl,
      };
      await this.resultPusher(
        origin.source,
        origin.userId,
        this.formatter.format(result, origin.source),
        origin.replyRouteId,
      );
      this.auditLogger.record({
        action: 'agent_delegate',
        userId: origin.userId,
        source: origin.source,
        commandId: origin.commandId,
        operation: `complete ${task.id}`,
        result: success ? 'success' : 'failure',
        details: task.pullRequestUrl ?? task.error ?? task.status,
      });
    } catch (error) {
      this.logger.error(`Coding Agent 任务结果推送失败: ${errorMessage(error)}`);
    }
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
        userId: 'admin',
        userName: 'Administrator',
        source: 'cli',
      };
      const result = await this.processCommand(payload.text, userInfo);
      return { status: 200, body: result };
    });
  }

  private getHelpText(source: CommandSource): string {
    if (source === 'feishu' || source === 'dingtalk') {
      return [
        '直接用自然语言告诉 Codex 你想完成什么，例如：',
        '“在 cpx 项目修复飞书重复回复的问题，补充测试并创建 PR。”',
        '',
        '可选控制入口：',
        '• /new - 开始新的协调对话',
        '• /tasks [数量] - 查看最近任务',
        '• /status [任务ID] - 查看任务状态',
        '• /stop [任务ID] - 停止任务',
        '• /help - 显示帮助',
        '• /confirm <ID> / /cancel <ID> - 处理待确认操作',
      ].join('\n');
    }
    return [
      'Agent System 可用命令：',
      '',
      '• version / 版本 - 查看版本',
      '• help / 帮助 - 显示此帮助',
      '• 查看GitHub - 查看账号和可访问仓库',
      '• 查看分支 <owner/repo> - 查看仓库分支',
      '• 开发 <owner/repo>[#基础分支] [-> 新分支] <需求> - 交给 Coding Agent 开发并创建 PR',
      '• 最近任务 [数量] - 查看自己从当前平台创建的任务',
      '• 任务 <ID> - 查看 Coding Agent 任务进度',
      '• 继续 <ID> <需求> - 在原工作区和 Codex 会话中继续修改',
      '• 取消任务 <ID> - 取消运行中的任务',
      '• 飞书/钉钉任务内文本 - 交给当前会话的 Codex 继续处理',
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

function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

function messagingConversationKey(
  command: Pick<Command, 'source' | 'userId' | 'replyRouteId'>,
): string {
  return `${command.source}:${command.userId}:${command.replyRouteId ?? 'direct'}`;
}

function platformToolCommand(
  origin: PlatformToolOrigin,
  name: string,
  args: Record<string, unknown>,
): Command {
  return {
    id: randomUUID(),
    source: origin.source,
    userId: origin.userId,
    userName: origin.userName,
    isGroup: origin.isGroup,
    ...(origin.replyRouteId ? { replyRouteId: origin.replyRouteId } : {}),
    rawText: `[Codex platform tool] ${name}`,
    name,
    args,
    timestamp: Date.now(),
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function platformTaskSummary(task: AgentTask): Record<string, unknown> {
  return {
    id: task.id,
    shortId: shortTaskId(task.id),
    status: task.status,
    repository: displayRepository(task.repository),
    baseBranch: task.baseBranch ?? null,
    taskBranch: task.agentBranch ?? task.taskBranch ?? null,
    turns: task.turns.length,
    pullRequestUrl: task.pullRequestUrl ?? null,
    error: task.error ?? null,
  };
}

function isTerminalCodingTask(task: AgentTask): boolean {
  return ['completed', 'failed', 'cancelled', 'review', 'interrupted'].includes(task.status);
}

function codingTaskStatusLabel(status: AgentTask['status']): string {
  return {
    queued: '排队中',
    preparing: '准备工作区',
    running: '开发中',
    publishing: '提交 PR',
    verifying: '验证中',
    review: '待审查',
    interrupted: '已中断',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }[status];
}

function displayRepository(repository: string): string {
  return repository
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');
}

function platformTextMessage(source: CommandSource, text: string): unknown {
  return source === 'dingtalk'
    ? { msgtype: 'markdown', markdown: { title: 'Codex', text } }
    : { msgtype: 'text', content: { text } };
}

function formatCodingTask(task: AgentTask, completion = false): string {
  const heading = completion
    ? ['completed', 'review'].includes(task.status)
      ? 'Coding Agent 开发完成'
      : task.status === 'cancelled'
        ? 'Coding Agent 任务已取消'
        : 'Coding Agent 开发失败'
    : `Coding Agent 任务 ${shortTaskId(task.id)}`;
  const activeAttempt = task.attempts[task.attempts.length - 1];
  const lines = [
    heading,
    `任务 ID：${shortTaskId(task.id)}`,
    `轮次：${task.turns.length}`,
    `状态：${codingTaskStatusLabel(task.status)}`,
    `仓库：${displayRepository(task.repository)}`,
    `基础分支：${task.baseBranch ?? '默认分支'}`,
    `任务分支：${task.agentBranch ?? task.taskBranch ?? '尚未创建'}`,
    `Agent：${activeAttempt?.provider ?? task.provider}`,
  ];
  if (task.attempts.length > 1) {
    lines.push(
      `尝试顺序：${task.attempts
        .map((attempt) => `${attempt.provider}(${attempt.status})`)
        .join(' → ')}`,
    );
  }
  if (task.error) {
    lines.push(`错误：${task.error.slice(0, 800)}`);
  }
  if (completion && task.lastAgentResponse) {
    lines.push(`\nAgent 回复：\n${task.lastAgentResponse.slice(0, 6000)}`);
  }
  if (!task.pullRequestUrl && task.status === 'completed' && task.createPullRequest) {
    lines.push('Agent 未产生文件改动，因此没有创建 PR。');
  }
  if (completion && task.status === 'completed') {
    lines.push(`继续修改：继续 ${shortTaskId(task.id)} <需求>`);
  }
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
