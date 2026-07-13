/**
 * 数据库表结构定义
 */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    params TEXT,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_command ON tasks(command_id)`,

  `CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    action TEXT NOT NULL,
    user_id TEXT,
    source TEXT,
    command_id TEXT,
    operation TEXT,
    result TEXT,
    details TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp)`,

  `CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    description TEXT,
    entry TEXT NOT NULL,
    permissions TEXT NOT NULL,
    source TEXT NOT NULL,
    source_url TEXT,
    path TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    loaded INTEGER DEFAULT 0
  )`,

  `CREATE TABLE IF NOT EXISTS mcp_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    transport TEXT NOT NULL,
    command TEXT,
    args TEXT,
    env TEXT,
    url TEXT,
    status TEXT NOT NULL,
    capabilities TEXT,
    pid INTEGER,
    connected_at INTEGER,
    error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT,
    env TEXT,
    timeout INTEGER NOT NULL,
    registered_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS pending_confirmations (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    operation TEXT NOT NULL,
    description TEXT,
    command_json TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    confirmed_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_confirmations_status ON pending_confirmations(status)`,
  `CREATE INDEX IF NOT EXISTS idx_confirmations_expires ON pending_confirmations(expires_at)`,
];
