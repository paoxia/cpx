import { createHash, randomBytes } from 'crypto';
import type { DatabaseService } from '../storage/Database';

export type WorkspaceMessagingPlatform = 'feishu' | 'dingtalk';
const pairingLifetime = 10 * 60_000;
const receiptLifetime = 24 * 60 * 60_000;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export class WorkspaceMessagingAccess {
  constructor(private readonly db: DatabaseService) {}

  issue(platform: WorkspaceMessagingPlatform, app: string, root: string) {
    const code = randomBytes(9).toString('hex');
    const expiresAt = Date.now() + pairingLifetime;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workspace_messaging_pairings WHERE platform = ? OR expires_at <= ?')
        .run(platform, Date.now());
      this.db.prepare('INSERT INTO workspace_messaging_pairings VALUES (?, ?, ?, ?, ?)')
        .run(platform, app, hash(code), root, expiresAt);
    });
    return { message: `绑定 ${code}`, expiresAt };
  }

  redeem(platform: WorkspaceMessagingPlatform, app: string, user: string, code: string): string | undefined {
    return this.db.transaction(() => {
      const claim = this.db.prepare(
        'DELETE FROM workspace_messaging_pairings WHERE platform = ? AND app = ? AND code_hash = ? AND expires_at > ? RETURNING root',
      ).get(platform, app, hash(code.toLowerCase()), Date.now()) as { root: string } | undefined;
      if (!claim) return undefined;
      this.db.prepare(
        'INSERT INTO workspace_messaging_bindings VALUES (?, ?, ?, ?) ON CONFLICT(platform, app, user_id) DO UPDATE SET root = excluded.root',
      ).run(platform, app, user, claim.root);
      return claim.root;
    });
  }

  root(platform: WorkspaceMessagingPlatform, app: string, user: string): string | undefined {
    return (this.db.prepare('SELECT root FROM workspace_messaging_bindings WHERE platform = ? AND app = ? AND user_id = ?')
      .get(platform, app, user) as { root: string } | undefined)?.root;
  }

  list(platform: WorkspaceMessagingPlatform, app: string) {
    return this.db.prepare(`SELECT user_id AS userId, root FROM workspace_messaging_bindings WHERE platform = ? AND app = ? AND root <> '' ORDER BY user_id`)
      .all(platform, app);
  }

  revoke(platform: WorkspaceMessagingPlatform, app: string, user: string): void {
    this.db.prepare("UPDATE workspace_messaging_bindings SET root = '' WHERE platform = ? AND app = ? AND user_id = ?")
      .run(platform, app, user);
  }

  accept(platform: WorkspaceMessagingPlatform, app: string, messageId: string): boolean {
    return this.db.transaction(() => {
      const now = Date.now();
      this.db.prepare('DELETE FROM workspace_messaging_receipts WHERE received_at < ?').run(now - receiptLifetime);
      return this.db.prepare('INSERT OR IGNORE INTO workspace_messaging_receipts VALUES (?, ?, ?, ?)')
        .run(platform, app, messageId, now).changes === 1;
    });
  }
}
