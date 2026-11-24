import { spawn } from 'child_process';

export interface CodexSandboxResult {
  success: boolean;
  message: string;
  detail?: string;
}

/** 执行固定的无副作用命令，检查真实沙箱能否启动，不调用模型或降级权限。 */
export class CodexSandboxProbe {
  constructor(
    private readonly workingDirectory: string,
    private readonly spawnCommand: typeof spawn = spawn,
    private readonly timeoutMs = 15_000,
  ) {}

  test(): Promise<CodexSandboxResult> {
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
        'codex',
        [
          'sandbox',
          '--config',
          'sandbox_mode="workspace-write"',
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
        finish({ success: false, message: '无法启动 Codex CLI，请确认服务环境已安装 Codex。' }),
      );
      child.once('close', (code) => {
        if (code === 0 && output.includes('CPX_SANDBOX_OK')) {
          finish({ success: true, message: 'Codex 沙箱可正常执行命令，工作区隔离保持启用。' });
        } else {
          const blocked = /bwrap|namespace|seccomp|sandbox.*(?:denied|permitted)/i.test(output);
          finish({
            success: false,
            message: blocked
              ? '容器或宿主机阻止了 Codex 沙箱。请同步新版 Compose 的 security_opt 配置并重新创建 cpx 容器，再检查执行权限。'
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
