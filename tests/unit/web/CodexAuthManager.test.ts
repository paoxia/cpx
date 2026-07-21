import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../../src/utils/Logger';
import { AgentAuthManager } from '../../../src/web/AgentAuthManager';

function fakeProcess(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [new PassThrough(), new PassThrough(), new PassThrough()],
    killed: false,
    connected: false,
    exitCode: null,
    signalCode: null,
    pid: 123,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
}

describe('AgentAuthManager', () => {
  it('应使用 codex login status 识别 ChatGPT 登录', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const manager = new AgentAuthManager('codex', new Logger('error'), spawnMock);

    const statusPromise = manager.getStatus();
    child.stdout.write('Logged in using ChatGPT\n');
    child.emit('close', 0);

    await expect(statusPromise).resolves.toMatchObject({
      state: 'authenticated',
      authenticated: true,
      cliAvailable: true,
      authMethod: 'ChatGPT',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['login', 'status'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('应从设备码登录输出提取验证地址和设备码，并在结束后复核状态', async () => {
    const loginProcess = fakeProcess();
    const statusProcess = fakeProcess();
    const processes = [loginProcess, statusProcess];
    const spawnMock = vi.fn(() => processes.shift()!) as unknown as typeof spawn;
    const manager = new AgentAuthManager('codex', new Logger('error'), spawnMock);

    await expect(manager.startLogin()).resolves.toMatchObject({ state: 'waiting' });
    loginProcess.stdout.write(
      '\u001b[32mOpen https://auth.openai.com/device and enter ABCD-EFGH\u001b[0m\n',
    );
    await expect(manager.getStatus()).resolves.toMatchObject({
      state: 'waiting',
      verificationUrl: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
    });

    loginProcess.emit('close', 0);
    statusProcess.stdout.write('Logged in using ChatGPT\n');
    statusProcess.emit('close', 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenLastCalledWith(
      'codex',
      ['login', 'status'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('应允许取消进行中的设备码登录', async () => {
    const child = fakeProcess();
    const manager = new AgentAuthManager(
      'codex',
      new Logger('error'),
      vi.fn(() => child) as unknown as typeof spawn,
    );

    await manager.startLogin();
    expect(manager.cancelLogin()).toBe(true);
    expect(child.kill).toHaveBeenCalled();
    expect(manager.cancelLogin()).toBe(false);
  });

  it('应识别 Claude Code JSON 状态并允许向登录进程提交 callback', async () => {
    const statusProcess = fakeProcess();
    const loginProcess = fakeProcess();
    const processes = [statusProcess, loginProcess];
    const spawnMock = vi.fn(() => processes.shift()!) as unknown as typeof spawn;
    const manager = new AgentAuthManager('claude', new Logger('error'), spawnMock);

    const statusPromise = manager.getStatus();
    statusProcess.stdout.write('{"loggedIn":true,"authMethod":"oauth_token"}');
    statusProcess.emit('close', 0);
    await expect(statusPromise).resolves.toMatchObject({
      provider: 'claude',
      authenticated: true,
      authMethod: 'oauth_token',
    });

    await manager.startLogin();
    loginProcess.stdout.write('Open https://claude.ai/oauth/authorize to continue\n');
    expect(
      manager.submitInput('http://localhost/callback?code=claude-code-value&state=state-value'),
    ).toMatchObject({ state: 'waiting' });
    expect(loginProcess.stdin.read()?.toString()).toBe('claude-code-value\n');
  });
});
