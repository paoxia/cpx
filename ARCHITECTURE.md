# 系统架构

本文描述 cpx 当前代码中的架构。产品范围见 [docs/PRODUCT.md](docs/PRODUCT.md)，使用方式见 [README.md](README.md)。

## 系统概览

cpx 是一个运行在单个 Node.js 进程中的 TypeScript 应用。它通过 HTTP 接收钉钉、飞书或本地测试命令，将命令解析后交给统一路由，并按需调用 GitHub、Coding Agent、Skill 或 MCP 模块。同一 HTTP 服务还提供 Web 开发控制台；聊天命令与控制台 API 复用同一个 `AgentTaskManager`，把任务委托给本机 Codex 或 Claude Code CLI，并在额度耗尽或鉴权失败时按有序模型配置自动切换。配置、连接状态和审计记录存储在本地文件与 SQLite 中。

```text
钉钉 / 飞书 / HTTP
        │
        ▼
    HttpServer
        │
        ▼
Webhook 校验 → CommandParser → PermissionManager → CommandRouter
                                              │
                 ┌──────────────────┬─────────┼───────────┬──────────────┐
                 ▼                  ▼         ▼           ▼
          GitHubService      AgentTaskManager SkillManager MCPManager
                 │                  │         │           │
                 └──────────────────┴─────────┴───────────┘
                                              │
                                              ▼
                                    SQLite / 日志 / 平台回传
```

开发控制台 API 不经过聊天命令解析器和权限管理器，但与聊天开发命令汇合到同一个任务管理器：

```text
浏览器 → WebConsole API ─────────────┐
                                    ├→ AgentTaskManager → Git 隔离克隆 → Codex / Claude Code
聊天 → CommandRouter → WebConsole ──┘                                      └→ Git + gh

浏览器 → WebConsole API → AgentAuthManager → Codex / Claude Code 官方 CLI 登录与状态检查
```

`AgentSystem` 是编排根，负责创建组件、注册命令和 HTTP 路由，并管理启动与停止顺序。

## 核心组件

| 目录                  | 职责                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `src/core/`           | 生命周期、HTTP 服务、命令解析和路由、结果格式化、事件分发        |
| `src/config/`         | 合并默认值、YAML 与环境变量，并用 Zod 校验；监听 YAML 热更新     |
| `src/integrations/`   | 钉钉与飞书 Webhook 解析、签名校验和结果推送                      |
| `src/github/`         | GitHub REST API、文件读写、功能分支和 Pull Request 流程          |
| `src/skills/`         | Skill 安装记录、动态加载、执行超时和受限上下文注入               |
| `src/mcp/`            | JSON-RPC 2.0 与 stdio、WebSocket、HTTP 三种 MCP 传输             |
| `src/agents/`         | 克隆 GitHub 仓库、启动本机 Coding Agent、跟踪任务并按授权创建 PR |
| `src/web/`、`public/` | 控制台静态资源、模型设置和任务 HTTP API                          |
| `src/permissions/`    | 命令黑名单、Git 分支规则、危险操作确认和审计记录                 |
| `src/storage/`        | SQLite 连接与幂等建表迁移                                        |
| `src/utils/`          | 日志、HTTP、重试和错误类型                                       |

## 请求流程

1. `HttpServer` 接收请求。`/webhook/dingtalk` 和 `/webhook/feishu` 先进行平台校验；`/command` 用于本地调试。
2. `CommandParser` 去除平台前缀，将中英文文本转换为统一的 `Command`。
3. `CommandRouter` 调用 `PermissionManager`。被禁止的命令直接拒绝；需要确认的命令写入 SQLite，确认后重新分派原命令。
4. 对应处理器调用 GitHub、Coding Agent、Skill 或 MCP 服务。聊天开发命令先通过 GitHub API 验证仓库、基础分支和新分支，再创建异步任务。
5. 即时受理结果写入审计日志，并由 `ResponseFormatter` 转换为来源平台的消息格式。Coding Agent 进入完成、失败或取消状态后，会通过同一平台的结果推送器再次发送终态和 PR 链接。

控制台将有序 Agent 关联项持久化到数据库相邻的 `console-settings.json`，每项只包含 id 与 provider。模型页面只编辑 Codex/Claude Code 类型与执行顺序；模型名、Base URL 和 API Key 完全沿用对应 CLI 或服务进程环境，加载旧设置时会迁移到版本 4 并删除这些历史覆盖字段。每条关联项内提供测试区；`ModelConfigurationTester` 使用对应 CLI 的已有配置发送用户内容，从 Codex 或 Claude Code JSONL 事件中提取最终文本回复，并在长度限制后返回原关联项下方。测试内容和回复不持久化。创建任务时，控制台或聊天命令可通过 GitHub API 分页读取仓库分支；选择现有分支后，`AgentTaskManager` 以它为浅克隆基线并创建自动 `cpx/task-<id>` 分支，选择新建分支时则使用用户提供的合法名称，Pull Request 明确以所选基础分支为 base。Agent 按关联项顺序启动 CLI，同一 provider 可以在顺序中出现多次。Web 控制台只有显式选择时才创建 PR；聊天开发命令默认创建 PR。聊天任务在内存中记录来源平台与用户，只有创建者能通过消息查询或取消。任务及最近 800 条日志保存在进程内，工作区保存在磁盘。

GitHub 页在没有凭据时返回并展示预填权限的 fine-grained PAT 创建链接；PAT 由用户在 GitHub 生成并复制回控制台，cpx 不接管 GitHub OAuth。后端先调用 `/user` 和分页 `/user/repos` 验证，成功后才写入 `config.yaml`，并将内存中的 GitHub API 服务和 Agent 任务凭据同时更新；任务页通过分页 `/repos/{owner}/{repo}/branches` 读取分支。HTTPS Git 操作通过运行时生成且不含密钥的 askpass helper 从子进程环境读取 Token，`gh` 通过 `GH_TOKEN` 读取；密钥不进入远端 URL、命令参数或任务日志。环境变量来源只在状态接口中标识，不复制到配置文件。

`AgentAuthManager` 以 provider 配置统一管理官方 CLI 登录：Codex 使用 `codex login --device-auth` 与 `codex login status`，Claude Code 使用 `claude auth login` 与 JSON 格式的 `claude auth status`。管理器只在内存中保留受长度限制的终端输出、验证地址和一次性设备码；Claude Code CLI 需要手工输入时，控制台可把完整 callback 地址中的 `code` 或授权码写入等待进程的 stdin。授权进程退出后再次调用对应 status 命令复核；凭据的落盘和刷新完全由官方 CLI 管理。服务停止或用户取消时会终止仍在等待的登录进程。

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
- 控制台只调度本机 Codex 与 Claude Code CLI，没有远程 Agent 注册、持久化队列、并发调度或重启恢复。
- 控制台 API 任务不经过聊天命令的 `PermissionManager` 与 SQLite 命令审计；聊天开发命令经过命令黑名单检查并记录委托及终态审计。两类任务都以独立 Git 克隆和 CLI 沙箱参数为执行边界。
- 仓库提供面向单机和极空间 NAS 的 Dockerfile、Compose 配置与构建部署脚本；可选的 `docker-compose.mihomo.yml` 在同一 Docker 网络中增加显式 HTTP 代理伴随容器，但不改变 cpx 单进程架构。目前没有 Kubernetes 部署文件。
- Skill 在主进程内以 Node.js 模块执行，不构成安全沙箱。
- HTTP 服务没有通用认证层；部署边界和已知风险见 [docs/SECURITY.md](docs/SECURITY.md)。
