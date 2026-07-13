import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';

/**
 * 轻量级日志器：控制台彩色输出 + 可选文件输出
 */
export class Logger {
  private level: LogLevel;
  private file?: string;
  private isTTY: boolean;
  private prefix?: string;

  constructor(level: LogLevel = 'info', file?: string, prefix?: string) {
    this.level = level;
    this.file = file;
    this.prefix = prefix;
    this.isTTY = process.stdout.isTTY ?? false;
    if (file) {
      const dir = dirname(resolve(file));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(prefix: string): Logger {
    const childPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new Logger(this.level, this.file, childPrefix);
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log('debug', msg, args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.log('info', msg, args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.log('warn', msg, args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.log('error', msg, args);
  }

  private log(level: LogLevel, msg: string, args: unknown[]): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefixStr = this.prefix ? `[${this.prefix}]` : '';
    const formattedMsg = args.length > 0 ? `${msg} ${args.map(this.formatArg).join(' ')}` : msg;
    const line = `${timestamp} ${level.toUpperCase()} ${prefixStr} ${formattedMsg}`;

    // 控制台输出
    if (this.isTTY) {
      console.log(`${LEVEL_COLORS[level]}${line}${RESET}`);
    } else {
      console.log(line);
    }

    // 文件输出
    if (this.file) {
      try {
        const fileLine = `${line}\n`;
        if (existsSync(this.file)) {
          appendFileSync(this.file, fileLine);
        } else {
          writeFileSync(this.file, fileLine);
        }
      } catch {
        // 文件写入失败不影响主流程
      }
    }
  }

  private formatArg(arg: unknown): string {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack ?? ''}`;
    }
    if (typeof arg === 'object' && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }
}
