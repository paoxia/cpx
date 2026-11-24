import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { expect, it, vi } from 'vitest';
import { CodexSandboxProbe } from '../../../src/web/CodexSandboxProbe';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const run = vi.fn(() => child);
  return { child, run, probe: new CodexSandboxProbe(process.cwd(), run as unknown as typeof spawn) };
}

it('使用固定命令验证真实 workspace-write 沙箱，不调用模型', async () => {
  const { child, run, probe } = fixture();
  const result = probe.test('workspace-write');
  child.stdout.write('CPX_SANDBOX_OK');
  child.emit('close', 0);
  expect(await result).toMatchObject({ success: true });
  expect(run.mock.calls[0][1]).toContain('sandbox_mode="workspace-write"');
  expect(run.mock.calls[0][1]).not.toContain('danger-full-access');
});

it('bwrap 权限错误提示更新 Compose 并重建，不能报告成功或自动禁用沙箱', async () => {
  const { child, probe } = fixture();
  const result = probe.test('workspace-write');
  child.stderr.write('bwrap: No permissions to create a new namespace');
  child.emit('close', 1);
  expect(await result).toMatchObject({ success: false, message: expect.stringContaining('security_opt') });
});

it('CLI 不存在时返回明确检查结果', async () => {
  const { child, probe } = fixture();
  const result = probe.test('workspace-write');
  child.emit('error', new Error('spawn codex ENOENT'));
  expect(await result).toMatchObject({ success: false, message: expect.stringContaining('CLI') });
});

it('完全访问模式直接执行固定命令，不启动 codex sandbox', async () => {
  const { child, run, probe } = fixture();
  const result = probe.test('danger-full-access');
  child.stdout.write('CPX_SANDBOX_OK');
  child.emit('close', 0);
  expect(await result).toMatchObject({ success: true, message: expect.stringContaining('已关闭') });
  expect(run.mock.calls[0][0]).toBe(process.execPath);
  expect(run.mock.calls[0][1]).not.toContain('sandbox');
});

it('只读模式按保存的模式检查', async () => {
  const { child, run, probe } = fixture();
  const result = probe.test('read-only');
  child.stdout.write('CPX_SANDBOX_OK');
  child.emit('close', 0);
  expect(await result).toMatchObject({ success: true });
  expect(run.mock.calls[0][1]).toContain('sandbox_mode="read-only"');
});
