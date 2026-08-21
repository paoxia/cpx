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
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: 'secret-test-key',
      prompt: '请回复：测试成功',
    });
    child.stdout.write('{"type":"message","text":"CPX_MODEL_OK"}\n');
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      provider: 'codex',
      model: 'gpt-test',
      response: 'CPX_MODEL_OK',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining([
        '--skip-git-repo-check',
        '--model',
        'gpt-test',
        '--config',
        'openai_base_url="https://gateway.example.com/v1"',
      ]),
      expect.objectContaining({
        cwd: process.cwd(),
        env: expect.objectContaining({ CODEX_API_KEY: 'secret-test-key' }),
        windowsHide: true,
      }),
    );
    expect(child.stdin.read()?.toString()).toContain('请回复：测试成功');
  });

  it('应从 Codex JSONL 结果中提取回复并限制密钥泄露', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const tester = new ModelConfigurationTester(process.cwd(), new Logger('error'), spawnMock);

    const resultPromise = tester.test({
      provider: 'codex',
      apiKey: 'secret-value',
      prompt: '你好',
    });
    child.stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '中间回复' }] },
      })}\n`,
    );
    child.stdout.write(`${JSON.stringify({ type: 'result', result: '最终回复 secret-value' })}\n`);
    child.emit('close', 0);

    const result = await resultPromise;
    expect(result).toMatchObject({
      success: true,
      provider: 'codex',
      response: '最终回复 [REDACTED]',
    });
  });

  it('鉴权失败时应返回可展示结果且不泄露密钥', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const tester = new ModelConfigurationTester(process.cwd(), new Logger('error'), spawnMock);

    const resultPromise = tester.test({
      provider: 'codex',
      baseUrl: 'https://gateway.example.com',
      apiKey: 'secret-value',
    });
    child.stderr.write('401 unauthorized: secret-value\n');
    child.emit('close', 1);

    const result = await resultPromise;
    expect(result).toMatchObject({ success: false, provider: 'codex' });
    expect(result.message).toContain('鉴权失败');
    expect(result.message).not.toContain('secret-value');
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_API_KEY: 'secret-value',
        }),
      }),
    );
  });
});
