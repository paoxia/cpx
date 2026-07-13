import { createHmac } from 'crypto';
import type { Logger } from '../../utils/Logger';
import type { CommandSource } from '../../core/types';
import type { ParsedUserInfo } from '../../core/CommandParser';

/**
 * 钉钉 Webhook 处理：签名校验 + 消息解析
 */
export class DingTalkWebhook {
  private secret?: string;
  private enableVerify: boolean;
  private logger: Logger;

  constructor(secret: string | undefined, enableVerify: boolean, logger: Logger) {
    this.secret = secret;
    this.enableVerify = enableVerify;
    this.logger = logger;
  }

  /** 校验签名 */
  verify(timestamp: string, sign: string): boolean {
    if (!this.enableVerify || !this.secret) {
      return true;
    }
    // 时间戳容差：1 小时内有效，防重放
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 60 * 60 * 1000) {
      this.logger.warn('钉钉时间戳超出容差范围');
      return false;
    }
    const stringToSign = `${timestamp}\n${this.secret}`;
    const expected = createHmac('sha256', this.secret).update(stringToSign).digest('base64');
    return expected === sign;
  }

  /** 解析钉钉消息体，提取文本和用户信息 */
  parse(body: Buffer): { text: string; userInfo: ParsedUserInfo } | null {
    try {
      const payload = JSON.parse(body.toString('utf8'));
      // 钉钉机器人消息格式：{ msgtype: 'text', text: { content: '@agent ...' }, senderStaffId, ... }
      const text = payload?.text?.content;
      if (!text || typeof text !== 'string') {
        return null;
      }
      const userInfo: ParsedUserInfo = {
        userId: payload?.senderStaffId ?? payload?.senderId ?? payload?.chatbot?.userId ?? 'unknown',
        userName: payload?.senderNick ?? payload?.senderId ?? 'DingTalkUser',
        source: 'dingtalk' as CommandSource,
      };
      return { text, userInfo };
    } catch (err) {
      this.logger.warn(`钉钉消息解析失败: ${(err as Error).message}`);
      return null;
    }
  }
}
