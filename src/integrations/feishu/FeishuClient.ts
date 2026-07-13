import axios from 'axios';
import type { Logger } from '../../utils/Logger';

/**
 * 飞书消息推送客户端
 */
export class FeishuClient {
  private webhookUrl?: string;
  private logger: Logger;

  constructor(webhookUrl: string | undefined, logger: Logger) {
    this.webhookUrl = webhookUrl;
    this.logger = logger;
  }

  /** 推送消息到飞书群（自定义机器人 webhook） */
  async push(message: Record<string, unknown>): Promise<boolean> {
    if (!this.webhookUrl) {
      this.logger.warn('飞书 webhookUrl 未配置，跳过推送');
      return false;
    }
    try {
      const res = await axios.post(this.webhookUrl, message, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.data?.code !== 0 && res.data?.StatusCode !== 0 && res.data?.code !== undefined) {
        this.logger.error(`飞书推送失败: ${res.data?.msg ?? 'unknown error'}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(`飞书推送异常: ${(err as Error).message}`);
      return false;
    }
  }

  isConfigured(): boolean {
    return !!this.webhookUrl;
  }
}
