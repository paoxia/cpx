# 系统架构

本文描述 cpx 当前代码中的架构。产品范围见 [docs/PRODUCT.md](docs/PRODUCT.md)，使用方式见 [README.md](README.md)。

## 系统概览

cpx 是一个运行在单个 Node.js 进程中的 TypeScript 应用。它通过 HTTP 接收钉钉、飞书或本地测试命令，将命令解析后交给统一路由，并按需调用 GitHub、Skill 或 MCP 模块。同一 HTTP 服务还提供 Web 开发控制台，把任务委托给本机 Codex 或 Claude Code CLI。配置、连接状态和审计记录存储在本地文件与 SQLite 中。

```text
钉钉 / 飞书 / HTTP
        │
        ▼
    HttpServer
        │
        ▼
Webhook 校验 → CommandParser → PermissionManager → CommandRouter
                                              │
                 ┌────────────────────────────┼──────────────────────────┐
                 ▼                            ▼                          ▼
          GitHubService                  SkillManager                MCPManager
                 │                            │                          │
                 └────────────────────────────┴──────────────────────────┘
                                              │
                                              ▼
                                    SQLite / 日志 / 平台回传
```

开发控制台使用独立数据流，不经过聊天命令解析器和权限管理器：

```text
浏览器 → WebConsole API → AgentTaskManager → Git 隔离克隆 → Codex / Claude Code
                                                          └→ Git + gh（显式选择创建 PR 时）
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
4. 对应处理器调用 GitHub、Skill 或 MCP 服务。
5. 结果写入审计日志，并由 `ResponseFormatter` 转换为来源平台的消息格式。

控制台创建任务后，`AgentTaskManager` 将 GitHub 仓库浅克隆到数据库相邻的 `workspaces/<task-id>`，创建 `cpx/task-<id>` 分支，并以非交互模式启动所选 CLI。未选择创建 PR 时，改动只保留在本地工作区；选择后才执行提交、推送和 `gh pr create`。任务及最近 800 条日志保存在进程内，工作区保存在磁盘。

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
- 控制台任务不经过聊天命令的 `PermissionManager` 与 SQLite 审计；其边界是独立 Git 克隆、CLI 沙箱参数以及创建任务时的 PR 显式选择。
- 仓库中目前没有 Docker 或 Kubernetes 部署文件。
- Skill 在主进程内以 Node.js 模块执行，不构成安全沙箱。
- HTTP 服务没有通用认证层；部署边界和已知风险见 [docs/SECURITY.md](docs/SECURITY.md)。
