# 系统架构

本文描述 cpx 当前代码中的架构。产品范围见 [docs/PRODUCT.md](docs/PRODUCT.md)，使用方式见 [README.md](README.md)。

## 系统概览

cpx 是一个运行在单个 Node.js 进程中的 TypeScript 应用。它通过钉钉 Stream、飞书 WebSocket 长连接或本地 HTTP 测试端点接收命令，将命令解析后交给统一路由，并按需调用 GitHub、Coding Agent、Skill 或 MCP 模块。同一 HTTP 服务还提供 Web 开发控制台；聊天命令与控制台 API 复用一个 `AgentTaskManager`，把任务委托给本机 Codex CLI，并在额度耗尽或鉴权失败时按有序 Codex 配置自动切换。配置、连接状态和审计记录存储在本地文件与 SQLite 中。

```text
钉钉 / 飞书 / HTTP
        │
        ▼
    HttpServer
        │
        ▼
平台长连接 → CommandParser → PermissionManager → CommandRouter
                                              │
                 ┌──────────────────┬─────────┼───────────┬──────────────┐
                 ▼                  ▼         ▼           ▼
          GitHubService      MessagingCoordinator   AgentTaskManager   Skill / MCP
                 │                  │         │           │
                 └──────────────────┴─────────┴───────────┘
                                              │
                                              ▼
                                    SQLite / 日志 / 平台回传
```

开发控制台 API 不经过聊天命令解析器和权限管理器，但与聊天开发命令汇合到同一个任务管理器：

```text
浏览器 → WebConsole API ─────────────┐
                                    ├→ AgentTaskManager → 完整仓库缓存 → Git worktree → Codex / resume
聊天 → CommandRouter → 协调 Codex ──cpx_platform MCP──┐
                         │                            │
                         └→ WebConsole ──────────────┴→ AgentTaskManager → worktree Codex → Git + gh
                                                       │ cpx_platform MCP
                                                       ▼
原会话 ← MessagingIntegration ← 会话/任务专属 Token 校验的 HTTP 路由

浏览器 → WebConsole API → AgentAuthManager → Codex 官方 CLI 登录与状态检查
浏览器 → WebConsole API → CodexModelCatalog → `codex debug models` → `/model` 同源目录
```

`AgentSystem` 是编排根，负责创建组件、注册命令和 HTTP 路由，并管理启动与停止顺序。

## 核心组件

| 目录                  | 职责                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| `src/core/`           | 生命周期、HTTP 服务、命令解析和路由、结果格式化、事件分发                           |
| `src/config/`         | 合并默认值、YAML 与环境变量，并用 Zod 校验；监听 YAML 热更新                        |
| `src/integrations/`   | 钉钉 Stream 与飞书 WebSocket 长连接、会话路由和结果推送                             |
| `src/github/`         | GitHub REST API、文件读写、功能分支和 Pull Request 流程                             |
| `src/skills/`         | Skill 安装记录、动态加载、执行超时和受限上下文注入                                  |
| `src/mcp/`            | JSON-RPC 2.0 与 stdio、WebSocket、HTTP 三种 MCP 传输                                |
| `src/agents/`         | 运行消息协调 Codex；同步仓库缓存、创建 worktree、持续运行任务 Codex 并按授权更新 PR |
| `src/web/`、`public/` | 控制台静态资源、模型设置和任务 HTTP API                                             |
| `src/permissions/`    | 命令黑名单、Git 分支规则、危险操作确认和审计记录                                    |
| `src/storage/`        | SQLite 连接与幂等建表迁移                                                           |
| `src/utils/`          | 日志、HTTP、重试和错误类型                                                          |

## 请求流程

1. `MessagingIntegrationManager` 主动建立钉钉 Stream 和飞书 WebSocket 连接；`HttpServer` 的 `/command` 仅用于本地测试与集成调试。
2. `CommandParser` 去除平台前缀，将飞书和钉钉普通文本转换为 `agent_chat`；仅 `/new`、`/tasks`、`/status`、`/stop`、`/help` 和确认流程保留确定性入口。旧文本命令继续兼容；当会话已有任务时，`AgentSystem` 会把非生命周期文本改回 `agent_chat`，避免旧命令抢走 Codex 上下文。
3. `CommandRouter` 调用 `PermissionManager`。被禁止的命令直接拒绝；需要确认的命令写入 SQLite，确认后重新分派原命令。
4. 当前会话没有任务时，`MessagingCoordinator` 在独立非 Git 目录中用只读沙箱启动或恢复 Codex。协调 Codex 只能通过 `cpx_platform` 查询仓库/分支和管理当前用户任务；仓库明确后由工具创建异步开发任务。已有任务时，文本直接恢复 worktree 中的任务 Codex。
5. 即时受理结果写入审计日志，并由 `ResponseFormatter` 转换为来源平台的消息格式。协调回复和 Coding Agent 终态都回到原会话。`cpx_platform` stdio 服务使用会话或任务专属 Bearer Token 访问内部 HTTP 路由；服务端固定平台、用户和会话，并再次校验任务归属。

控制台将多套 Codex 配置持久化到数据库相邻的 `console-settings.json`，每项包含 id、名称、模型和推理强度，不保存 API Key。`CodexModelCatalog` 在登录后运行 `codex debug models`，读取与交互式 `/model` 同源的账号模型目录以及每个模型支持的推理强度。`ModelConfigurationTester` 使用当前配置调用 Codex CLI，从 JSONL 事件中提取最终文本回复；测试内容和回复不持久化。消息协调和代码任务复用同一有序模型配置与额度/鉴权回退策略；协调会话记录自己的 Codex `thread_id`，但强制使用 `--skip-git-repo-check` 与只读沙箱。创建任务时，控制台或协调工具可通过 GitHub API 分页读取仓库分支；`AgentTaskManager` 首次把完整仓库克隆到 `repositories/<owner>/<repo>`，后续串行 fetch 同一缓存，并从远端基础分支创建独立 worktree。任务记录独立的 Codex `thread_id`，每个 turn 同时保存用户 prompt 与 Agent 最终回复；追加 prompt 时使用 `codex exec resume` 复用会话和工作区。Web 控制台以任务列表、会话流和统一底部输入框组织新建与续写，不展示 PR 发布入口；聊天开发任务默认创建 PR，后续轮次向同一分支和 PR 推送。协调会话、聊天任务和最近日志保存在进程内，仓库缓存与工作区保存在磁盘。

GitHub 页在没有凭据时返回并展示预填权限的 fine-grained PAT 创建链接；PAT 由用户在 GitHub 生成并复制回控制台，cpx 不接管 GitHub OAuth。后端先调用 `/user` 和分页 `/user/repos` 验证，成功后才写入 `config.yaml`，并将内存中的 GitHub API 服务和 Agent 任务凭据同时更新；任务页通过分页 `/repos/{owner}/{repo}/branches` 读取分支。HTTPS Git 操作通过运行时生成且不含密钥的 askpass helper 从子进程环境读取 Token，`gh` 通过 `GH_TOKEN` 读取；密钥不进入远端 URL、命令参数或任务日志。环境变量来源只在状态接口中标识，不复制到配置文件。

`AgentAuthManager` 使用 `codex login --device-auth`、`codex login --with-api-key` 与 `codex login status` 管理官方 CLI 登录。管理器只在内存中保留受长度限制的终端输出、验证地址和一次性设备码；授权进程退出后再次调用 status 命令复核。凭据的落盘和刷新由 Codex CLI 管理。服务停止或用户取消时会终止仍在等待的登录进程。

## 配置与状态

配置优先级从低到高为：代码默认值、`config.yaml`、`permissions.yaml`、`AGENT_` 环境变量。运行时会监听 YAML 文件；目前热更新会应用日志级别与权限配置，其他组件仍使用启动时配置。

SQLite 默认位于 `data/agent.db`。实际表结构以 `src/storage/migrations.ts` 为准，便于阅读的说明见 [docs/DATABASE.md](docs/DATABASE.md)。

## 扩展方式

- 新命令：在 `CommandParser` 中定义语法，并通过 `CommandRouter.register` 注册处理器。
- 新聊天平台：实现消息校验、解析和结果推送，然后在 `AgentSystem` 中注册路由。
- 新 MCP 传输：实现 `Transport` 接口并在 `MCPManager` 中创建实例。
- 新 Skill：提供带 `skill.permissions` 的 npm 包并导出 `execute(ctx)`。
- 新 Coding Agent：在 `AgentTaskManager.runAgent` 中增加经过输入约束的非交互 CLI 适配，并保持发布步骤由管理器统一执行。

## 当前边界

- 系统是单进程、单机 SQLite 架构，没有分布式任务调度。
- 控制台只调度本机 Codex CLI，没有远程 Agent 注册、持久化队列、并发调度或重启恢复。
- 控制台 API 任务不经过聊天命令的 `PermissionManager` 与 SQLite 命令审计；聊天开发命令经过命令黑名单检查并记录委托及终态审计。两类任务都以独立 Git worktree 和 CLI 沙箱参数为执行边界。
- 仓库提供面向单机和极空间 NAS 的 Dockerfile、Compose 配置与构建部署脚本；可选的 `docker-compose.mihomo.yml` 在同一 Docker 网络中增加显式 HTTP 代理伴随容器，但不改变 cpx 单进程架构。目前没有 Kubernetes 部署文件。
- Skill 在主进程内以 Node.js 模块执行，不构成安全沙箱。
- HTTP 服务没有通用认证层；部署边界和已知风险见 [docs/SECURITY.md](docs/SECURITY.md)。
