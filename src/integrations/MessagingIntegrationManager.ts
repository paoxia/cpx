import axios from 'axios';
import { createLarkChannel, LarkChannel, LoggerLevel } from '@larksuiteoapi/node-sdk';
import { DWClient, RobotMessage, TOPIC_ROBOT } from 'dingtalk-stream';
import type { ParsedUserInfo } from '../core/CommandParser';
import type {
  CommandResult,
  CommandSource,
  DingTalkConfig,
  FeishuConfig,
} from '../core/types';
import { Logger } from '../utils/Logger';

export type MessagingPlatform = 'dingtalk' | 'feishu';
export type MessagingConnectionState = 'disabled' | 'connecting' | 'connected' | 'error';

export interface MessagingPlatformStatus {
  platform: MessagingPlatform;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  state: MessagingConnectionState;
  message: string;
  connectedAt?: number;
  lastMessageAt?: number;
}

export interface PublicMessagingConfiguration {
  dingtalk: MessagingPlatformStatus & { hasClientId: boolean; hasClientSecret: boolean };
  feishu: MessagingPlatformStatus & { hasAppId: boolean; hasAppSecret: boolean };
}

type CommandProcessor = (text: string, userInfo: ParsedUserInfo) => Promise<CommandResult>;

interface DingTalkReplyRoute {
  sessionWebhook: string;
  expiresAt: number;
}

/**
 * 维护飞书与钉钉的官方 WebSocket 长连接。
 *
 * 长连接只要求 NAS 具备出站网络，不开放 HTTP 回调端点。每次收到消息时记录
 * 发送者对应的会话，命令结果和异步任务完成通知都会回到该会话。
 */
export class MessagingIntegrationManager {
  private dingtalkConfig: DingTalkConfig;
  private feishuConfig: FeishuConfig;
  private readonly logger: Logger;
  private readonly processCommand: CommandProcessor;
  private dingTalkClient?: DWClient;
  private feishuChannel?: LarkChannel;
  private readonly dingTalkRoutes = new Map<string, DingTalkReplyRoute>();
  private readonly feishuRoutes = new Map<string, string>();
  private statuses: Record<MessagingPlatform, MessagingPlatformStatus>;

  constructor(
    dingtalk: DingTalkConfig,
    feishu: FeishuConfig,
    logger: Logger,
    processCommand: CommandProcessor,
  ) {
    this.dingtalkConfig = structuredClone(dingtalk);
    this.feishuConfig = structuredClone(feishu);
    this.logger = logger.child('Messaging');
    this.processCommand = processCommand;
    this.statuses = {
      dingtalk: this.baseStatus('dingtalk'),
      feishu: this.baseStatus('feishu'),
    };
  }

  async start(): Promise<void> {
    await Promise.allSettled([this.startDingTalk(), this.startFeishu()]);
  }

  async stop(): Promise<void> {
    this.dingTalkClient?.disconnect();
    this.dingTalkClient = undefined;
    if (this.feishuChannel) {
      await this.feishuChannel.disconnect();
      this.feishuChannel = undefined;
    }
  }

  async configure(
    platform: MessagingPlatform,
    config: DingTalkConfig | FeishuConfig,
  ): Promise<MessagingPlatformStatus> {
    if (platform === 'dingtalk') {
      this.dingtalkConfig = structuredClone(config as DingTalkConfig);
      this.dingTalkClient?.disconnect();
      this.dingTalkClient = undefined;
      this.dingTalkRoutes.clear();
      await this.startDingTalk();
    } else {
      this.feishuConfig = structuredClone(config as FeishuConfig);
      if (this.feishuChannel) await this.feishuChannel.disconnect();
      this.feishuChannel = undefined;
      this.feishuRoutes.clear();
      await this.startFeishu();
    }
    return { ...this.statuses[platform] };
  }

  getPublicConfiguration(): PublicMessagingConfiguration {
    return {
      dingtalk: {
        ...this.statuses.dingtalk,
        enabled: this.dingtalkConfig.enabled,
        configured: this.isDingTalkConfigured(),
        hasClientId: Boolean(this.dingtalkConfig.clientId),
        hasClientSecret: Boolean(this.dingtalkConfig.clientSecret),
      },
      feishu: {
        ...this.statuses.feishu,
        enabled: this.feishuConfig.enabled,
        configured: this.isFeishuConfigured(),
        hasAppId: Boolean(this.feishuConfig.appId),
        hasAppSecret: Boolean(this.feishuConfig.appSecret),
      },
    };
  }

  async push(
    source: CommandSource,
    userId: string,
    message: unknown,
    replyRouteId = userId,
  ): Promise<void> {
    if (source === 'dingtalk') {
      await this.pushDingTalk(replyRouteId, message);
    } else if (source === 'feishu') {
      await this.pushFeishu(replyRouteId, message);
    }
  }

  private async startDingTalk(): Promise<void> {
    if (!this.dingtalkConfig.enabled) {
      this.statuses.dingtalk = this.baseStatus('dingtalk');
      return;
    }
    if (!this.isDingTalkConfigured()) {
      this.statuses.dingtalk = this.errorStatus('dingtalk', '请填写 Client ID 和 Client Secret。');
      return;
    }

    this.statuses.dingtalk = this.connectingStatus('dingtalk');
    const client = new DWClient({
      clientId: this.dingtalkConfig.clientId!,
      clientSecret: this.dingtalkConfig.clientSecret!,
      debug: false,
    });
    this.dingTalkClient = client;
    client.registerCallbackListener(TOPIC_ROBOT, async (event) => {
      try {
        const message = JSON.parse(event.data) as RobotMessage;
        if (message.msgtype !== 'text' || !message.text?.content?.trim()) {
          client.socketCallBackResponse(event.headers.messageId, { success: true });
          return;
        }
        const userId = message.senderStaffId || message.senderId;
        const replyRouteId = `${message.conversationId}:${userId}`;
        this.dingTalkRoutes.set(replyRouteId, {
          sessionWebhook: message.sessionWebhook,
          expiresAt: message.sessionWebhookExpiredTime,
        });
        this.statuses.dingtalk = {
          ...this.statuses.dingtalk,
          state: 'connected',
          lastMessageAt: Date.now(),
          message: '长连接正常，已收到消息。',
        };
        await this.processCommand(message.text.content.trim(), {
          userId,
          userName: message.senderNick || 'DingTalkUser',
          source: 'dingtalk',
          replyRouteId,
        });
        client.socketCallBackResponse(event.headers.messageId, { success: true });
      } catch (error) {
        this.logger.error(`钉钉消息处理失败: ${errorMessage(error)}`);
        client.socketCallBackResponse(event.headers.messageId, {
          success: false,
          message: 'cpx command failed',
        });
      }
    });

    try {
      await client.getAccessToken();
      await client.connect();
      if (this.dingTalkClient !== client) return;
      this.statuses.dingtalk = this.connectedStatus('dingtalk');
      this.logger.info('钉钉 Stream 长连接已启动');
    } catch (error) {
      if (this.dingTalkClient === client) this.dingTalkClient = undefined;
      client.disconnect();
      this.statuses.dingtalk = this.errorStatus('dingtalk', connectionError(error));
      this.logger.warn(`钉钉 Stream 连接失败: ${errorMessage(error)}`);
    }
  }

  private async startFeishu(): Promise<void> {
    if (!this.feishuConfig.enabled) {
      this.statuses.feishu = this.baseStatus('feishu');
      return;
    }
    if (!this.isFeishuConfigured()) {
      this.statuses.feishu = this.errorStatus('feishu', '请填写 App ID 和 App Secret。');
      return;
    }

    this.statuses.feishu = this.connectingStatus('feishu');
    const channel = createLarkChannel({
      appId: this.feishuConfig.appId!,
      appSecret: this.feishuConfig.appSecret!,
      loggerLevel: LoggerLevel.warn,
      handshakeTimeoutMs: 15_000,
      policy: { requireMention: true, dmMode: 'open' },
      source: 'cpx',
    });
    this.feishuChannel = channel;
    channel.on('message', async (message) => {
      const replyRouteId = `${message.chatId}:${message.senderId}`;
      this.feishuRoutes.set(replyRouteId, message.chatId);
      this.statuses.feishu = {
        ...this.statuses.feishu,
        state: 'connected',
        lastMessageAt: Date.now(),
        message: '长连接正常，已收到消息。',
      };
      try {
        await this.processCommand(message.content.trim(), {
          userId: message.senderId,
          userName: message.senderName || 'FeishuUser',
          source: 'feishu',
          replyRouteId,
        });
      } catch (error) {
        this.logger.error(`飞书消息处理失败: ${errorMessage(error)}`);
      }
    });
    channel.on('error', (error) => {
      this.logger.warn(`飞书长连接事件异常: ${errorMessage(error)}`);
    });
    channel.on('reconnecting', () => {
      this.statuses.feishu = {
        ...this.statuses.feishu,
        state: 'connecting',
        message: '长连接已断开，正在自动重连…',
      };
    });
    channel.on('reconnected', () => {
      this.statuses.feishu = this.connectedStatus('feishu');
    });

    try {
      await channel.connect();
      if (this.feishuChannel !== channel) return;
      this.statuses.feishu = this.connectedStatus('feishu');
      this.logger.info('飞书 WebSocket 长连接已启动');
    } catch (error) {
      if (this.feishuChannel === channel) this.feishuChannel = undefined;
      await channel.disconnect().catch(() => undefined);
      this.statuses.feishu = this.errorStatus('feishu', connectionError(error));
      this.logger.warn(`飞书 WebSocket 连接失败: ${errorMessage(error)}`);
    }
  }

  private async pushDingTalk(userId: string, message: unknown): Promise<void> {
    const route = this.dingTalkRoutes.get(userId);
    const client = this.dingTalkClient;
    if (!route || !client) throw new Error('没有可用的钉钉会话，请先向机器人发送一条消息');
    if (route.expiresAt && route.expiresAt <= Date.now()) {
      this.dingTalkRoutes.delete(userId);
      throw new Error('钉钉会话回复地址已过期，请重新向机器人发送一条消息');
    }
    const accessToken = await client.getAccessToken();
    await axios.post(route.sessionWebhook, message, {
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': accessToken,
      },
    });
  }

  private async pushFeishu(userId: string, message: unknown): Promise<void> {
    const chatId = this.feishuRoutes.get(userId);
    const channel = this.feishuChannel;
    if (!chatId || !channel) throw new Error('没有可用的飞书会话，请先向机器人发送一条消息');
    const text = extractText(message);
    await channel.send(chatId, { text });
  }

  private isDingTalkConfigured(): boolean {
    return Boolean(this.dingtalkConfig.clientId?.trim() && this.dingtalkConfig.clientSecret?.trim());
  }

  private isFeishuConfigured(): boolean {
    return Boolean(this.feishuConfig.appId?.trim() && this.feishuConfig.appSecret?.trim());
  }

  private baseStatus(platform: MessagingPlatform): MessagingPlatformStatus {
    const enabled = platform === 'dingtalk' ? this.dingtalkConfig.enabled : this.feishuConfig.enabled;
    const configured = platform === 'dingtalk' ? this.isDingTalkConfigured() : this.isFeishuConfigured();
    return {
      platform,
      displayName: platform === 'dingtalk' ? '钉钉' : '飞书',
      enabled,
      configured,
      state: 'disabled',
      message: enabled ? '等待启动长连接。' : '未启用。',
    };
  }

  private connectingStatus(platform: MessagingPlatform): MessagingPlatformStatus {
    return { ...this.baseStatus(platform), state: 'connecting', message: '正在建立长连接…' };
  }

  private connectedStatus(platform: MessagingPlatform): MessagingPlatformStatus {
    return {
      ...this.baseStatus(platform),
      state: 'connected',
      message: '长连接已建立，可以接收机器人消息。',
      connectedAt: Date.now(),
    };
  }

  private errorStatus(platform: MessagingPlatform, message: string): MessagingPlatformStatus {
    return { ...this.baseStatus(platform), state: 'error', message };
  }
}

export function isMessagingPlatform(value: unknown): value is MessagingPlatform {
  return value === 'dingtalk' || value === 'feishu';
}

function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return String(message ?? '');
  const record = message as Record<string, unknown>;
  const content = record.content as { text?: unknown } | undefined;
  const markdown = record.markdown as { text?: unknown } | undefined;
  if (typeof content?.text === 'string') return content.text;
  if (typeof markdown?.text === 'string') return markdown.text;
  if (typeof record.text === 'string') return record.text;
  return JSON.stringify(message);
}

function connectionError(error: unknown): string {
  const detail = errorMessage(error);
  if (/401|403|unauthorized|forbidden|credential|secret|token/i.test(detail)) {
    return '凭据验证失败，请检查应用 ID 和 Secret。';
  }
  return `连接失败：${detail.slice(0, 240)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
