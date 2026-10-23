import { randomUUID } from 'crypto';
import { DatabaseService } from '../storage/Database';
import type { AgentTask } from '../agents/AgentTaskManager';

export class WorkbenchStore {
  constructor(readonly db: DatabaseService) {}

  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT payload FROM workbench_records WHERE kind = ? AND id = ?')
      .get(kind, id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }

  list<T>(kind: string): T[] {
    return (
      this.db
        .prepare('SELECT payload FROM workbench_records WHERE kind = ? ORDER BY updated_at DESC')
        .all(kind) as { payload: string }[]
    ).map((row) => JSON.parse(row.payload) as T);
  }

  put<T>(kind: string, id: string, value: T): T {
    this.db
      .prepare(
        'INSERT INTO workbench_records(kind,id,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',
      )
      .run(kind, id, JSON.stringify(value), Date.now());
    return value;
  }

  remove(kind: string, id: string): void {
    this.db.prepare('DELETE FROM workbench_records WHERE kind = ? AND id = ?').run(kind, id);
  }

  audit(actor: string, action: string, target: string, result = 'success'): void {
    this.db
      .prepare(
        'INSERT INTO audit_logs(id,timestamp,action,user_id,operation,result) VALUES(?,?,?,?,?,?)',
      )
      .run(randomUUID(), Date.now(), `workbench_${action}`, actor, target, result);
  }

  saveTask(task: AgentTask): void {
    this.db.transaction(() => {
      const { turns, ...snapshot } = task;
      this.db
        .prepare(
          'INSERT INTO coding_tasks(id,status,owner_id,project_id,snapshot,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,owner_id=excluded.owner_id,project_id=excluded.project_id,snapshot=excluded.snapshot,updated_at=excluded.updated_at',
        )
        .run(
          task.id,
          task.status,
          task.ownerId ?? 'admin',
          task.projectId ?? null,
          JSON.stringify(snapshot),
          task.updatedAt,
        );
      for (const [position, turn] of turns.entries()) {
        this.db
          .prepare(
            'INSERT INTO coding_turns(id,task_id,position,status,payload) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
          )
          .run(turn.id, task.id, position, turn.status, JSON.stringify(turn));
      }
      if (
        task.origin &&
        ['completed', 'review', 'failed', 'cancelled', 'interrupted'].includes(task.status) &&
        (!['cancelled', 'interrupted'].includes(task.status) || task.stopConfirmed)
      ) {
        const turn = turns[turns.length - 1];
        if (turn) {
          const id = `${task.id}:${turn.id}:${task.recoveryCount ?? 0}:${task.status}`;
          if (!this.get('notice', id)) {
            const snapshot = {
              ...task,
              logs: [],
              context: undefined,
              result: task.result ? { ...task.result, diff: '' } : undefined,
            };
            this.put('notice', id, {
              id,
              taskId: task.id,
              turnId: turn.id,
              attempts: 0,
              nextAt: Date.now(),
              snapshot,
            });
          }
        }
      }
    });
  }

  loadTasks(): AgentTask[] {
    return (
      this.db.prepare('SELECT id,snapshot FROM coding_tasks ORDER BY updated_at ASC').all() as {
        id: string;
        snapshot: string;
      }[]
    ).map((row) => ({
      ...JSON.parse(row.snapshot),
      turns: (
        this.db
          .prepare('SELECT payload FROM coding_turns WHERE task_id = ? ORDER BY position')
          .all(row.id) as { payload: string }[]
      ).map((turn) => JSON.parse(turn.payload)),
    }));
  }
}
