# Agent System（cpx）

智能代理系统：通过钉钉/飞书远程控制、Skill 插件扩展、MCP 连接、GitHub 远程操作。

## 功能特性

- **钉钉/飞书远程控制** - 通过群机器人发送命令，随时随地执行任务
- **Skill 插件系统** - 从 npm/local/git 安装插件，动态加载执行
- **MCP 连接器** - 支持 stdio/websocket/http 三种传输协议连接外部 MCP 服务
- **GitHub 远程操作** - 读取、修改、创建文件并自动创建 PR
- **AI 开发控制台** - 在隔离工作区委托 Codex 或 Claude Code 完成开发任务，可选创建 PR
- **权限控制** - 主分支保护、危险操作二次确认、操作审计日志
- **命令中英双语** - 支持中文和英文命令（如 `修改` / `modify`）

## 环境要求

- Node.js >= 18.0
- npm >= 8.0

## 快速开始

```bash
# 安装依赖
npm install

# 初始化配置文件
npm run dev init
# 或: npx tsx src/cli.ts init

# 编辑配置，填写钉钉/飞书 Webhook、GitHub Token 等
# 编辑 config/config.yaml 和 config/permissions.yaml

# 启动系统
npm run dev start
# 或: npx tsx src/cli.ts start
```

启动后通过 HTTP 接口发送命令测试：

```bash
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"text":"version","userId":"u1","userName":"Tester","source":"cli"}'
```

浏览器访问 `http://localhost:3000/` 可打开 AI 开发控制台。运行控制台任务还需要：

- 本机已安装 `codex` 和/或 `claude` CLI，并已完成 CLI 登录、配置服务环境变量 API Key，或在模型设置中保存对应 API Key。
- 本机已安装 Git，且能访问目标 GitHub 仓库。
- 若勾选“创建 Pull Request”，还需安装并登录 GitHub CLI（`gh`），并具备推送分支和创建 PR 的权限。

控制台的 GitHub 页签可输入 Personal Access Token，验证当前 GitHub 身份并读取该 Token 可访问的全部个人、协作及组织仓库。新输入的 Token 仅在验证成功后写入 `config/config.yaml`；若 `github.token` 或 `AGENT_GITHUB_TOKEN` 已配置，可以留空直接验证，且不会将环境变量 Token 复制到配置文件。受限的 fine-grained Token 只会显示明确授权的仓库。仓库列表中的“用于新任务”可将仓库和默认分支带入任务控制台。

“模型设置”管理 Codex 和 Claude Code 的有序执行配置。每条配置可独立设置 Agent、模型名、可选 Base URL 和可选 API Key，并支持新增、删除及上下调整；同一 Agent 可配置多次，用于组合不同模型或网关。已保存的密钥不会回显，只展示来源和配置状态；新密钥会以明文写入本机 `console-settings.json`，应限制该文件的读取权限。点击“测试模型”可选择关联项、输入最多 4000 字的测试内容，并在终端区域查看 Agent 的实际文本回复；尚未保存的 Base URL 或密钥只用于本次测试，不会被测试接口持久化。任务默认使用第一条配置；启用自动切换时，额度耗尽或鉴权失败会按页面顺序继续尝试。

### 在远程服务器连接 Codex / Claude Code

如果不在模型配置中保存 API Key，也可以使用官方 CLI 登录。请在运行 cpx 的同一系统用户终端中执行 `codex login --device-auth`，然后按终端显示的验证地址和一次性设备码完成登录：

1. 在任意可信浏览器打开验证地址。
2. 登录拥有 Codex 权限的 ChatGPT 账号并输入设备码。
3. 执行 `codex login status` 验证结果，再到模型管理页测试对应配置。

Codex CLI 将凭据保存在运行 cpx 的系统用户自己的凭据目录，不写入 `console-settings.json`。如果设备码登录不可用，可在同一用户终端直接执行 `codex login`。不要把 callback 地址发到聊天、日志或截图中。参见 [Codex Authentication](https://learn.chatgpt.com/docs/auth)。

Claude Code 使用同一服务用户在终端执行 `claude auth login`，并通过 `claude auth status --json` 复核。Codex 和 Claude Code 凭据均由官方 CLI 保存和刷新，cpx 不直接持有 OAuth refresh token。

三端均可运行，但 cpx 服务必须与完成登录的 CLI 使用同一系统用户：

| 平台    | 支持方式                | 注意事项                                                                                                                                                            |
| ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | 原生 Node.js / Docker   | CLI 必须在 `PATH`；服务用户的 HOME 可写。Docker 已持久化 `/root/.codex` 和 `/root/.claude`。                                                                        |
| macOS   | 原生 Node.js            | Codex 可使用系统钥匙串或 `~/.codex`；Claude Code OAuth 凭据可能存入 macOS Keychain，因此后台服务需以完成授权的登录用户运行并具备钥匙串访问权。                      |
| Windows | 原生 PowerShell，或 WSL | cpx 会通过 shell 解析 npm 的 `.cmd` 包装脚本。Claude Code 原生 Windows 还需要 Git for Windows；也可把整套 cpx 部署在 WSL 中，避免混用 Windows 与 WSL 的 HOME/凭据。 |

不要在一个系统用户下授权、再让另一个服务账户运行 cpx，否则状态检查会显示未登录。

每个任务会克隆到数据库所在目录下的 `workspaces/<task-id>`，Agent 只在该克隆中执行。任务状态和日志保存在内存中，重启服务后不会恢复；工作区文件仍保留在磁盘。

> 控制台及 `/api/console/*` 当前没有身份认证，并可执行代码、读取仓库和推送分支。默认配置监听 `0.0.0.0`，请通过防火墙或带认证的反向代理限制访问，禁止直接暴露到公网。

## 极空间 Docker 部署

通过 Docker 镜像在极空间 NAS 上部署，用手机随时下发任务。详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

快速步骤：

1. 开发机执行 `scripts/docker-build.sh` 生成 `cpx-latest.tar.gz`
2. 把 `cpx-latest.tar.gz`、`docker-compose.yml`、`.docker.env.example`、`scripts/docker-deploy.sh` 传到极空间
3. NAS 上执行 `./docker-deploy.sh`，按提示编辑 `.docker.env`；Agent API Key 也可在启动后的模型设置中填写
4. 手机浏览器访问 `http://<NAS-IP>:3000`

## CLI 命令

```bash
agent-cli version          # 显示版本
agent-cli init [-d <dir>]  # 初始化配置文件到指定目录（默认 ./config）
agent-cli start [-d <dir>] # 启动系统
agent-cli stop             # 提示如何停止（通过 SIGTERM）
```

开发模式下使用 `npm run dev <command>`，例如 `npm run dev start`。

## 聊天命令

通过钉钉群 @机器人、飞书群 /agent、或 HTTP `/command` 端点发送。支持中英双语。

### 基础命令

| 命令                        | 说明             |
| --------------------------- | ---------------- |
| `version` / `版本`          | 查看版本         |
| `help` / `帮助`             | 显示帮助         |
| `列出 skill` / `list skill` | 列出已安装 Skill |
| `列出 mcp` / `list mcp`     | 列出 MCP 连接    |

### GitHub 操作

| 命令                            | 说明                     |
| ------------------------------- | ------------------------ |
| `读取文件 <file>`               | 读取 GitHub 仓库文件内容 |
| `修改 <file> <description>`     | 修改文件并创建 PR        |
| `新建文件 <file> <description>` | 创建新文件并创建 PR      |

示例：`@agent 修改 README.md 添加安装说明`

### Skill 执行

| 命令                  | 说明                    |
| --------------------- | ----------------------- |
| `执行 <skill> [json]` | 执行已安装的 Skill 插件 |

示例：`@agent 执行 code-review {"repo":"owner/repo"}`

### MCP 操作

| 命令                           | 说明                  |
| ------------------------------ | --------------------- |
| `连接mcp <名称>`               | 连接配置中的 MCP 服务 |
| `调用mcp <连接> <方法> [参数]` | 调用 MCP 方法         |
| `断开mcp <标识>`               | 断开 MCP 连接         |

示例：`@agent 调用mcp filesystem tools/list`

### 确认/取消

| 命令        | 说明         |
| ----------- | ------------ |
| `确认 <id>` | 确认危险操作 |
| `取消 <id>` | 取消危险操作 |

## 配置

配置文件位于 `config/` 目录，优先级从低到高：默认配置 < config.yaml < permissions.yaml < 环境变量。

### config.yaml

```yaml
server:
  port: 3000
  host: 0.0.0.0

dingtalk:
  webhookUrl: '' # https://oapi.dingtalk.com/robot/send?access_token=xxx
  secret: '' # SECxxx 加签密钥
  enableVerify: true # 是否校验签名

feishu:
  webhookUrl: '' # https://open.feishu.cn/open-apis/bot/v2/hook/xxx
  appId: ''
  appSecret: ''
  enableVerify: true

github:
  token: '' # ghp_xxx Personal Access Token
  defaultRepo: '' # owner/repo 默认仓库
  defaultBranch: main

skills:
  installPath: ./data/skills
  executionTimeout: 30000 # 毫秒

mcp:
  connections: []
  # stdio 传输（本地子进程）
  # - name: filesystem
  #   transport: stdio
  #   command: npx
  #   args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  # websocket 传输
  # - name: remote-ws
  #   transport: websocket
  #   url: ws://localhost:3001
  # http 传输
  # - name: remote-http
  #   transport: http
  #   url: http://localhost:3002/mcp

logging:
  level: info # debug | info | warn | error
  file: ./logs/agent.log

storage:
  path: ./data/agent.db
```

### permissions.yaml

```yaml
git:
  protectedBranches: [main, master, production]
  allowedBranches: [feature/*, dev/*, hotfix/*]
  forbiddenOperations: [force_push, delete_branch, delete_repository]
  confirmOperations: [delete_file, merge_to_main]

operations:
  blacklist: []

confirmationTtl: 300 # 确认超时秒数
```

### 环境变量

环境变量以 `AGENT_` 前缀覆盖配置文件，适合 Docker 部署：

```bash
AGENT_SERVER_PORT=3000
AGENT_DINGTALK_WEBHOOK_URL=https://...
AGENT_DINGTALK_SECRET=SECxxx
AGENT_FEISHU_WEBHOOK_URL=https://...
AGENT_FEISHU_APP_ID=cli_xxx
AGENT_FEISHU_APP_SECRET=xxx
AGENT_GITHUB_TOKEN=ghp_xxx
AGENT_GITHUB_DEFAULT_REPO=owner/repo
AGENT_LOGGING_LEVEL=info
AGENT_STORAGE_PATH=./data/agent.db
```

Coding Agent 密钥沿用 CLI 的原生环境变量：Codex 使用 `CODEX_API_KEY`，Claude Code 使用 `ANTHROPIC_API_KEY`。它们也可以在每条模型配置中单独保存；自定义 Base URL 仅在模型设置中逐项配置。

## HTTP API

### GET /

返回 AI 开发控制台。控制台使用以下 API：

| 端点                                       | 说明                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `GET/POST /api/console/settings`           | 读取或更新有序模型、Base URL 及本地持久化密钥  |
| `POST /api/console/model-test`             | 向当前或已保存的单条配置发送内容并返回文本回复 |
| `GET /api/console/agent-auth?provider=...` | 检查 Codex 或 Claude Code CLI 登录状态         |
| `POST /api/console/agent-auth/login`       | 启动指定 Agent 的官方 CLI 登录                 |
| `POST /api/console/agent-auth/input`       | 向等待中的 CLI 提交 callback 地址或授权码      |
| `POST /api/console/agent-auth/cancel`      | 取消指定 Agent 的进行中登录                    |
| `GET /api/console/github`                  | 读取 GitHub Token 与连接状态                   |
| `POST /api/console/github/connect`         | 验证 GitHub Token，成功后写入配置并读取仓库    |
| `GET /api/console/github/repositories`     | 使用已配置 Token 刷新全部可访问仓库            |
| `GET/POST /api/console/tasks`              | 列出任务或创建任务                             |
| `GET /api/console/task?id=<id>`            | 读取单个任务及日志                             |
| `POST /api/console/cancel`                 | 取消未结束任务                                 |

仓库仅接受 `owner/repo`、GitHub HTTPS 或 GitHub SSH 地址。只有创建任务时显式选择 `createPullRequest`，系统才会提交全部改动、推送任务分支并调用 `gh pr create`。

### POST /command

测试用命令端点，无需钉钉/飞书即可调试：

```bash
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"text":"help","userId":"u1","userName":"Tester","source":"cli"}'
```

### POST /webhook/dingtalk

钉钉机器人 Webhook 回调端点。需配置 `dingtalk.secret` 进行签名校验。

### POST /webhook/feishu

飞书机器人事件回调端点。需配置 `feishu.appSecret` 进行签名校验。

## Skill 插件开发

Skill 是一个 npm 包，`package.json` 中声明 `skill` 字段：

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "main": "index.js",
  "skill": {
    "permissions": {
      "github": false,
      "mcp": false,
      "network": false,
      "filesystem": false
    }
  }
}
```

入口模块导出 `execute` 方法：

```js
module.exports = {
  async execute(ctx) {
    // ctx.args - 命令参数
    // ctx.logger - 日志器
    // ctx.github - GitHub 服务（需 permissions.github: true）
    // ctx.mcp - MCP 管理器（需 permissions.mcp: true）
    return { success: true, message: '执行完成', data: {} };
  },
};
```

`SkillInstaller` 已提供从 npm、本地目录和 Git 仓库安装的底层 API；当前 CLI 尚未暴露安装和卸载命令。

## 程序化调用

```typescript
import { AgentSystem } from 'agent-system';

const system = new AgentSystem('./config');
await system.start();

const result = await system.processCommand('version', {
  userId: 'u1',
  userName: 'Test',
  source: 'cli',
});

await system.stop();
```

## 开发

```bash
npm run build       # 编译 TypeScript
npm test            # 运行测试
npm run test:watch  # 测试监听模式
npm run coverage    # 测试覆盖率
npm run lint        # ESLint 检查
npm run format      # Prettier 格式化
```

## 项目结构

```
src/
├── cli.ts                    # CLI 入口
├── index.ts                  # 程序化 API 导出
├── core/                     # 核心模块
│   ├── AgentSystem.ts        # 系统编排根
│   ├── CommandParser.ts      # 命令解析（中英双语）
│   ├── CommandRouter.ts      # 命令路由
│   ├── EventBus.ts           # 事件总线
│   ├── HttpServer.ts         # HTTP 服务
│   └── ResponseFormatter.ts  # 响应格式化
├── config/                   # 配置管理
├── mcp/                      # MCP 连接器
│   ├── MCPManager.ts         # MCP 管理器
│   ├── JsonRpc.ts            # JSON-RPC 2.0 协议
│   └── transports/           # 传输层（stdio/websocket/http）
├── skills/                   # Skill 插件系统
├── agents/                   # Coding Agent 任务、顺序回退与 Git 工作区
├── web/                      # AI 开发控制台路由和设置
├── github/                   # GitHub 操作
├── integrations/             # 钉钉/飞书集成
├── permissions/              # 权限控制
├── storage/                  # SQLite 存储
└── utils/                    # 工具（Logger、errors 等）
public/                       # 控制台 HTML、CSS 和浏览器脚本
```

## License

MIT
