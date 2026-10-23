import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

/** Fail closed across containers: a stopped container's stale lock is removed in the file manager. */
export class InstanceLock {
  private readonly path: string;
  private readonly id = randomUUID();
  private readonly onExit = (): void => this.release();
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.path = join(directory, '.cpx-instance.lock');
    try {
      const previous = JSON.parse(readFileSync(this.path, 'utf8')) as { host: string; pid: number };
      if (previous.host === hostname() && Number.isInteger(previous.pid) && previous.pid > 0) {
        try {
          process.kill(previous.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(this.path);
        }
      }
    } catch {
      /* Missing or malformed locks are handled by exclusive creation below. */
    }
    try {
      writeFileSync(
        this.path,
        JSON.stringify({ id: this.id, host: hostname(), pid: process.pid }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch {
      throw new Error(
        '数据目录已有实例锁。请先确认旧实例或容器已停止；异常重建容器后，可通过文件管理器删除 data/.cpx-instance.lock，再重新启动。不能让两个实例共享运行目录。',
      );
    }
    process.once('exit', this.onExit);
  }

  assert(): void {
    const current = JSON.parse(readFileSync(this.path, 'utf8')) as { id?: string };
    if (current.id !== this.id) throw new Error('实例锁已变化，拒绝执行');
  }

  release(): void {
    process.removeListener('exit', this.onExit);
    try {
      this.assert();
      rmSync(this.path);
    } catch {
      /* Never delete a replacement owner's lock. */
    }
  }
}
