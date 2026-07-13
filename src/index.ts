/**
 * Agent System 程序化 API
 *
 * 示例：
 * ```ts
 * import { AgentSystem } from 'agent-system';
 * const system = new AgentSystem('./config');
 * await system.start();
 * const result = await system.processCommand('version', { userId: 'u1', userName: 'Test', source: 'cli' });
 * ```
 */

export { AgentSystem } from './core/AgentSystem';
export { ConfigManager, deepMerge } from './config/ConfigManager';
export { Logger } from './utils/Logger';
export { EventBus, Events } from './core/EventBus';
export { HttpServer } from './core/HttpServer';
export { CommandParser } from './core/CommandParser';
export { CommandRouter } from './core/CommandRouter';
export { ResponseFormatter } from './core/ResponseFormatter';
export { MCPManager } from './mcp/MCPManager';

export * from './core/types';
export * from './utils/errors';
