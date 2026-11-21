import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { WORKSPACE_SESSION_MIGRATIONS } from '../storage/migrations';

export type SessionTurnStatus =
  'queued' | 'naming' | 'creating' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SessionTurn {
  id: string;
  storyId?: string;
  status: SessionTurnStatus;
  createdAt: number;
  description: string;
  response?: string;
  error?: string;
}

export const terminalStatuses = new Set<SessionTurnStatus>(['completed', 'failed', 'cancelled']);
const turnColumns =
  'id, story_id AS storyId, status, created_at AS createdAt, description, response, error';
const activeTurn = "status IN ('queued', 'naming', 'creating', 'running')";

export class WorkspaceSessions {
  private readonly db: Database.Database;

  constructor(gitDirectory: string) {
    const directory = join(gitDirectory, 'cpx');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, 'sessions.db'));
    this.db.transaction(() => {
      for (const sql of WORKSPACE_SESSION_MIGRATIONS) this.db.exec(sql);
    })();
  }

  reserve(turn: SessionTurn): void {
    this.db
      .transaction(() => {
        this.recoverInterruptedTurn();
        if (this.db.prepare(`SELECT id FROM workspace_session_turns WHERE ${activeTurn}`).get()) {
          throw new Error('当前工作区有正在运行的会话，请等待这一轮结束');
        }
        this.db
          .prepare(
            `INSERT INTO workspace_session_turns
        (id, story_id, status, created_at, owner_pid, description) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            turn.id,
            turn.storyId ?? null,
            turn.status,
            turn.createdAt,
            process.pid,
            turn.description,
          );
      })
      .immediate();
  }

  save(turn: SessionTurn): void {
    this.db
      .prepare(
        'UPDATE workspace_session_turns SET story_id = ?, status = ?, response = ?, error = ? WHERE id = ?',
      )
      .run(turn.storyId ?? null, turn.status, turn.response ?? null, turn.error ?? null, turn.id);
  }

  bindThread(storyId: string, threadId: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(threadId)) throw new Error('Codex 线程 ID 无效');
    this.db
      .prepare(
        'INSERT INTO workspace_sessions (story_id, thread_id) VALUES (?, ?) ON CONFLICT(story_id) DO NOTHING',
      )
      .run(storyId, threadId);
    if (this.thread(storyId) !== threadId) throw new Error('Codex 返回了与会话绑定不一致的线程');
  }

  thread(storyId: string): string | undefined {
    return this.db
      .prepare<[string], { threadId: string }>(
        'SELECT thread_id AS threadId FROM workspace_sessions WHERE story_id = ?',
      )
      .get(storyId)?.threadId;
  }

  storyIds(): string[] {
    return this.db
      .prepare<[], { storyId: string }>(
        `SELECT sessions.story_id AS storyId
         FROM workspace_sessions AS sessions
         JOIN workspace_session_turns AS turns ON turns.story_id = sessions.story_id
         GROUP BY sessions.story_id
         ORDER BY MAX(turns.rowid) DESC`,
      )
      .all()
      .map(({ storyId }) => storyId);
  }

  latest(storyId?: string): SessionTurn | undefined {
    this.recoverInterruptedTurn();
    if (storyId) {
      return this.db
        .prepare<[string], SessionTurn>(
          `SELECT ${turnColumns} FROM workspace_session_turns WHERE story_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(storyId);
    }
    return this.db
      .prepare<[], SessionTurn>(
        `SELECT ${turnColumns} FROM workspace_session_turns WHERE ${activeTurn}`,
      )
      .get();
  }

  get(id: string): SessionTurn | undefined {
    this.recoverInterruptedTurn();
    return this.db
      .prepare<[string], SessionTurn>(
        `SELECT ${turnColumns} FROM workspace_session_turns WHERE id = ?`,
      )
      .get(id);
  }

  turns(storyId: string): SessionTurn[] {
    return this.db
      .prepare<[string], SessionTurn>(
        `SELECT ${turnColumns} FROM workspace_session_turns WHERE story_id = ? ORDER BY rowid`,
      )
      .all(storyId);
  }

  close(): void {
    this.db.close();
  }

  private recoverInterruptedTurn(): void {
    const turn = this.db
      .prepare<[], { id: string; pid: number }>(
        `SELECT id, owner_pid AS pid FROM workspace_session_turns WHERE ${activeTurn}`,
      )
      .get();
    if (!turn) return;
    try {
      process.kill(turn.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      this.db
        .prepare(
          `UPDATE workspace_session_turns SET status = 'failed', error = ? WHERE id = ? AND ${activeTurn}`,
        )
        .run('cpx 已中断上一轮，可继续此会话', turn.id);
    }
  }
}
