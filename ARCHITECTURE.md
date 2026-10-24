# 系统架构

本文描述 cpx 当前代码中的架构。产品范围见 [docs/PRODUCT.md](docs/PRODUCT.md)，使用方式见 [README.md](README.md)。

## 系统概览

cpx 是一个运行在单个 Node.js 进程中的 TypeScript 应用，可通过 `@paoxia/cpx` npm 包的全局 `cpx` 命令或 Docker 启动。它通过钉钉 Stream、飞书 WebSocket 长连接或本地 HTTP 测试端点接收命令，将命令解析后交给统一路由，并按需调用 GitHub、Coding Agent、Skill 或 MCP 模块。同一 HTTP 服务还提供 Web 开发控制台；聊天命令与控制台 API 复用一个 `AgentTaskManager`，把任务委托给本机 Codex CLI，并在额度耗尽或鉴权失败时按有序 Codex 配置自动切换。配置、连接状态、开发任务、轮次、身份、项目策略和审计记录存储在本地文件与 SQLite 中。控制端保持单进程，通过可选的出站轮询执行器运行远程任务。

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

开发控制台 API 不经过聊天语法解析器；HTTP 会话认证、任务授权与执行时策略检查先于业务操作。Web 和聊天开发命令汇合到同一个任务管理器：

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

控制台将多套 Codex 配置持久化到数据库相邻的 `console-settings.json`，每项包含 id、名称、模型和推理强度，不保存 API Key。`CodexModelCatalog` 在登录后运行 `codex debug models`，读取与交互式 `/model` 同源的账号模型目录以及每个模型支持的推理强度。`ModelConfigurationTester` 使用当前配置调用 Codex CLI，从 JSONL 事件中提取最终文本回复；测试内容和回复不持久化。消息协调和代码任务复用同一有序模型配置与额度/鉴权回退策略；协调会话记录自己的 Codex `thread_id`，但强制使用 `--skip-git-repo-check` 与只读沙箱。创建任务时，控制台或协调工具可通过 GitHub API 分页读取仓库分支；`AgentTaskManager` 首次把完整仓库克隆到 `repositories/<owner>/<repo>`，后续串行 fetch 同一缓存，并从远端基础分支创建独立 worktree。任务记录独立的 Codex `thread_id`，每个 turn 同时保存用户 prompt 与 Agent 最终回复；追加 prompt 时使用 `codex exec resume` 复用会话和工作区。Web 控制台以任务列表、会话流和统一底部输入框组织新建与续写，并增加成果、验证与独立发布区。Web 和聊天共用 local/review/auto 策略。协调会话 ID、任务、归属、轮次、日志和通知写入 SQLite，仓库缓存与工作区保存在磁盘。

GitHub 页在没有凭据时返回并展示预填权限的 fine-grained PAT 创建链接；PAT 由用户在 GitHub 生成并复制回控制台，cpx 不接管 GitHub OAuth。后端先调用 `/user` 和分页 `/user/repos` 验证，成功后才写入 `config.yaml`，并将内存中的 GitHub API 服务和 Agent 任务凭据同时更新；任务页通过分页 `/repos/{owner}/{repo}/branches` 读取分支。HTTPS Git 操作通过运行时生成且不含密钥的 askpass helper 从子进程环境读取 Token，`gh` 通过 `GH_TOKEN` 读取；密钥不进入远端 URL、命令参数或任务日志。环境变量来源只在状态接口中标识，不复制到配置文件。

`AgentAuthManager` 使用 `codex login --device-auth`、`codex login --with-api-key` 与 `codex login status` 管理官方 CLI 登录。管理器只在内存中保留受长度限制的终端输出、验证地址和一次性设备码；授权进程退出后再次调用 status 命令复核。凭据的落盘和刷新由 Codex CLI 管理。服务停止或用户取消时会终止仍在等待的登录进程。

## 配置与状态

配置优先级从低到高为：代码默认值、`config.yaml`、`permissions.yaml`、`AGENT_` 环境变量。npm CLI 默认以 `CPX_HOME`（未设置时为 `~/.cpx`）为运行根目录，配置、数据、日志和 PID 分目录保存；配置中的相对存储、Skill 与日志路径以配置目录的父目录为基准解析。Docker 通过 `-d /app/config` 保持 `/app` 为运行根。运行时会监听 YAML 文件；目前热更新会应用日志级别与权限配置，其他组件仍使用启动时配置。

CLI 的后台模式重新执行同一个已编译入口，并在 `CPX_HOME/run` 保存结构化 PID 记录。`status` 同时检查进程和 `/health`，`stop` 只向该记录对应的进程发送 `SIGTERM`，不使用进程名匹配。配置命令写入 YAML 后立即经过与服务启动相同的 Zod 校验，展示时递归脱敏密钥字段。

SQLite 默认位于 `data/agent.db`。实际表结构以 `src/storage/migrations.ts` 为准，便于阅读的说明见 [docs/DATABASE.md](docs/DATABASE.md)。

## 工作站服务

`src/workbench/Access.ts` 管理一次性认领、scrypt 密码、会话、CSRF、令牌、角色和项目/任务权限。`Store.ts` 在事务中保存任务与有序轮次，并为终态创建唯一的通知事件。身份、项目版本、定时规则、短期绑定码、通知和执行器租约使用按类型与 ID 分区的 JSON 记录。

`AgentTaskManager` 保留内存索引，状态变化写入持久层，默认并发 1。仓库缓存锁只串行同仓库 fetch/worktree 准备；每任务最多一个活动轮次。恢复检查工作区和分支，活动轮次在重启后变为 interrupted。独立临时 Git index 捕获基础提交到当前 tree 的结果，发布服务校验版本并推送固定提交，再查找或创建 PR。

`Workbench.ts` 提供项目规则、验证、任务动作、容量与保留策略、身份绑定、模板、定时任务、一致性备份与通知重试。`Schedules.ts` 校验规则并根据 IANA 时区计算每天定点或固定间隔的下次触发。定时规则和任务在 SQLite 事务中关联，默认生成待审查成果；显式自动交付需当前项目授权，执行与发布再次检查创建者及项目权限。

新闻模板把触发时刻、过去 24 小时窗口和目标日期固定到任务快照，并对该次 Codex 调用覆盖 `web_search="live"`，保留工具 shell 的网络限制。管理器从 stdout JSONL 记录完成的网页搜索；`src/agents/News.ts` 校验来源 JSON、时间窗口、重复 URL/标题和路径，再生成 Markdown。Git tree 校验限制新闻交付到当天的 Markdown 和来源 JSON。独立发布服务可按任务授权创建 PR；可选自动合并使用固定仓库、PR 编号、base/head 和 `--match-head-commit`，不绕过 GitHub 规则。请求成功不代表已合并，控制台明确显示“已请求”，最终状态以 GitHub 为准。

`Remote.ts` 管理执行器配对、90 秒租约、心跳和成果摘要校验；执行器不接收控制端长期凭据，返回补丁后由控制端核对、导入和验证。新闻任务向可信执行器传递采集要求与搜索模式，返回搜索次数证据；执行器和控制端均验证新闻交付。远程任务不提供控制端项目扩展。

`extensionMcpServer.ts` 为本机任务提供项目范围扩展桥，服务端每次重验身份、任务轮次、扩展授权和读写策略。`skillProcess.ts` 在子进程加载 Skill，父进程管理超时、进程组和能力 RPC。`InstanceLock` 阻止两个当前版本实例共享一个数据目录；跨容器旧锁需要在确认旧容器停止后通过文件管理器处理。

## 扩展方式

- 新命令：在 `CommandParser` 中定义语法，并通过 `CommandRouter.register` 注册处理器。
- 新聊天平台：实现消息校验、解析和结果推送，然后在 `AgentSystem` 中注册路由。
- 新 MCP 传输：实现 `Transport` 接口并在 `MCPManager` 中创建实例。
- 新 Skill：提供带 `skill.permissions` 的 npm 包并导出 `execute(ctx)`。
- 新 Coding Agent：在 `AgentTaskManager.runAgent` 中增加经过输入约束的非交互 CLI 适配。Agent 可在受控 GitHub 认证和 pre-push 主分支保护下推送任务分支；Pull Request 仍由管理器统一创建或更新。

## 当前边界

- 系统是单进程、单机 SQLite 架构，没有分布式任务调度。
- 控制台默认运行本机 Codex，具有持久队列和有限并发；排队项自动恢复，已开始的任务需核对后恢复。可选远程执行器通过 HTTPS 出站轮询领取租约任务，没有多控制端或自动重派未知执行。
- 控制台 API 由 `AccessControl` 检查身份与项目/任务权限，HTTP 操作黑名单和任务执行 guard 检查策略，工作站动作写入 SQLite 审计。聊天命令继续经过 `PermissionManager`。应用层授权、worktree 和 CLI 参数不能替代系统级执行隔离。
- 仓库提供面向单机和极空间 NAS 的 Dockerfile、Compose 配置与构建部署脚本；可选的 `docker-compose.mihomo.yml` 在同一 Docker 网络中增加显式 HTTP 代理伴随容器，但不改变 cpx 单进程架构。目前没有 Kubernetes 部署文件。
- Skill 在独立子进程运行，父进程通过有权限检查的 IPC 代理 GitHub/MCP；这提供故障和超时管理，不构成系统安全沙箱。
- HTTP 服务提供管理员会话、CSRF 与访问令牌；没有内置 TLS 或强租户隔离。部署边界和已知风险见 [docs/SECURITY.md](docs/SECURITY.md)。
