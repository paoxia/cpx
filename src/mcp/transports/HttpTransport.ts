import axios, { type AxiosInstance } from 'axios';
import type { Transport } from './Transport';

/**
 * HTTP 传输：每次 send() 向 url POST JSON-RPC 请求，响应体即响应消息。
 *
 * 无状态请求-响应模型，不支持服务端主动通知。
 * 为统一 Transport 接口，send() 在收到 HTTP 响应后同步调用 onMessage handler。
 */
export class HttpTransport implements Transport {
  private url: string;
  private client: AxiosInstance;
  private messageHandler?: (data: string) => void;
  private closeHandler?: () => void;
  private alive = false;

  constructor(url: string) {
    this.url = url;
    this.client = axios.create({
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async connect(): Promise<void> {
    // HTTP 无持久连接，仅标记为就绪
    this.alive = true;
  }

  async send(data: string): Promise<void> {
    if (!this.alive) {
      throw new Error('HTTP 传输未连接');
    }
    try {
      const res = await this.client.post(this.url, data);
      if (res.data === undefined || res.data === null) {
        return;
      }
      // 响应可能是对象或字符串
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      const trimmed = text.trim();
      if (trimmed && this.messageHandler) {
        this.messageHandler(trimmed);
      }
    } catch (err) {
      throw new Error(`HTTP 请求失败: ${(err as Error).message}`);
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this.alive = false;
    this.closeHandler?.();
  }

  isAlive(): boolean {
    return this.alive;
  }
}
