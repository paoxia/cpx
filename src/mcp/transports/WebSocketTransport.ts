import WebSocket from 'ws';
import type { Transport } from './Transport';

/**
 * WebSocket 传输：通过 ws 连接远程 MCP 服务器，文本帧收发 JSON-RPC。
 */
export class WebSocketTransport implements Transport {
  private url: string;
  private ws?: WebSocket;
  private messageHandler?: (data: string) => void;
  private closeHandler?: () => void;
  private alive = false;
  private closed = false;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    if (this.alive) {
      return;
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on('open', () => {
        this.alive = true;
        resolve();
      });

      ws.on('message', (data: WebSocket.RawData) => {
        const text = data.toString('utf8').trim();
        if (text && this.messageHandler) {
          this.messageHandler(text);
        }
      });

      ws.on('close', () => {
        if (!this.closed) {
          this.alive = false;
          this.closed = true;
          this.closeHandler?.();
        }
      });

      ws.on('error', (err: Error) => {
        if (!this.alive) {
          reject(new Error(`WebSocket 连接失败: ${err.message}`));
        } else if (!this.closed) {
          this.alive = false;
          this.closed = true;
          this.closeHandler?.();
        }
      });
    });
  }

  async send(data: string): Promise<void> {
    if (!this.ws || !this.alive) {
      throw new Error('WebSocket 传输未连接或已关闭');
    }
    return new Promise((resolve, reject) => {
      this.ws!.send(data, (err) => {
        if (err) {
          reject(new Error(`WebSocket 发送失败: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed || !this.ws) {
      this.alive = false;
      return;
    }
    this.closed = true;
    this.alive = false;
    return new Promise((resolve) => {
      this.ws!.once('close', () => resolve());
      try {
        this.ws!.close();
      } catch {
        resolve();
      }
      // 超时兜底
      setTimeout(() => resolve(), 2000);
    });
  }

  isAlive(): boolean {
    return this.alive && !this.closed && !!this.ws;
  }
}
