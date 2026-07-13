import { randomUUID } from 'crypto';
import { Logger } from '../utils/Logger';
import { MCPError } from '../utils/errors';
import { DatabaseService } from '../storage/Database';
import type { Transport } from './transports/Transport';
import { StdioTransport } from './transports/StdioTransport';
import { WebSocketTransport } from './transports/WebSocketTransport';
import { HttpTransport } from './transports/HttpTransport';
import {
  createRequest,
  createNotification,
  parseMessage,
  isResponse,
  isNotification,
  type JsonRpcMessage,
} from './JsonRpc';
import type {
  McpConfig,
  MCPConnection,
  MCPConnectionConfig,
  MCPConnectionStatus,
  MCPManagerLike,
} from '../core/types';

/** MCP 协议版本 */
const MCP_PROTOCOL_VERSION = '2024-11-05';

/** DB 行结构（对应 mcp_connections 表） */
interface McpRow {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string | null;
  env: string | null;
  url: string | null;
  status: string;
  capabilities: string | null;
  pid: number | null;
  connected_at: number | null;
  error: string | null;
}

/** 运行时连接状态 */
interface RuntimeConnection {
  transport: Transport;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  nextId: number;
  config: MCPConnectionConfig;
}

/**
 * MCP 管理器：管理 MCP 连接的生命周期与方法调用。
 *
 * 职责：
 * - 从配置自动连接 MCP 服务
 * - 按 id/name 查找连接
 * - 通过 JSON-RPC 2.0 调用远程方法（实现 MCPManagerLike）
 * - 持久化连接状态到 mcp_connections 表
 */
export class MCPManager implements MCPManagerLike {
  private config: McpConfig;
  private db: DatabaseService;
  private logger: Logger;
  private callTimeout: number;
  private runtimes: Map<string, RuntimeConnection> = new Map();
  private configByName: Map<string, MCPConnectionConfig> = new Map();

  constructor(config: McpConfig, db: DatabaseService, logger: Logger, callTimeout = 10000) {
    this.config = config;
    this.db = db;
    this.logger = logger.child('MCP');
    this.callTimeout = callTimeout;
    for (const c of config.connections) {
      this.configByName.set(c.name, c);
    }
  }

  /** 启动：自动连接配置中的所有连接。失败仅记录日志，不阻断启动。 */
  async start(): Promise<void> {
    for (const c of this.config.connections) {
      try {
        await this.connect(c);
      } catch (err) {
        this.logger.error(`自动连接 MCP ${c.name} 失败: ${(err as Error).message}`);
      }
    }
  }

  /** 停止：断开所有连接 */
  async stop(): Promise<void> {
    await this.disconnectAll();
  }

  /** 连接一个 MCP 服务 */
  async connect(cfg: MCPConnectionConfig): Promise<MCPConnection> {
    const id = `mcp_${randomUUID().slice(0, 12)}`;
    const transport = this.createTransport(cfg);

    const conn: MCPConnection = {
      id,
      name: cfg.name,
      transport: cfg.transport,
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env,
      url: cfg.url,
      status: 'connecting',
      capabilities: [],
    };

    // 设置消息路由
    transport.onMessage((data) => this.handleMessage(id, data));
    transport.onClose(() => this.handleClose(id));

    try {
      await transport.connect();
    } catch (err) {
      this.persistConnection(conn, (err as Error).message);
      throw new MCPError(`连接 ${cfg.name} 失败: ${(err as Error).message}`);
    }

    const runtime: RuntimeConnection = {
      transport,
      pending: new Map(),
      nextId: 1,
      config: cfg,
    };
    this.runtimes.set(id, runtime);

    // MCP 初始化握手
    let serverCapabilities: string[] = [];
    try {
      const initResult = await this.doCall(id, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'agent-system', version: '1.0.0' },
      });
      const caps = (initResult as { capabilities?: Record<string, unknown> })?.capabilities;
      if (caps && typeof caps === 'object') {
        serverCapabilities = Object.keys(caps);
      }
      // 发送 initialized 通知
      await this.sendNotification(id, 'notifications/initialized', {});
    } catch (err) {
      // 握手失败则断开
      await this.teardown(id);
      this.persistConnection({ ...conn, status: 'error', error: (err as Error).message });
      throw new MCPError(`MCP ${cfg.name} 初始化握手失败: ${(err as Error).message}`);
    }

    // 更新连接状态为已连接
    const pid = transport instanceof StdioTransport ? transport.pid : undefined;
    conn.status = 'connected';
    conn.connectedAt = Date.now();
    conn.capabilities = serverCapabilities;
    conn.pid = pid;
    this.persistConnection(conn);

    this.logger.info(`已连接 MCP: ${cfg.name} (${cfg.transport})${pid ? ` pid=${pid}` : ''}`);
    return conn;
  }

  /** 断开指定连接 */
  async disconnect(idOrName: string): Promise<void> {
    const conn = this.findRuntime(idOrName);
    if (!conn) {
      throw new MCPError(`连接不存在: ${idOrName}`);
    }
    await this.teardown(conn.id);
    this.updateDbStatus(conn.id, 'disconnected');
    this.logger.info(`已断开 MCP: ${conn.runtime.config.name}`);
  }

  /** 断开所有连接 */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.runtimes.keys());
    for (const id of ids) {
      try {
        await this.teardown(id);
        this.updateDbStatus(id, 'disconnected');
      } catch (err) {
        this.logger.error(`断开连接 ${id} 失败: ${(err as Error).message}`);
      }
    }
  }

  /** 调用 MCP 方法（实现 MCPManagerLike） */
  async call(connectionId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.doCall(connectionId, method, params);
  }

  /** 内部调用：支持 id 或 name 查找 */
  private async doCall(connectionIdOrName: string, method: string, params?: unknown): Promise<unknown> {
    const conn = this.findRuntime(connectionIdOrName);
    if (!conn) {
      throw new MCPError(`连接不存在: ${connectionIdOrName}`);
    }
    const { runtime } = conn;
    const reqId = runtime.nextId++;
    const request = createRequest(reqId, method, params);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(reqId);
        reject(new MCPError(`调用 ${method} 超时（${this.callTimeout}ms）`));
      }, this.callTimeout);

      runtime.pending.set(reqId, {
        resolve: (v) => {
          clearTimeout(timer);
          runtime.pending.delete(reqId);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          runtime.pending.delete(reqId);
          reject(e);
        },
        timer,
      });

      runtime.transport
        .send(JSON.stringify(request))
        .catch((err) => {
          const entry = runtime.pending.get(reqId);
          if (entry) {
            entry.reject(new MCPError(`发送失败: ${(err as Error).message}`));
          }
        });
    });
  }

  /** 发送通知（无 id，无需响应） */
  private async sendNotification(connectionId: string, method: string, params?: unknown): Promise<void> {
    const conn = this.findRuntime(connectionId);
    if (!conn) {
      throw new MCPError(`连接不存在: ${connectionId}`);
    }
    const notif = createNotification(method, params);
    await conn.runtime.transport.send(JSON.stringify(notif));
  }

  /** 列出所有连接（从 DB 读取） */
  list(): MCPConnection[] {
    const rows = this.db.prepare('SELECT * FROM mcp_connections ORDER BY connected_at DESC').all() as McpRow[];
    return rows.map((r) => this.rowToConnection(r));
  }

  /** 按 id 或 name 获取连接 */
  getConnection(idOrName: string): MCPConnection | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_connections WHERE id = ? OR name = ?')
      .get(idOrName, idOrName) as McpRow | undefined;
    return row ? this.rowToConnection(row) : undefined;
  }

  // ============ 私有方法 ============

  private createTransport(cfg: MCPConnectionConfig): Transport {
    switch (cfg.transport) {
      case 'stdio':
        if (!cfg.command) {
          throw new MCPError(`stdio 连接 ${cfg.name} 缺少 command`);
        }
        return new StdioTransport(cfg.command, cfg.args ?? [], cfg.env);
      case 'websocket':
        if (!cfg.url) {
          throw new MCPError(`websocket 连接 ${cfg.name} 缺少 url`);
        }
        return new WebSocketTransport(cfg.url);
      case 'http':
        if (!cfg.url) {
          throw new MCPError(`http 连接 ${cfg.name} 缺少 url`);
        }
        return new HttpTransport(cfg.url);
      default:
        throw new MCPError(`不支持的传输类型: ${cfg.transport as string}`);
    }
  }

  /** 处理收到的消息 */
  private handleMessage(connectionId: string, data: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = parseMessage(data);
    } catch (err) {
      this.logger.warn(`MCP 消息解析失败: ${(err as Error).message}`);
      return;
    }

    if (isResponse(msg)) {
      const runtime = this.runtimes.get(connectionId);
      if (!runtime) {
        return;
      }
      const id = typeof msg.id === 'number' ? msg.id : Number(msg.id);
      const entry = runtime.pending.get(id);
      if (!entry) {
        return;
      }
      if (msg.error) {
        entry.reject(new MCPError(`MCP 错误 [${msg.error.code}]: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
    } else if (isNotification(msg)) {
      // 服务端通知暂不处理（未来可扩展为事件回调）
      this.logger.debug(`收到 MCP 通知: ${msg.method}`);
    }
  }

  /** 处理连接关闭 */
  private handleClose(connectionId: string): void {
    const runtime = this.runtimes.get(connectionId);
    if (!runtime) {
      return;
    }
    // 拒绝所有 pending
    for (const [, entry] of runtime.pending) {
      entry.reject(new MCPError('连接已断开'));
    }
    runtime.pending.clear();
    this.runtimes.delete(connectionId);
    this.updateDbStatus(connectionId, 'disconnected');
    this.logger.warn(`MCP 连接 ${connectionId} 已断开`);
  }

  /** 查找运行时连接（支持 id 或 name） */
  private findRuntime(idOrName: string): { id: string; runtime: RuntimeConnection } | undefined {
    // 先按 id
    const byId = this.runtimes.get(idOrName);
    if (byId) {
      return { id: idOrName, runtime: byId };
    }
    // 再按 name
    for (const [id, runtime] of this.runtimes) {
      if (runtime.config.name === idOrName) {
        return { id, runtime };
      }
    }
    return undefined;
  }

  /** 关闭 transport 并清理运行时（不更新 DB） */
  private async teardown(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      return;
    }
    for (const [, entry] of runtime.pending) {
      clearTimeout(entry.timer);
      entry.reject(new MCPError('连接已断开'));
    }
    runtime.pending.clear();
    this.runtimes.delete(id);
    try {
      await runtime.transport.close();
    } catch (err) {
      this.logger.error(`关闭 transport 失败: ${(err as Error).message}`);
    }
  }

  /** 持久化连接到 DB */
  private persistConnection(conn: MCPConnection, error?: string): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO mcp_connections
       (id, name, transport, command, args, env, url, status, capabilities, pid, connected_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      conn.id,
      conn.name,
      conn.transport,
      conn.command ?? null,
      JSON.stringify(conn.args ?? []),
      conn.env ? JSON.stringify(conn.env) : null,
      conn.url ?? null,
      conn.status,
      JSON.stringify(conn.capabilities ?? []),
      conn.pid ?? null,
      conn.connectedAt ?? null,
      error ?? conn.error ?? null,
    );
  }

  /** 更新 DB 中的状态字段 */
  private updateDbStatus(id: string, status: MCPConnectionStatus, error?: string): void {
    this.db.prepare('UPDATE mcp_connections SET status = ?, error = ? WHERE id = ?').run(
      status,
      error ?? null,
      id,
    );
  }

  /** DB 行反序列化为 MCPConnection */
  private rowToConnection(row: McpRow): MCPConnection {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport as MCPConnection['transport'],
      command: row.command ?? undefined,
      args: row.args ? JSON.parse(row.args) : [],
      env: row.env ? JSON.parse(row.env) : undefined,
      url: row.url ?? undefined,
      status: row.status as MCPConnectionStatus,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
      pid: row.pid ?? undefined,
      connectedAt: row.connected_at ?? undefined,
      error: row.error ?? undefined,
    };
  }
}
