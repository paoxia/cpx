# SQLite 表结构

本文从 `src/storage/migrations.ts` 整理，代码中的迁移定义是最终事实来源。数据库默认位于 `data/agent.db`，启动时通过 `CREATE TABLE/INDEX IF NOT EXISTS` 幂等初始化。

| 表 | 用途 | 主键 | 主要字段 |
|---|---|---|---|
| `coding_tasks` | 当前开发任务快照与可查询归属 | `id` | `status`, `owner_id`, `project_id`, `snapshot`, `updated_at` |
| `coding_turns` | 有序任务轮次 | `id` | `task_id`, `position`, `status`, `payload` |
| `workbench_records` | 身份、项目版本、策略、通知和执行器等分类记录 | `(kind,id)` | `payload`, `updated_at` |
| `tasks` | 任务参数、状态、结果与错误 | `id` | `command_id`, `type`, `status`, `params`, `result`, `error`, timestamps |
| `audit_logs` | 命令和敏感操作审计 | `id` | `timestamp`, `action`, `user_id`, `source`, `command_id`, `operation`, `result`, `details` |
| `skills` | 已安装 Skill 的 manifest 与加载状态 | `name` | `version`, `entry`, `permissions`, `source`, `source_url`, `path`, `installed_at`, `loaded` |
| `mcp_connections` | MCP 配置快照和连接状态 | `id` | `name`, `transport`, `command`, `args`, `env`, `url`, `status`, `capabilities`, `pid`, `connected_at`, `error` |
| `agents` | 为外部 Agent 注册预留的数据 | `id` | `name`, `type`, `command`, `args`, `env`, `timeout`, `registered_at` |
| `pending_confirmations` | 危险操作原命令、状态和有效期 | `id` | `command_id`, `user_id`, `source`, `operation`, `command_json`, `status`, `created_at`, `expires_at`, `confirmed_by` |

## 索引

- `idx_coding_tasks_owner`：`coding_tasks(owner_id,status)`
- `coding_turns(task_id,position)`：唯一约束，且 `task_id` 外键引用 `coding_tasks(id)`
- `idx_tasks_command`：`tasks(command_id)`
- `idx_audit_timestamp`：`audit_logs(timestamp)`
- `idx_confirmations_status`：`pending_confirmations(status)`
- `idx_confirmations_expires`：`pending_confirmations(expires_at)`

## 存储约定

- 时间值以 Unix 毫秒数存为 `INTEGER`。
- 参数、结果、权限、能力等结构化值以 JSON 文本存储。
- 业务层校验状态与 JSON 结构。新 `coding_turns` 使用任务外键与有序唯一约束；旧表不因此自动获得外键或 CHECK。开发任务的 snapshot 不重复保存 turns，轮次独立更新。
- `PRAGMA user_version` 当前为 1；启动幂等创建兼容表并设置版本，较高版本数据库被拒绝打开。后续非兼容迁移需要增加明确版本步骤与备份恢复说明。
- 终态任务与唯一通知事件在同一事务提交，外部 GitHub/消息操作通过独立重试与对账处理。
- 数据库和一致性备份文件限制为 0600；在线备份使用 better-sqlite3 backup API，不直接复制运行中的主文件。


## 工作站分类记录

| kind | 内容与边界 |
| --- | --- |
| `account` | 角色、项目列表、会话限制和管理员 scrypt 密码摘要 |
| `credential` | 会话/API 令牌摘要、用户引用、过期时间、会话 CSRF；不保存原始令牌 |
| `identity`, `binding-code`, `login-limit` | 显式平台绑定、一次性代码摘要、登录失败窗口 |
| `project`, `project-version` | 当前项目规则及不可变历史版本 |
| `settings`, `migration` | 容量、保留、发布策略与旧版发布迁移选择 |
| `continued`, `message-event` | 续写与平台事件持久去重；当前没有自动过期删除策略 |
| `coordinator`, `detached-conversation`, `feishu-route` | 协调会话 thread_id、脱离状态及飞书聊天路由；不保存运行时平台 Token |
| `notice` | 唯一任务/轮次/恢复阶段/终态通知、终态摘要快照、尝试次数、重试时间与送达状态 |
| `schedule` | 模板、固定间隔、显示时区、授权创建者和下次触发 |
| `worker`, `remote-job` | 配对令牌摘要、状态/能力与任务租约、补丁结果；未知执行不自动重派 |

`tasks` 与 `agents` 是旧表，不能用它们判断当前开发任务或远程执行器状态。备份包含账号摘要、任务提示和成果元信息，应作为敏感材料保护。
