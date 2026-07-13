import { createHash } from 'crypto';
import type { Logger } from '../../utils/Logger';
import type { CommandSource } from '../../core/types';
import type { ParsedUserInfo } from '../../core/CommandParser';

/**
 * 飞书 Webhook 处理：URL 验证 + 签名校验 + 事件解析
 */
export class FeishuWebhook {
  private appSecret?: string;
  private enableVerify: boolean;
  private logger: Logger;

  constructor(appSecret: string | undefined, enableVerify: boolean, logger: Logger) {
    this.appSecret = appSecret;
    this.enableVerify = enableVerify;
    this.logger = logger;
  }

  /** 校验飞书签名：sha1(timestamp + appSecret + body) */
  verify(timestamp: string, rawBody: string, signature: string): boolean {
    if (!this.enableVerify || !this.appSecret) {
      return true;
    }
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts * 1000) > 60 * 60 * 1000) {
      this.logger.warn('飞书时间戳超出容差范围');
      return false;
    }
    const stringToSign = `${timestamp}${this.appSecret}${rawBody}`;
    const expected = createHash('sha1').update(stringToSign).digest('hex');
    return expected === signature;
  }

  /** 判断是否为 URL 验证请求（challenge） */
  isUrlVerification(body: Buffer): { challenge?: string } | null {
    try {
      const payload = JSON.parse(body.toString('utf8'));
      if (payload?.type === 'url_verification' && payload?.challenge) {
        return { challenge: payload.challenge };
      }
    } catch {
      return null;
    }
    return null;
  }

  /** 解析飞书消息事件，提取文本和用户信息 */
  parse(body: Buffer): { text: string; userInfo: ParsedUserInfo } | null {
    try {
      const payload = JSON.parse(body.toString('utf8'));
      // 飞书 im.message.receive_v1 事件
      const event = payload?.event;
      if (!event) {
        return null;
      }
      const message = event?.message;
      const sender = event?.sender;
      if (!message || message?.message_type !== 'text') {
        this.logger.warn('飞书消息类型不支持（仅支持文本）');
        return null;
      }
      // content 是 JSON 字符串：{"text": "/agent version"}
      let text = '';
      try {
        const content = JSON.parse(message.content || '{}');
        text = content.text ?? '';
      } catch {
        text = message.content ?? '';
      }
      if (!text) {
        return null;
      }
      const userInfo: ParsedUserInfo = {
        userId: sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? 'unknown',
        userName: sender?.sender_name ?? 'FeishuUser',
        source: 'feishu' as CommandSource,
      };
      return { text, userInfo };
    } catch (err) {
      this.logger.warn(`飞书消息解析失败: ${(err as Error).message}`);
      return null;
    }
  }
}
