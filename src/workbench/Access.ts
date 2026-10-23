import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { WorkbenchStore } from './Store';
import type { AgentTask } from '../agents/AgentTaskManager';
import type { HttpServer, RequestContext } from '../core/HttpServer';

export type Role = 'admin' | 'maintainer' | 'requester' | 'reviewer';
export interface Principal {
  id: string;
  name: string;
  role: Role;
  projects: string[];
  disabled?: boolean;
  allowGroups?: boolean;
  conversations?: string[];
}
interface Account extends Principal {
  password?: string;
}
interface Credential {
  id: string;
  userId: string;
  hash: string;
  expiresAt: number;
  csrf?: string;
  name?: string;
}
const accountSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_:-]{1,160}$/),
  name: z.string().min(1).max(80),
  role: z.enum(['admin', 'maintainer', 'requester', 'reviewer']),
  projects: z.array(z.string().max(100)).max(100).default([]),
  disabled: z.boolean().optional(),
  allowGroups: z.boolean().default(false),
  conversations: z.array(z.string().max(200)).max(100).default([]),
});
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = (): string => randomBytes(32).toString('hex');

export class AccessControl {
  private bootstrapPath: string;
  private bootstrapHash?: string;

  constructor(
    readonly store: WorkbenchStore,
    dataDir: string,
  ) {
    this.bootstrapPath = join(dataDir, 'bootstrap-token.txt');
    if (!store.get<Account>('account', 'admin')) {
      mkdirSync(dataDir, { recursive: true });
      const value =
        process.env.CPX_BOOTSTRAP_TOKEN ||
        (existsSync(this.bootstrapPath)
          ? readFileSync(this.bootstrapPath, 'utf8').trim()
          : secret());
      if (value.length < 24) throw new Error('CPX_BOOTSTRAP_TOKEN 至少需要 24 个字符');
      this.bootstrapHash = digest(value);
      if (!process.env.CPX_BOOTSTRAP_TOKEN) {
        writeFileSync(this.bootstrapPath, value, { mode: 0o600 });
        chmodSync(this.bootstrapPath, 0o600);
      }
    }
  }

  get initialized(): boolean {
    return Boolean(this.store.get('account', 'admin'));
  }

  account(id: string): Principal | undefined {
    const value = this.store.get<Account>('account', id);
    if (!value || value.disabled) return undefined;
    return {
      id: value.id,
      name: value.name,
      role: value.role,
      projects: value.projects,
      disabled: value.disabled,
      allowGroups: value.allowGroups,
      conversations: value.conversations,
    };
  }

  saveAccount(input: unknown): Principal {
    const value = accountSchema.parse(input);
    if (value.id === 'admin') throw new Error('内置管理员不能删除或降权');
    return this.store.put('account', value.id, value);
  }

  listAccounts(): Principal[] {
    return this.store
      .list<Account>('account')
      .map(({ password: _password, ...account }) => account);
  }

  issue(
    userId: string,
    name: string,
    session = false,
  ): { token: string; csrf?: string; expiresAt: number; id: string } {
    if (!this.account(userId)) throw new Error('用户不存在或已禁用');
    const token = secret();
    const record: Credential = {
      id: digest(token),
      userId,
      name: name.slice(0, 80),
      hash: digest(token),
      expiresAt: Date.now() + (session ? 8 * 3600_000 : 30 * 86400_000),
      ...(session ? { csrf: secret() } : {}),
    };
    this.store.put('credential', record.id, record);
    return { token, csrf: record.csrf, expiresAt: record.expiresAt, id: record.id };
  }

  identify(
    headers: Record<string, string | string[] | undefined>,
  ): { principal: Principal; credential: Credential; bearer: boolean } | undefined {
    const authorization = String(headers.authorization ?? '');
    const bearer = authorization.startsWith('Bearer ');
    const token = bearer
      ? authorization.slice(7)
      : /(?:^|;\s*)cpx_session=([a-f0-9]+)/.exec(String(headers.cookie ?? ''))?.[1];
    if (!token || token.length > 256) return undefined;
    const credential = this.store.get<Credential>('credential', digest(token));
    if (!credential || credential.expiresAt <= Date.now()) return undefined;
    const principal = this.account(credential.userId);
    return principal ? { principal, credential, bearer } : undefined;
  }

  canProject(principal: Principal, projectId?: string, write = false): boolean {
    if (principal.role === 'admin') return true;
    return Boolean(
      projectId &&
      principal.projects.includes(projectId) &&
      (!write || principal.role !== 'reviewer'),
    );
  }

  canTask(principal: Principal, task: AgentTask, action = 'read'): boolean {
    if (principal.role === 'admin') return true;
    if (task.projectId && !this.canProject(principal, task.projectId)) return false;
    if (action === 'publish')
      return (
        this.canProject(principal, task.projectId) &&
        ['maintainer', 'reviewer'].includes(principal.role)
      );
    if (action !== 'read' && principal.role === 'reviewer') return false;
    const owner =
      this.store.get<{ userId: string }>('identity', task.ownerId ?? '')?.userId ?? task.ownerId;
    return (
      owner === principal.id ||
      (Boolean(task.projectId) && ['maintainer', 'reviewer'].includes(principal.role))
    );
  }

  chat(source: string, userId: string): Principal | undefined {
    const identity = this.store.get<{ userId: string }>('identity', `${source}:${userId}`);
    return this.account(identity?.userId ?? `${source}:${userId}`);
  }

  attach(server: HttpServer, getTask: (id: string) => AgentTask | undefined): void {
    server.use(async (context) => {
      const { path, method, headers, body, query } = context;
      // Static assets contain no private data. The app performs login before loading state.
      if (
        ['/', '/app.js', '/styles.css', '/workbench.js', '/workbench.css'].includes(path) ||
        path.startsWith('/api/auth/') ||
        path.startsWith('/api/internal/') ||
        path.startsWith('/api/worker/')
      )
        return;
      const identity = this.identify(headers);
      if (!identity)
        return { status: 401, body: { error: this.initialized ? '请先登录' : '请先认领实例' } };
      const { principal, credential, bearer } = identity;
      if (!bearer && !['GET', 'HEAD'].includes(method)) {
        let sameOrigin = true;
        try {
          sameOrigin = !headers.origin || new URL(String(headers.origin)).host === headers.host;
        } catch {
          sameOrigin = false;
        }
        if (headers['x-cpx-csrf'] !== credential.csrf || !sameOrigin) {
          return { status: 403, body: { error: '请求校验失败，请重新登录' } };
        }
      }
      headers['x-cpx-user'] = principal.id;
      headers['x-cpx-role'] = principal.role;
      if (principal.role !== 'admin') {
        if (
          path === '/command' ||
          (!path.startsWith('/api/console/task') &&
            path !== '/api/console/cancel' &&
            !path.startsWith('/api/workbench/'))
        )
          return { status: 403, body: { error: '仅管理员可以操作' } };
        let id = query.id;
        if (body.length) {
          try {
            id = (JSON.parse(body.toString()) as { id?: string }).id ?? id;
          } catch {
            return { status: 400, body: { error: 'Invalid JSON' } };
          }
        }
        if (id && (path.includes('/task') || path.endsWith('/cancel'))) {
          const task = getTask(id);
          const action = path.endsWith('/publish')
            ? 'publish'
            : method === 'GET'
              ? 'read'
              : 'write';
          if (!task || !this.canTask(principal, task, action)) {
            this.store.audit(principal.id, action, id, 'denied');
            return { status: 403, body: { error: '无权访问此任务' } };
          }
        }
      }
      if (method !== 'GET') this.store.audit(principal.id, 'request', path);
      return;
    });
    server.register('GET', '/api/auth/status', async (_body, headers) => {
      const identity = this.identify(headers);
      return {
        status: 200,
        body: {
          initialized: this.initialized,
          principal: identity?.principal,
          csrf: identity?.credential.csrf,
          platform: identity ? process.platform : undefined,
        },
        headers: { 'Cache-Control': 'no-store' },
      };
    });
    server.register('POST', '/api/auth/login', async (body, headers) => {
      try {
        const peer = digest(String(headers['x-cpx-peer'] ?? 'unknown'));
        const limit = this.store.get<{ count: number; until: number }>('login-limit', peer);
        if (limit && limit.until > Date.now() && limit.count >= 5)
          return { status: 429, body: { error: '尝试过多，请稍后重试' } };
        const input = z
          .object({ token: z.string().max(256).optional(), password: z.string().min(12).max(1024) })
          .parse(JSON.parse(body.toString()));
        const admin = this.store.get<Account>('account', 'admin');
        const valid = !admin
          ? Boolean(input.token && digest(input.token) === this.bootstrapHash)
          : verifyPassword(input.password, admin.password ?? '');
        if (!valid) {
          this.store.put('login-limit', peer, {
            count: limit && limit.until > Date.now() ? limit.count + 1 : 1,
            until: Date.now() + 600_000,
          });
          this.store.audit('anonymous', 'login', 'admin', 'denied');
          return { status: 401, body: { error: '凭据无效' } };
        }
        if (!admin) {
          const salt = secret();
          this.store.put<Account>('account', 'admin', {
            id: 'admin',
            name: '管理员',
            role: 'admin',
            projects: [],
            password: `${salt}:${scryptSync(input.password, salt, 64).toString('hex')}`,
          });
          rmSync(this.bootstrapPath, { force: true });
          this.bootstrapHash = undefined;
        }
        this.store.remove('login-limit', peer);
        const session = this.issue('admin', 'browser', true);
        this.store.audit('admin', 'login', 'browser');
        return {
          status: 200,
          body: { csrf: session.csrf, principal: this.account('admin') },
          headers: {
            'Cache-Control': 'no-store',
            'Set-Cookie': `cpx_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${String(headers.origin ?? '').startsWith('https:') ? '; Secure' : ''}`,
          },
        };
      } catch {
        return { status: 400, body: { error: '请输入有效的初始化令牌（首次）和至少 12 位密码' } };
      }
    });
    server.register('POST', '/api/auth/logout', async (_body, headers) => {
      const identity = this.identify(headers);
      if (!identity || (!identity.bearer && headers['x-cpx-csrf'] !== identity.credential.csrf))
        return { status: 403, body: { error: '请求校验失败' } };
      this.store.remove('credential', identity.credential.id);
      return {
        status: 200,
        body: { success: true },
        headers: { 'Set-Cookie': 'cpx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' },
      };
    });
  }

  principal(headers: RequestContext['headers']): Principal {
    const principal = this.account(String(headers['x-cpx-user'] ?? ''));
    if (!principal) throw new Error('请先登录');
    return principal;
  }
}

function verifyPassword(password: string, saved: string): boolean {
  const [salt, value] = saved.split(':');
  if (!salt || !value) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(value, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
