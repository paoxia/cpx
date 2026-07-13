import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import type { Transport } from './Transport';

/**
 * stdio 传输：spawn 子进程，通过 stdin/stdout 以换行分隔 JSON-RPC 消息。
 *
 * 适用场景：本地 MCP 服务器（如 npx @modelcontextprotocol/server-filesystem）。
 */
export class StdioTransport implements Transport {
  private command: string;
  private args: string[];
  private env?: Record<string, string>;
  private proc?: ChildProcess;
  private messageHandler?: (data: string) => void;
  private closeHandler?: () => void;
  private alive = false;
  private closed = false;

  constructor(command: string, args: string[] = [], env?: Record<string, string>) {
    this.command = command;
    this.args = args;
    this.env = env;
  }

  /** 子进程 PID（连接后可用） */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async connect(): Promise<void> {
    if (this.alive) {
      return;
    }
    const proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      windowsHide: true,
    });
    this.proc = proc;

    proc.on('error', (err) => {
      if (!this.closed) {
        this.alive = false;
        this.closed = true;
        this.closeHandler?.();
        throw err;
      }
    });

    proc.on('exit', () => {
      if (!this.closed) {
        this.alive = false;
        this.closed = true;
        this.closeHandler?.();
      }
    });

    // 按行读取 stdout
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed && this.messageHandler) {
        this.messageHandler(trimmed);
      }
    });

    // stderr 仅作日志输出（由调用方通过 logger 关注，这里输出到 console.error 兜底）
    const stderrChunks: string[] = [];
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
      // 防止 stderr 缓冲过多
      if (stderrChunks.length > 100) {
        stderrChunks.shift();
      }
    });

    this.alive = true;
  }

  async send(data: string): Promise<void> {
    if (!this.proc?.stdin || !this.alive) {
      throw new Error('stdio 传输未连接或已关闭');
    }
    return new Promise((resolve, reject) => {
      this.proc!.stdin!.write(`${data}\n`, (err) => {
        if (err) {
          reject(new Error(`写入 stdin 失败: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    if (this.closed || !this.proc) {
      this.alive = false;
      return;
    }
    this.closed = true;
    this.alive = false;
    const proc = this.proc;
    try {
      // 尝试优雅关闭 stdin
      proc.stdin?.end();
    } catch {
      // 忽略
    }
    // 给进程一点时间退出，超时则强制杀
    const exited = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // 忽略
        }
        resolve(false);
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    await exited;
  }

  isAlive(): boolean {
    return this.alive && !this.closed && !!this.proc;
  }
}
