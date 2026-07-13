import axios from 'axios';
import type { Logger } from '../../utils/Logger';

/**
 * 钉钉消息推送客户端
 */
export class DingTalkClient {
  private webhookUrl?: string;
  private logger: Logger;

  constructor(webhookUrl: string | undefined, logger: Logger) {
    this.webhookUrl = webhookUrl;
    this.logger = logger;
  }

  /** 推送消息到钉钉群 */
  async push(message: Record<string, unknown>): Promise<boolean> {
    if (!this.webhookUrl) {
      this.logger.warn('钉钉 webhookUrl 未配置，跳过推送');
      return false;
    }
    try {
      const res = await axios.post(this.webhookUrl, message, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.data?.errcode !== 0 && res.data?.errcode !== undefined) {
        this.logger.error(`钉钉推送失败: ${res.data?.errmsg ?? 'unknown error'}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`钉钉推送异常: ${(err as Error).message}`);
      return false;
    }
  }

  isConfigured(): boolean {
    return !!this.webhookUrl;
  }
}
