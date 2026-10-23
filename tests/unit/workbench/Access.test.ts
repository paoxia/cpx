import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HttpServer } from '../../../src/core/HttpServer';
import { DatabaseService } from '../../../src/storage/Database';
import { Logger } from '../../../src/utils/Logger';
import { WorkbenchStore } from '../../../src/workbench/Store';
import { AccessControl } from '../../../src/workbench/Access';
import type { AgentTask } from '../../../src/agents/AgentTaskManager';

describe('HTTP authentication and authorization', () => {
  let root: string;
  let db: DatabaseService;
  let store: WorkbenchStore;
  let access: AccessControl;
  let server: HttpServer;
  let url: string;
  const task = { id: 'task-a', ownerId: 'alice', projectId: 'project-a' } as AgentTask;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cpx-access-'));
    db = new DatabaseService(join(root, 'agent.db'), new Logger('error'));
    store = new WorkbenchStore(db);
    access = new AccessControl(store, root);
    server = new HttpServer(0, '127.0.0.1', new Logger('error'));
    access.attach(server, (id) => (id === task.id ? task : undefined));
    for (const [method, path] of [
      ['GET', '/api/console/task'],
      ['POST', '/api/console/task/publish'],
      ['POST', '/api/console/task/continue'],
      ['POST', '/command'],
      ['POST', '/api/console/settings'],
    ])
      server.register(method, path, async (_body, headers) => ({
        status: 200,
        body: { actor: headers['x-cpx-user'] },
      }));
    await server.start();
    url = `http://127.0.0.1:${server.getPort()}`;
  });
  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, headers = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('requires bootstrap possession, stores a password hash and removes the bootstrap file', async () => {
    expect((await fetch(`${url}/api/console/task?id=task-a`)).status).toBe(401);
    expect(
      (await post('/api/auth/login', { token: 'wrong', password: 'correct-password' })).status,
    ).toBe(401);
    const token = readFileSync(join(root, 'bootstrap-token.txt'), 'utf8');
    const response = await post('/api/auth/login', { token, password: 'correct-password' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(() => readFileSync(join(root, 'bootstrap-token.txt'))).toThrow();
    expect(JSON.stringify(access.listAccounts())).not.toContain('password');
    expect(JSON.stringify(store.get('account', 'admin'))).not.toContain('correct-password');
  });

  it('validates CSRF and origin, and invalidates a logged-out session', async () => {
    const response = await post('/api/auth/login', {
      token: readFileSync(join(root, 'bootstrap-token.txt'), 'utf8'),
      password: 'correct-password',
    });
    const { csrf } = (await response.json()) as { csrf: string };
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    expect((await post('/command', {}, { Cookie: cookie })).status).toBe(403);
    expect(
      (
        await post(
          '/command',
          {},
          { Cookie: cookie, 'X-Cpx-Csrf': csrf, Origin: 'https://attacker.example' },
        )
      ).status,
    ).toBe(403);
    expect((await post('/command', {}, { Cookie: cookie, 'X-Cpx-Csrf': csrf })).status).toBe(200);
    expect(
      (await post('/api/auth/logout', {}, { Cookie: cookie, 'X-Cpx-Csrf': csrf })).status,
    ).toBe(200);
    expect((await post('/command', {}, { Cookie: cookie, 'X-Cpx-Csrf': csrf })).status).toBe(401);
  });

  it('denies another user even when trusted header names are forged; revocation applies immediately', async () => {
    access.saveAccount({ id: 'bob', name: 'Bob', role: 'requester', projects: ['project-a'] });
    const credential = access.issue('bob', 'client');
    const headers = {
      Authorization: `Bearer ${credential.token}`,
      'X-Cpx-User': 'admin',
      'X-Cpx-Role': 'admin',
    };
    expect((await fetch(`${url}/api/console/task?id=task-a`, { headers })).status).toBe(403);
    expect((await post('/command', {}, headers)).status).toBe(403);
    store.remove('credential', credential.id);
    expect((await fetch(`${url}/api/console/task?id=task-a`, { headers })).status).toBe(401);
  });

  it('allows reviewers to review and publish, but not continue or edit configuration', async () => {
    access.saveAccount({
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      projects: ['project-a'],
    });
    const credential = access.issue('reviewer', 'review');
    const headers = { Authorization: `Bearer ${credential.token}` };
    expect((await fetch(`${url}/api/console/task?id=task-a`, { headers })).status).toBe(200);
    expect((await post('/api/console/task/publish', { id: 'task-a' }, headers)).status).toBe(200);
    expect((await post('/api/console/task/continue', { id: 'task-a' }, headers)).status).toBe(403);
    expect((await post('/api/console/settings', {}, headers)).status).toBe(403);
    access.saveAccount({
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      projects: [],
      disabled: true,
    });
    expect((await fetch(`${url}/api/console/task?id=task-a`, { headers })).status).toBe(401);
  });

  it('rate limits failed authentication without disclosing the password or token', async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (await post('/api/auth/login', { token: 'invalid', password: 'incorrect-password' }))
          .status,
      ).toBe(401);
    expect(
      (await post('/api/auth/login', { token: 'invalid', password: 'incorrect-password' })).status,
    ).toBe(429);
    expect(JSON.stringify(store.list('login-limit'))).not.toContain('incorrect-password');
  });
});
