import { spawn } from 'child_process';
import { CodexSandboxMode, configuredCodexSandbox } from '../agents/CodexSandbox';

export interface CodexSandboxResult {
  success: boolean;
  message: string;
  detail?: string;
}

/** 按已保存的模式执行固定命令，不调用模型，也不在失败时自动降级权限。 */
export class CodexSandboxProbe {
  constructor(
    private readonly workingDirectory: string,
    private readonly spawnCommand: typeof spawn = spawn,
    private readonly timeoutMs = 15_000,
  ) {}

  test(mode: CodexSandboxMode = configuredCodexSandbox()): Promise<CodexSandboxResult> {
    const unsandboxed = mode === 'danger-full-access';
    return new Promise((resolve) => {
      let settled = false;
      let output = '';
      const finish = (result: CodexSandboxResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const child = this.spawnCommand(
        unsandboxed ? process.execPath : 'codex',
        unsandboxed ? ['-e', 'process.stdout.write("CPX_SANDBOX_OK")'] : [
          'sandbox',
          '--config',
          `sandbox_mode=${JSON.stringify(mode)}`,
          '--',
          process.execPath,
          '-e',
          'process.stdout.write("CPX_SANDBOX_OK")',
        ],
        {
          cwd: this.workingDirectory,
          env: process.env,
          shell: process.platform === 'win32',
          windowsHide: true,
        },
      );
      const timer = setTimeout(() => {
        child.kill();
        finish({ success: false, message: 'Codex 执行权限检查超时，请检查 CLI 和容器状态。' });
      }, this.timeoutMs);
      timer.unref();
      const append = (chunk: Buffer | string): void => {
        output = `${output}${String(chunk)}`.slice(-8192);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.once('error', () =>
        finish({ success: false, message: unsandboxed
          ? '直接命令执行失败，请检查服务运行环境。'
          : '无法启动 Codex CLI，请确认服务环境已安装 Codex。' }),
      );
      child.once('close', (code) => {
        if (code === 0 && output.includes('CPX_SANDBOX_OK')) {
          finish({ success: true, message: unsandboxed
            ? '直接命令执行正常；已关闭 Codex 内部沙箱，任务可访问服务进程有权限的文件与网络。'
            : 'Codex 沙箱可正常执行命令，工作区隔离保持启用。' });
        } else {
          const blocked = /bwrap|namespace|seccomp|sandbox.*(?:denied|permitted)/i.test(output);
          finish({
            success: false,
            message: unsandboxed ? '直接命令执行失败，请检查服务运行环境。' : blocked
              ? '容器或宿主机阻止了 Codex 沙箱。可显式保存完全访问模式以关闭内部沙箱，或同步 Compose 的 security_opt 配置并重新创建 cpx 容器。'
              : 'Codex 沙箱未能执行命令，请检查 CLI 与服务运行环境。',
            detail: output
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .slice(-3)
              .join('\n')
              .slice(0, 1000),
          });
        }
      });
      child.stdin?.end();
    });
  }
}
