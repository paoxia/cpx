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

## 工作区会话数据库

每个本地工作区在其 Git 目录下独立保存 `cpx/sessions.db`。cpx 打开工作区会话时初始化数据库。

| 表 | 用途 | 主键 | 主要字段 |
|---|---|---|---|
| `workspace_sessions` | Story 与 Codex 线程的绑定 | `story_id` | `thread_id`（唯一） |
| `workspace_session_turns` | 用户消息、回复和运行状态 | `id` | `story_id`, `status`, `created_at`, `owner_pid`, `description`, `response`, `error` |
| `workspace_messaging_selections` | 各平台账号在对应聊天中的当前会话 | `route_key` | `story_id` 或 `run_id` |

轮次表按 `story_id` 索引。部分唯一索引限制同一工作区同时只有一轮处于等待、命名、创建或执行状态。运行服务退出后，cpx 将遗留的运行轮次标为失败，已保存的线程可继续使用。

显式切换记录 Story ID。发送文本时在写入轮次的同一事务中记录运行 ID，启动后由该轮次关联 Story 和 Codex 线程。
