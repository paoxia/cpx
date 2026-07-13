import { EventEmitter } from 'events';

/**
 * 类型化事件总线，用于模块间解耦通信
 */
export class EventBus extends EventEmitter {
  emit(event: string, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }

  /** 清除所有监听器（关闭时调用） */
  destroy(): void {
    this.removeAllListeners();
  }
}

// 预定义事件名
export const Events = {
  COMMAND_PARSED: 'command:parsed',
  COMMAND_COMPLETED: 'command:completed',
  COMMAND_FAILED: 'command:failed',
  CONFIG_RELOADED: 'config:reloaded',
  MCP_DISCONNECTED: 'mcp:disconnected',
} as const;
