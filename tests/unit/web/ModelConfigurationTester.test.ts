import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../../src/utils/Logger';
import { ModelConfigurationTester } from '../../../src/web/ModelConfigurationTester';

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

describe('ModelConfigurationTester', () => {
  it('应使用对应 CLI、模型和密钥执行最小探测请求', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const tester = new ModelConfigurationTester(process.cwd(), new Logger('error'), spawnMock);

    const resultPromise = tester.test({
      provider: 'codex',
      model: 'gpt-test',
      apiKey: 'secret-test-key',
    });
    child.stdout.write('{"type":"message","text":"CPX_MODEL_OK"}\n');
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      provider: 'codex',
      model: 'gpt-test',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['--model', 'gpt-test']),
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({ CODEX_API_KEY: 'secret-test-key' }),
        windowsHide: true,
      }),
    );
    expect(child.stdin.read()?.toString()).toContain('CPX_MODEL_OK');
  });

  it('鉴权失败时应返回可展示结果且不泄露密钥', async () => {
    const child = fakeProcess();
    const tester = new ModelConfigurationTester(
      process.cwd(),
      new Logger('error'),
      vi.fn(() => child) as unknown as typeof spawn,
    );

    const resultPromise = tester.test({ provider: 'claude', apiKey: 'secret-value' });
    child.stderr.write('401 unauthorized: secret-value\n');
    child.emit('close', 1);

    const result = await resultPromise;
    expect(result).toMatchObject({ success: false, provider: 'claude' });
    expect(result.message).toContain('鉴权失败');
    expect(result.message).not.toContain('secret-value');
  });
});
