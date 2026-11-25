import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspaceWebToken } from '../../../src/web/WorkspaceWebToken';

describe('远程工作区访问密码', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cpx-workspace-token-'));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('首次远程启动生成随机密码，重启复用且文件仅属主可读写', () => {
    const first = resolveWorkspaceWebToken('0.0.0.0', '', directory);
    const file = join(directory, 'workspace-web-token');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveWorkspaceWebToken('::', undefined, directory)).toBe(first);
    expect(resolveWorkspaceWebToken('0.0.0.0', '', join(directory, 'other'))).not.toBe(first);
  });

  it('环境变量优先且不覆盖已有密码，取消覆盖后恢复原密码', () => {
    const original = resolveWorkspaceWebToken('0.0.0.0', undefined, directory);
    const configured = 'short';
    expect(resolveWorkspaceWebToken('0.0.0.0', ` ${configured} `, directory)).toBe(configured);
    expect(resolveWorkspaceWebToken('0.0.0.0', '', directory)).toBe(original);
    expect(resolveWorkspaceWebToken('0.0.0.0', configured, join(directory, 'unused'))).toBe(configured);
    expect(existsSync(join(directory, 'unused'))).toBe(false);
  });

  it('回环实例保留本机访问，显式令牌仍然生效', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(resolveWorkspaceWebToken(host, undefined, directory)).toBeUndefined();
    }
    expect(existsSync(join(directory, 'workspace-web-token'))).toBe(false);
    expect(resolveWorkspaceWebToken('127.0.0.1', 'a', directory)).toBe('a');
  });

  it('复用已有的短令牌文件，并去掉首尾空白', () => {
    const file = join(directory, 'workspace-web-token');
    writeFileSync(file, ' a\r\n');
    expect(resolveWorkspaceWebToken('0.0.0.0', '', directory)).toBe('a');
    expect(readFileSync(file, 'utf8')).toBe(' a\r\n');
  });

  it('空白令牌文件报告启动错误并保留原文件', () => {
    const file = join(directory, 'workspace-web-token');
    writeFileSync(file, ' \n');
    expect(() => resolveWorkspaceWebToken('0.0.0.0', '', directory)).toThrow('令牌文件为空');
    expect(readFileSync(file, 'utf8')).toBe(' \n');
  });
});
