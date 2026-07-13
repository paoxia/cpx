import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { Logger } from '../utils/Logger';

export type RequestHandler = (
  body: Buffer,
  headers: Record<string, string | string[] | undefined>,
  query: Record<string, string>,
) => Promise<{ status: number; body: unknown }>;

/**
 * 基于 Node 内置 http 模块的轻量 HTTP 服务
 * 仅处理 webhook 接收，路由到注册的处理器
 */
export class HttpServer {
  private server: Server | null = null;
  private routes: Map<string, Map<string, RequestHandler>> = new Map();
  private logger: Logger;
  private port: number;
  private host: string;

  constructor(port: number, host: string, logger: Logger) {
    this.port = port;
    this.host = host;
    this.logger = logger;
  }

  /** 注册路由处理器 */
  register(method: string, path: string, handler: RequestHandler): void {
    const upperMethod = method.toUpperCase();
    if (!this.routes.has(upperMethod)) {
      this.routes.set(upperMethod, new Map());
    }
    this.routes.get(upperMethod)!.set(path, handler);
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        this.logger.error(`HTTP 处理异常: ${(err as Error).message}`);
        this.sendJson(res, 500, { error: 'Internal Server Error' });
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, this.host, () => {
        this.logger.info(`HTTP 服务已启动: http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.logger.info('HTTP 服务已停止');
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());

    // 健康检查
    if (method === 'GET' && (path === '/health' || path === '/')) {
      this.sendJson(res, 200, { status: 'ok', timestamp: Date.now() });
      return;
    }

    const methodRoutes = this.routes.get(method);
    const handler = methodRoutes?.get(path);
    if (!handler) {
      this.sendJson(res, 404, { error: 'Not Found', path });
      return;
    }

    // 收集 raw body
    const body = await this.readBody(req);
    const headers = req.headers as Record<string, string | string[] | undefined>;

    try {
      const result = await handler(body, headers, query);
      this.sendJson(res, result.status, result.body);
    } catch (err) {
      this.logger.error(`路由处理失败 ${method} ${path}: ${(err as Error).message}`);
      this.sendJson(res, 500, { error: (err as Error).message });
    }
  }

  private readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        // 防止过大请求（10MB 上限）
        const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
        if (totalSize > 10 * 1024 * 1024) {
          reject(new Error('请求体过大'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}
