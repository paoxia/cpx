/**
 * MCP 传输层抽象
 *
 * 三种实现：StdioTransport（子进程）、WebSocketTransport、HttpTransport。
 * MCPManager 仅依赖此接口，不关心传输细节。
 */
export interface Transport {
  /** 建立连接 */
  connect(): Promise<void>;
  /** 发送一条消息（JSON 字符串） */
  send(data: string): Promise<void>;
  /** 注册消息接收回调（覆盖式，仅保留最后一个） */
  onMessage(handler: (data: string) => void): void;
  /** 注册连接关闭回调 */
  onClose(handler: () => void): void;
  /** 关闭传输 */
  close(): Promise<void>;
  /** 当前是否存活 */
  isAlive(): boolean;
}
