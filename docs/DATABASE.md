# SQLite 表结构

本文从 `src/storage/migrations.ts` 整理，代码中的迁移定义是最终事实来源。数据库默认位于 `data/agent.db`，启动时通过 `CREATE TABLE/INDEX IF NOT EXISTS` 幂等初始化。

| 表 | 用途 | 主键 | 主要字段 |
|---|---|---|---|
| `tasks` | 任务参数、状态、结果与错误 | `id` | `command_id`, `type`, `status`, `params`, `result`, `error`, timestamps |
| `audit_logs` | 命令和敏感操作审计 | `id` | `timestamp`, `action`, `user_id`, `source`, `command_id`, `operation`, `result`, `details` |
| `skills` | 已安装 Skill 的 manifest 与加载状态 | `name` | `version`, `entry`, `permissions`, `source`, `source_url`, `path`, `installed_at`, `loaded` |
| `mcp_connections` | MCP 配置快照和连接状态 | `id` | `name`, `transport`, `command`, `args`, `env`, `url`, `status`, `capabilities`, `pid`, `connected_at`, `error` |
| `agents` | 为外部 Agent 注册预留的数据 | `id` | `name`, `type`, `command`, `args`, `env`, `timeout`, `registered_at` |
| `pending_confirmations` | 危险操作原命令、状态和有效期 | `id` | `command_id`, `user_id`, `source`, `operation`, `command_json`, `status`, `created_at`, `expires_at`, `confirmed_by` |

## 索引

- `idx_tasks_command`：`tasks(command_id)`
- `idx_audit_timestamp`：`audit_logs(timestamp)`
- `idx_confirmations_status`：`pending_confirmations(status)`
- `idx_confirmations_expires`：`pending_confirmations(expires_at)`

## 存储约定

- 时间值以 Unix 毫秒数存为 `INTEGER`。
- 参数、结果、权限、能力等结构化值以 JSON 文本存储。
- 业务层负责状态值和 JSON 结构的校验，SQLite 表本身未声明外键或 `CHECK` 约束。
- 当前只有初始化式迁移，没有版本表和增量迁移记录；修改现有结构前需要先建立兼容迁移策略。
