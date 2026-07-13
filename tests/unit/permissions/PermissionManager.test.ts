import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DatabaseService } from '../../../src/storage/Database';
import { PendingConfirmationStore } from '../../../src/permissions/PendingConfirmationStore';
import { PermissionManager, matchGlob } from '../../../src/permissions/PermissionManager';
import { Logger } from '../../../src/utils/Logger';
import type { Command, PermissionConfig } from '../../../src/core/types';

const TMP_DIR = join(process.cwd(), 'tmp-test-perm');
const DB_PATH = join(TMP_DIR, 'test.db');

function makeCommand(overrides: Partial<Command> = {}): Command {
  return {
    id: 'cmd-1',
    source: 'dingtalk',
    userId: 'user-1',
    userName: 'Tester',
    rawText: 'test',
    name: 'github_modify',
    args: { file: 'README.md', description: 'test' },
    timestamp: Date.now(),
    ...overrides,
  };
}

function makePermConfig(overrides: Partial<PermissionConfig> = {}): PermissionConfig {
  return {
    git: {
      protectedBranches: ['main', 'master', 'production'],
      allowedBranches: ['feature/*', 'dev/*', 'hotfix/*'],
      forbiddenOperations: ['force_push', 'delete_branch'],
      confirmOperations: ['delete_file', 'github_delete'],
    },
    operations: { blacklist: ['dangerous_cmd'] },
    confirmationTtl: 300,
    ...overrides,
  };
}

describe('PermissionManager', () => {
  let db: DatabaseService;
  let store: PendingConfirmationStore;
  let pm: PermissionManager;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    db = new DatabaseService(DB_PATH, new Logger('error'));
    store = new PendingConfirmationStore(db, 300);
    pm = new PermissionManager(makePermConfig(), store);
  });

  afterEach(() => {
    db.close();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('允许普通 github 操作', () => {
    const cmd = makeCommand({ name: 'github_modify' });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(true);
  });

  it('禁止黑名单命令', () => {
    const cmd = makeCommand({ name: 'dangerous_cmd' });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('黑名单');
  });

  it('禁止操作保护分支', () => {
    const cmd = makeCommand({ args: { branch: 'main' } });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('受保护');
  });

  it('禁止操作不在允许列表的分支', () => {
    const cmd = makeCommand({ args: { branch: 'random-branch' } });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('不在允许列表');
  });

  it('允许操作符合 glob 的分支', () => {
    const cmd = makeCommand({ args: { branch: 'feature/new-feature' } });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(true);
  });

  it('禁止的 git 操作被拦截', () => {
    const cmd = makeCommand({ args: { operation: 'force_push' } });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('禁止');
  });

  it('危险操作需确认', () => {
    const cmd = makeCommand({ name: 'delete_file', args: { file: 'important.ts' } });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.confirmationId).toMatch(/^cf_[a-f0-9]+$/);
  });

  it('已确认的危险操作放行', () => {
    const cmd = makeCommand({ name: 'delete_file', confirmed: true });
    const result = pm.check(cmd);
    expect(result.allowed).toBe(true);
  });

  it('confirm/cancel 命令本身放行', () => {
    expect(pm.check(makeCommand({ name: 'confirm' })).allowed).toBe(true);
    expect(pm.check(makeCommand({ name: 'cancel' })).allowed).toBe(true);
  });
});

describe('PendingConfirmationStore', () => {
  let db: DatabaseService;
  let store: PendingConfirmationStore;

  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    db = new DatabaseService(DB_PATH, new Logger('error'));
    store = new PendingConfirmationStore(db, 300);
  });

  afterEach(() => {
    db.close();
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('创建并获取确认记录', () => {
    const cmd = makeCommand();
    const pending = store.create(cmd, 'delete_file', '删除 important.ts');
    expect(pending.id).toMatch(/^cf_/);
    expect(pending.status).toBe('pending');

    const fetched = store.get(pending.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.operation).toBe('delete_file');
  });

  it('确认操作需同用户同渠道', () => {
    const cmd = makeCommand();
    const pending = store.create(cmd, 'delete_file', '删除文件');

    // 不同用户确认失败
    const r1 = store.confirm(pending.id, 'other-user', 'dingtalk');
    expect(r1.ok).toBe(false);

    // 同用户同渠道确认成功
    const r2 = store.confirm(pending.id, 'user-1', 'dingtalk');
    expect(r2.ok).toBe(true);
    expect(r2.confirmation!.status).toBe('confirmed');
  });

  it('已确认记录不能再次确认', () => {
    const cmd = makeCommand();
    const pending = store.create(cmd, 'delete_file', '删除文件');
    store.confirm(pending.id, 'user-1', 'dingtalk');
    const r = store.confirm(pending.id, 'user-1', 'dingtalk');
    expect(r.ok).toBe(false);
  });

  it('获取原始命令用于重派', () => {
    const cmd = makeCommand({ name: 'delete_file', args: { file: 'a.ts' } });
    const pending = store.create(cmd, 'delete_file', '删除 a.ts');
    const original = store.getOriginalCommand(pending.id);
    expect(original).not.toBeNull();
    expect(original!.name).toBe('delete_file');
    expect(original!.args.file).toBe('a.ts');
  });

  it('取消操作', () => {
    const cmd = makeCommand();
    const pending = store.create(cmd, 'delete_file', '删除文件');
    const r = store.reject(pending.id, 'user-1');
    expect(r.ok).toBe(true);
    expect(store.get(pending.id)!.status).toBe('rejected');
  });
});

describe('matchGlob', () => {
  it('精确匹配', () => {
    expect(matchGlob('main', 'main')).toBe(true);
    expect(matchGlob('main', 'dev')).toBe(false);
  });

  it('通配符匹配', () => {
    expect(matchGlob('feature/*', 'feature/new-thing')).toBe(true);
    expect(matchGlob('feature/*', 'feature/a/b')).toBe(true);
    expect(matchGlob('feature/*', 'dev/x')).toBe(false);
  });

  it('? 单字符通配', () => {
    expect(matchGlob('hotfix/?', 'hotfix/a')).toBe(true);
    expect(matchGlob('hotfix/?', 'hotfix/ab')).toBe(false);
  });
});
