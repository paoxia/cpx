import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { CodexModelCatalog } from '../../../src/web/CodexModelCatalog';

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

describe('CodexModelCatalog', () => {
  it('应读取与 /model 相同的 CLI 目录并保留模型支持的推理强度', async () => {
    const child = fakeProcess();
    const spawnMock = vi.fn(() => child) as unknown as typeof spawn;
    const catalog = new CodexModelCatalog(spawnMock);
    const resultPromise = catalog.list();

    child.stdout.write(JSON.stringify({
      models: [
        {
          slug: 'gpt-test',
          display_name: 'GPT Test',
          description: '测试模型',
          visibility: 'list',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
        },
        { slug: 'hidden-model', visibility: 'hide' },
      ],
    }));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      source: 'codex-cli',
      models: [{
        id: 'gpt-test',
        displayName: 'GPT Test',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium', 'high'],
      }],
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'codex',
      ['debug', 'models'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('CLI 返回失败时应给出明确错误', async () => {
    const child = fakeProcess();
    const catalog = new CodexModelCatalog(vi.fn(() => child) as unknown as typeof spawn);
    const resultPromise = catalog.list();
    child.stderr.write('not logged in\n');
    child.emit('close', 1);
    await expect(resultPromise).rejects.toThrow('not logged in');
  });
});
