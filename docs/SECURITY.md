# 安全说明

本文记录当前代码实际提供的安全控制和已知边界。它不是通用 Web 安全清单。

## 需要保护的资产

- 钉钉、飞书和 GitHub 凭据。
- MCP 连接参数及其可访问的外部资源。
- Skill 获得的文件系统、网络、GitHub 或 MCP 能力。
- SQLite 中的命令确认、Skill 元数据、连接状态和审计记录。
- Coding Agent 的 CLI 凭据、GitHub 工作区、任务提示与执行日志。

## 当前控制

### 消息平台长连接

钉钉 Stream 和飞书 WebSocket 均由服务主动发起出站连接，使用应用凭据鉴权，不注册入站 HTTP 回调，也不保存固定群机器人 Webhook。应用 Secret 属于敏感配置，状态 API 只返回是否已配置。

### Git 操作限制

权限管理器支持：

- 受保护分支列表，默认包含 `main`、`master` 和 `production`。
- 允许分支的 glob 列表，默认允许 `feature/*`、`dev/*` 和 `hotfix/*`。
- 禁止 Git 操作列表。
- 需要二次确认的操作列表。

确认记录保存在 SQLite 中，带过期时间，并校验确认用户与命令来源。权限 YAML 可热更新。

### 审计

系统记录命令接收、完成或失败，以及 Skill、MCP 和危险操作相关事件。审计数据保存在本地 SQLite；当前没有远程防篡改存储或内置清理策略。

### 配置校验

配置按默认值、YAML、环境变量的顺序合并，再通过 Zod 校验。敏感值不应写入版本控制；部署时优先使用环境变量或外部密钥管理系统。

## 重要边界

### HTTP 端点

`/command` 和 `/api/console/*` 没有认证；`/health` 公开返回进程状态。`/api/internal/agent-platform-tool` 没有通用登录层，但每次请求必须同时提供任务 ID 和该任务的随机 Bearer Token。控制台 API 能启动代码执行并在显式选择后推送 GitHub 分支，其权限高于普通只读管理页面。若监听 `0.0.0.0`，必须由防火墙或带认证的反向代理限制访问，不应直接暴露到公网。

HTTP 请求体上限为 10 MB，但当前服务没有内置 TLS、速率限制或通用身份认证。公网部署需要由可信网关提供这些能力。

控制台静态资源设置了 CSP、禁止 MIME 嗅探并拒绝被其他页面嵌入，但这些响应头不能替代访问认证。

### Coding Agent 执行

- GitHub 仓库完整缓存位于数据库相邻的 `repositories/<owner>/<repo>`；每个任务在独立 Git worktree 中执行，不直接修改缓存的主工作树或 cpx 自身工作区。
- Codex 使用页面保存的审批和沙箱配置。这些是 CLI 执行约束，不是容器或操作系统级隔离。
- Agent 会继承服务进程环境并使用 Codex CLI 的凭据。Web 设置保存配置名称、登录账号模型目录中的模型和该模型支持的推理强度，不保存 API Key；任务输出仍可能包含 Agent 或工具主动打印的敏感信息。
- 每条 Agent 关联项内的测试区会启动一次短生命周期 CLI 子进程并产生真实模型请求。用户输入和提取后的 Agent 文本回复通过无缓存 API 返回但不持久化，回复限制为 16 KiB。不要在测试内容中提交无关敏感数据，也不要假定模型回复天然可信。
- Codex 登录在服务进程用户下执行，长期凭据由官方 CLI 写入其凭据目录，不写入项目配置。Docker 将该目录映射到宿主机 `data/codex`，必须按密钥材料保护。一次性设备码和登录输出会经无缓存控制台 API 返回或短暂保存在内存中，因此控制台访问者等同于能够发起或观察该用户的授权；必须通过可信网络和访问控制保护。
- 未选择创建 Pull Request 时不执行提交和推送。选择后系统会暂存工作区全部改动并使用当前 Git/`gh` 身份推送，因此必须在提交前审查目标仓库、提示和运行日志。
- 钉钉和飞书没有任务时会在独立空目录启动协调 Codex，并强制使用非 Git 模式和只读沙箱；协调 Agent 只能通过受限工具查询 GitHub、创建或管理当前用户任务。代码修改仍必须进入独立 Git worktree。聊天开发任务默认创建 Pull Request，并使用当前配置的 GitHub Token 与 Codex CLI 身份。
- 协调会话和消息任务都会向 Codex 子进程环境注入随机范围 Token 和本机回调地址，用于 `cpx_platform` MCP 工具。Token 不写入任务快照、命令参数或日志；服务端同时校验 Token、范围 ID、平台和用户归属。平台工具不接受目标用户或会话参数，可查询仓库/分支、创建或管理当前用户任务、向绑定原会话发送最多 6000 字符文本；调用写入 `agent_platform_tool` 审计。该 Token 仍属于运行时能力，获得 Codex 子进程环境读取权限的代码可以使用它，因此不应把不可信仓库视为强隔离输入。
- 任务状态、Codex `thread_id` 与日志没有写入 SQLite，重启即丢失；完整仓库缓存、worktree 和未提交改动会继续保留在磁盘。

### Skill 不是沙箱

Skill 通过 `npm install` 安装并在主 Node.js 进程中使用 `require` 加载。manifest 中的权限决定是否向执行上下文注入 GitHub 和 MCP 服务，但不能阻止恶意 Node.js 代码直接访问进程、文件系统或网络。

只安装可信来源的 Skill。对不可信插件应使用独立容器或受限进程；当前仓库尚未实现这种隔离。

### 外部连接

- GitHub Token 应使用满足任务所需的最小权限，并限制到必要仓库。
- GitHub 页生成的是外部 PAT 创建链接，Token 必须由用户从 GitHub 手工复制回填；服务不会接收 GitHub 账号密码或 OAuth refresh token。
- 验证成功的 GitHub Token 以明文保存在 `config/config.yaml`（环境变量来源除外），应限制配置目录读取权限。HTTPS Git 子进程通过环境变量和不含 Token 的 askpass helper 鉴权，不得把 Token 拼入远端 URL 或记录到任务日志。
- stdio MCP 可以启动本地进程，配置文件本身应视为可执行权限。
- WebSocket 与 HTTP MCP 地址应指向可信服务，生产环境使用加密传输。
- 可选的 Mihomo 部署把代理配置保存在 `data/mihomo/config.yaml`；其中的订阅地址和节点凭据属于密钥材料。默认 Compose 不向宿主机映射 Mihomo 代理或控制端口，不应为方便调试把这些端口直接暴露到公网。
- `APT_MIRROR` 和 `NPM_REGISTRY` 允许镜像构建使用第三方 Debian/npm 镜像；构建者必须信任所选镜像服务并审查构建输出。这些值只作为 build args 使用，不应携带认证凭据，也不会写入最终容器环境。
- 日志与错误信息不得包含 Token、应用 Secret 或完整敏感负载。

## 生产部署最低要求

1. 为钉钉和飞书配置最小权限的应用凭据，并限制机器人可用范围。
2. 不对公网开放 `/command`、控制台页面或 `/api/console/*`；通过网络策略限制管理入口。
3. 在 TLS 终止、认证和限流网关之后运行服务。
4. 使用最小权限 GitHub Token，并限制 Skill 与 MCP 来源。
5. 限制配置、SQLite、日志、Skill 安装目录、`data/repositories` 和 `data/workspaces` 的文件权限。
6. 定期执行 `npm audit`、备份 SQLite，并审查审计记录。

## 漏洞处理

安全问题不应在公开 Issue 中附带密钥、利用代码或用户数据。项目建立私密报告渠道前，请先联系仓库维护者并仅提供最小复现信息。
