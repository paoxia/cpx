# 开发指南

## 环境与命令

项目要求 Node.js 18 或更高版本。安装依赖后可使用以下命令：

```bash
npm run dev <command>  # 直接运行 TypeScript CLI
npm run build          # 严格模式编译并生成声明文件
npm test               # 运行 Vitest 测试
npm run coverage       # 生成测试覆盖率
npm run lint           # 检查 src 下的 TypeScript
npm run format         # 格式化 src 下的 TypeScript
```

本地启动前先执行 `npm run dev init`，再编辑生成的 `config/config.yaml` 与 `config/permissions.yaml`。不要提交实际令牌、应用 Secret 或本地数据库。

## 代码组织

`src/core/AgentSystem.ts` 是依赖装配与生命周期入口。新增能力应放入对应领域目录，编排根只负责连接组件；完整目录职责见 [系统架构](../ARCHITECTURE.md#核心组件)。

测试按范围放置：

- `tests/unit/`：独立模块行为。
- `tests/integration/`：跨组件命令流程。
- `tests/fixtures/`：Skill 与 MCP 测试夹具。

## 实现约定

- 保持 TypeScript 严格模式通过，不使用隐式 `any`。
- 外部输入先解析和校验，再进入业务处理器。
- 平台差异留在 `src/integrations/` 和 `ResponseFormatter` 中，业务命令保持平台无关。
- 新命令同时补充解析、路由处理、权限行为和测试。
- 数据库变更追加到 `src/storage/migrations.ts`，建表语句必须可重复执行。
- 可恢复的外部调用失败应返回领域错误，不向用户暴露令牌或原始敏感响应。
- `AgentTaskManager` 中所有会访问 GitHub 的 `git`/`gh` 子进程必须通过统一的 `runGitHubProcess` 入口执行，禁止直接调用 `runProcess`，以确保 Token、AskPass 和非交互设置始终注入；本地 `status`、`add`、`commit` 和 `worktree` 操作仍使用普通入口。

## 改动验证

提交前至少运行：

```bash
npm run build
npm test
npm run lint
```

按改动类型补充验证：

| 改动         | 需要检查                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 命令语法     | 中英文解析、空参数、未知命令                                                                                                        |
| 消息长连接   | 启停、凭据更新、消息去重、原会话回复和异常负载                                                                                      |
| 权限         | 允许、拒绝、确认、过期四条路径                                                                                                      |
| GitHub/MCP   | 成功、超时、限流或断连                                                                                                              |
| Coding Agent | 输入校验、进程失败、取消、无改动和 PR 发布                                                                                          |
| Web 控制台   | 静态资源响应头、多套 Codex 配置、账号模型目录、密钥持久化与脱敏、Codex CLI 登录、GitHub PAT 引导与凭据注入、旧配置迁移和 API 错误码 |
| SQLite       | 新数据库初始化和已有数据库重复启动                                                                                                  |
| Docker/NAS   | Compose 解析、目标架构镜像、持久化目录、健康检查；当前开发代码的 NAS 试运行见 [NAS 开发调试指南](NAS-DEBUGGING.md)                  |

## 文档维护

- 用户入口和配置改动更新根 `README.md`。
- 组件关系或数据流改动更新根 `ARCHITECTURE.md`。
- 用户可观察行为改动更新 `docs/specs/agent-system.md`。
- 表结构改动后同步 `docs/DATABASE.md`。
- 不新增只有标题和占位符的文档；新文档必须从 [文档入口](README.md) 链接。
