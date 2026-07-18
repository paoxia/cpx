import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RequestHandler } from '../../../src/core/HttpServer';
import { WebConsole } from '../../../src/web/WebConsole';
import { Logger } from '../../../src/utils/Logger';

const TMP_DIR = join(process.cwd(), 'tmp-test-web-console');

class FakeHttpServer {
  readonly routes = new Map<string, RequestHandler>();

  register(method: string, path: string, handler: RequestHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
  }

  handler(method: string, path: string): RequestHandler {
    const handler = this.routes.get(`${method.toUpperCase()} ${path}`);
    if (!handler) throw new Error(`missing route: ${method} ${path}`);
    return handler;
  }
}

describe('WebConsole', () => {
  let server: FakeHttpServer;
  let webConsole: WebConsole;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    server = new FakeHttpServer();
    webConsole = new WebConsole(
      server as unknown as import('../../../src/core/HttpServer').HttpServer,
      join(TMP_DIR, 'agent.db'),
      new Logger('error'),
    );
  });

  afterEach(async () => {
    await webConsole.stop();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('应注册控制台静态资源并设置安全响应头', async () => {
    const response = await server.handler('GET', '/')(Buffer.alloc(0), {}, {});
    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    expect(response.headers).toMatchObject({
      'Content-Security-Policy': expect.stringContaining("default-src 'self'"),
      'X-Content-Type-Options': 'nosniff',
    });
  });

  it('应读取、校验并持久化非敏感设置', async () => {
    const getSettings = server.handler('GET', '/api/console/settings');
    const updateSettings = server.handler('POST', '/api/console/settings');
    expect((await getSettings(Buffer.alloc(0), {}, {})).body).toMatchObject({
      defaultProvider: 'codex',
      claudeModel: 'sonnet',
      hasOpenaiApiKey: false,
    });

    const response = await updateSettings(
      Buffer.from(
        JSON.stringify({
          defaultProvider: 'claude',
          codexModel: 'gpt-5.1-codex',
          claudeModel: 'opus',
          openaiApiKey: 'runtime-only-secret',
        }),
      ),
      {},
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      defaultProvider: 'claude',
      codexModel: 'gpt-5.1-codex',
      hasOpenaiApiKey: true,
    });
    expect(response.headers).toEqual({ 'Cache-Control': 'no-store' });

    const settingsPath = join(TMP_DIR, 'console-settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('runtime-only-secret');
  });

  it('应对错误设置和错误任务请求返回 400', async () => {
    const settingsResponse = await server.handler('POST', '/api/console/settings')(
      Buffer.from('{bad json'),
      {},
      {},
    );
    expect(settingsResponse).toMatchObject({ status: 400 });

    const taskResponse = await server.handler('POST', '/api/console/tasks')(
      Buffer.from(JSON.stringify({ repository: 'not-github', prompt: 'test' })),
      {},
      {},
    );
    expect(taskResponse).toMatchObject({ status: 400 });
  });

  it('应返回空任务列表以及明确的查询和取消错误', async () => {
    const list = await server.handler('GET', '/api/console/tasks')(Buffer.alloc(0), {}, {});
    expect(list).toMatchObject({ status: 200, body: { tasks: [] } });

    const detail = await server.handler('GET', '/api/console/task')(Buffer.alloc(0), {}, {});
    expect(detail).toMatchObject({ status: 400, body: { error: 'id is required' } });

    const cancel = await server.handler('POST', '/api/console/cancel')(
      Buffer.from(JSON.stringify({ id: 'missing' })),
      {},
      {},
    );
    expect(cancel).toMatchObject({ status: 409 });
  });

  it('应拒绝未知 defaultProvider 与空 fallbackOrder', async () => {
    const unknownProvider = await server.handler('POST', '/api/console/settings')(
      Buffer.from(JSON.stringify({ defaultProvider: 'unknown' })),
      {},
      {},
    );
    expect(unknownProvider).toMatchObject({ status: 400 });

    const emptyOrder = await server.handler('POST', '/api/console/settings')(
      Buffer.from(JSON.stringify({ fallbackOrder: [] })),
      {},
      {},
    );
    expect(emptyOrder).toMatchObject({ status: 400 });
  });

  it('应持久化 codebuddyModel 且不写盘 codebuddyApiKey', async () => {
    const updateSettings = server.handler('POST', '/api/console/settings');
    const response = await updateSettings(
      Buffer.from(
        JSON.stringify({
          codebuddyModel: 'cb-pro',
          codebuddyApiKey: 'secret-cb',
        }),
      ),
      {},
      {},
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      codebuddyModel: 'cb-pro',
      hasCodebuddyApiKey: true,
    });

    const settingsPath = join(TMP_DIR, 'console-settings.json');
    const stored = readFileSync(settingsPath, 'utf8');
    expect(stored).toContain('cb-pro');
    expect(stored).not.toContain('secret-cb');
  });
});
