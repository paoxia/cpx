# 极空间 Docker 部署

本文档说明如何在极空间 NAS（x86_64 型号）上通过 Docker 部署 cpx，让手机通过 Web 控制台、钉钉或飞书机器人下发任务，让容器内的 Codex / Claude Code 修改任意 GitHub 仓库代码。

部署前置、安全边界和架构限制见 [SECURITY.md](SECURITY.md)，整体架构见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。

## 前置条件

### NAS 侧

- 极空间 x86_64 型号（如 Z4S、Z4 Pro 等搭载 Intel 处理器的型号）
- 已安装「Docker 应用」或等价的 Docker / Docker Compose 运行环境
- 已开启 SSH 服务（系统设置 → 终端与 SSH），用于在 NAS 上执行 shell 命令
- NAS 与手机处于同一内网，且 NAS 的 3000 端口未被占用

> ARM 型号（RK3568/RK3588 等）需将 `Dockerfile` 改用 `--platform linux/arm64` 构建，并确认 `better-sqlite3` 在该架构上的 prebuilt 可用性。本方案默认 x86_64。

### 开发机侧

- 已安装 Docker（用于构建镜像）
- 已 `git clone` cpx 仓库到本地

### 必备凭据

- **GitHub Personal Access Token**：需要 `repo` 和 `workflow` 权限，用于 `git clone` 私有仓库、`git push`、`gh pr create`
- **Codex 凭据**：使用官方 CLI 登录，或通过环境变量/模型设置提供 API Key
- **Claude Code 凭据**：使用官方 CLI 登录，或通过环境变量/模型设置提供 API Key

至少为一个 Agent 完成 CLI 登录或配置 API Key 才能下发任务；需要使用自定义网关时，在 Web 控制台的对应模型项中同时填写 Base URL 和密钥。

## 部署流程

### 1. 开发机构建镜像

在仓库根目录执行：

```bash
scripts/docker-build.sh
```

脚本会执行 `docker build` 并通过 `docker save | gzip` 导出 `cpx-latest.tar.gz`（约 500-600MB，取决于 CLI 版本）。

构建产物包含：

- `node:22-slim` 基础镜像
- cpx 编译后的 `dist/` 与生产依赖
- `git`、`gh`（GitHub CLI）
- 全局安装的 `@openai/codex` 和 `@anthropic-ai/claude-code`

### 2. 传输到 NAS

把以下三个文件传输到 NAS 同一目录（建议 `/tmp/cpx/` 或某个持久化路径）：

- `cpx-latest.tar.gz`
- `docker-compose.yml`
- `.docker.env.example`
- `scripts/docker-deploy.sh`

传输方式：

- **极空间文件管理器**：Web UI 上传到所选目录
- **SFTP / scp**：`scp cpx-latest.tar.gz docker-compose.yml .docker.env.example scripts/docker-deploy.sh user@<NAS-IP>:/tmp/cpx/`

### 3. NAS 端部署

SSH 登录到 NAS，进入文件所在目录后执行：

```bash
cd /tmp/cpx
chmod +x docker-deploy.sh
./docker-deploy.sh
```

首次运行会：

1. `docker load` 加载镜像
2. 创建工作目录（`data/`、`config/`、`logs/`）
3. 从 `.docker.env.example` 复制出 `.docker.env` 并设置 `600` 权限
4. **提示用户编辑 `.docker.env` 后再次运行脚本**；Agent API Key 也可在容器启动后的模型设置中填写

### 4. 配置环境变量

编辑 `/tmp/cpx/.docker.env`，按需填入：

```bash
# Agent API Key（可选，也可在模型设置中逐项填写或使用 CLI 登录）
CODEX_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# GitHub Token（PR 创建必需）
GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
AGENT_GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx

# 钉钉机器人（可选）
AGENT_DINGTALK_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxx
AGENT_DINGTALK_SECRET=SECxxx

# 飞书机器人（可选）
AGENT_FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
AGENT_FEISHU_APP_ID=cli_xxx
AGENT_FEISHU_APP_SECRET=xxx
```

完整字段见 [`.docker.env.example`](../.docker.env.example)。环境变量与 `config.yaml` 字段的对应关系见 [README.md](../README.md)「环境变量」小节。

### 5. 启动容器

再次执行部署脚本即可启动：

```bash
./docker-deploy.sh
```

成功后容器名为 `cpx`，监听 `0.0.0.0:3000`，重启策略 `unless-stopped`。

## 手机访问

### Web 控制台

手机浏览器打开 `http://<NAS-IP>:3000`，在创建任务界面填写：

- **Provider**：`codex` 或 `claude`
- **Repository**：`owner/repo`、`https://github.com/owner/repo.git` 或 `git@github.com:owner/repo.git`
- **Base Branch**（可选）：默认使用仓库默认分支
- **Prompt**：自然语言描述任务
- **创建 Pull Request**：勾选后任务完成会自动提交、推送分支并创建 PR

任务状态和日志实时显示在列表中。任务保存在内存，重启容器后丢失；任务对应的 Git 工作区保留在 `/tmp/cpx/data/workspaces/<task-id>/`。

### Codex / Claude Code 登录

在 Web 控制台进入“模型设置”，点击“使用设备码连接”：

1. 页面等待容器内的 Codex CLI 生成验证地址和一次性设备码。
2. 用手机或电脑的可信浏览器打开验证地址，登录拥有 Codex 权限的 ChatGPT 账号并输入设备码。
3. 返回控制台等待状态变为“已连接”。

Compose 将容器的 `/root/.codex` 挂载到宿主机 `./data/codex`，因此重新创建容器后仍可复用 Codex CLI 登录。该目录包含敏感凭据，应限制宿主机读取权限且不得备份到不可信位置。设备码流程无需让浏览器访问容器内的 localhost callback。

Claude Code 可在同一区域启动官方浏览器登录；需要手工返回授权结果时，将完整 callback 地址或授权码粘贴回页面。Compose 同时把 `/root/.claude` 挂载到 `./data/claude`，以保留 Claude Code CLI 登录。两个目录都必须按密钥材料保护。

非 Docker 部署同样支持 Linux、macOS 和 Windows，但服务进程必须与登录 CLI 使用同一系统用户。macOS 的 Claude Code OAuth 凭据可能位于系统 Keychain；Windows 原生 Claude Code 需要 Git for Windows，也可以把 cpx 与两个 CLI 全部安装在 WSL 中。不要跨 Windows/WSL 或跨用户复用 HOME 路径。

### 钉钉机器人

1. 在钉钉群创建自定义机器人，记录 Webhook URL 和加签 Secret
2. 把上述值填入 `.docker.env` 的 `AGENT_DINGTALK_WEBHOOK_URL` 和 `AGENT_DINGTALK_SECRET`
3. 钉钉机器人需要能回调到 NAS 的 `/webhook/dingtalk` 端点。**NAS 必须可被钉钉服务器访问**：
   - 内网使用：通过极空间自带反向代理或 ngrok 等工具暴露到公网
   - 不支持公网回调时，仅使用 Web 控制台下任务
4. 在群里 @机器人 发送命令，例如 `@agent version` 或 `@agent 修改 README.md 添加安装说明`

### 飞书机器人

1. 在飞书开放平台创建自建应用，开启机器人能力
2. 配置事件订阅地址为 `http://<可被飞书访问的地址>/webhook/feishu`
3. 把 `App ID`、`App Secret`、Webhook URL 填入 `.docker.env`
4. 在群里 @机器人 发送命令

命令语法见 [README.md](../README.md)「聊天命令」小节。

## 可选：使用 SSH 仓库地址

如果 GitHub 仓库使用 `git@github.com:owner/repo.git` 形式，容器需要 SSH 私钥：

1. 在 NAS 上准备 SSH 私钥（已添加到 GitHub 账号）
2. 在 `docker-compose.yml` 的 `volumes` 增加挂载：

   ```yaml
   volumes:
     - ./data:/app/data
     - ./data/codex:/root/.codex
     - ./data/claude:/root/.claude
     - ./config:/app/config
     - ./logs:/app/logs
     - /path/to/.ssh:/root/.ssh:ro
   ```

3. 在 `.docker.env` 增加：

   ```bash
   GIT_SSH_COMMAND=ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new
   ```

4. 重启容器：`docker compose up -d`

推荐优先使用 HTTPS + `GH_TOKEN` 方式，配置更简单。

## 更新镜像

代码或依赖更新后：

1. 开发机执行 `scripts/docker-build.sh` 重新构建 `cpx-latest.tar.gz`
2. 传输到 NAS
3. NAS 上执行 `./docker-deploy.sh`（会自动 `docker load` 并 `docker compose up -d`）

`docker compose up -d` 会检测镜像变化并重建容器，`./data` 下的 SQLite 数据库和工作区不会丢失。

## 查看日志

```bash
cd /tmp/cpx
docker compose logs -f          # 跟踪日志
docker compose logs --tail=100  # 最近 100 行
```

应用日志默认输出到容器 stdout，可通过 `AGENT_LOGGING_LEVEL` 调整级别。若需写入文件，在 `config.yaml` 设置 `logging.file` 并挂载 `/app/logs`。

## 排障

| 现象                                    | 排查                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 容器启动后立即退出                      | `docker compose logs` 查看错误；通常是 `.docker.env` 缺失必填字段                                                       |
| 健康检查不通过                          | `docker inspect cpx --format='{{.State.Health.Status}}'`；容器内 `curl http://127.0.0.1:3000/api/console/settings` 测试 |
| Agent 任务失败：`git clone` 报权限错    | 检查 `GH_TOKEN` 是否有效且有 `repo` 权限；私有仓库必须用 HTTPS + Token 或 SSH Key                                       |
| Agent 任务失败：`gh pr create` 报未登录 | `gh` 使用 `GH_TOKEN` 环境变量鉴权，确认 `.docker.env` 中已设置                                                          |
| 钉钉/飞书机器人无响应                   | NAS 必须可被钉钉/飞书服务器回调到 3000 端口；内网部署需通过反向代理暴露                                                 |
| `codex` 或 `claude` 报 401              | 检查该模型项保存的 API Key、服务环境变量、Base URL 和官方 CLI 登录状态；Claude 网关配置会使用 `ANTHROPIC_AUTH_TOKEN`    |
| Codex 页面显示未连接                    | 在“模型设置”重新执行设备码登录；检查 `./data/codex` 是否可由容器 root 用户写入                                          |
| `better-sqlite3` 加载失败               | 通常是架构不匹配，确认镜像架构与 NAS 架构一致（`docker inspect cpx --format='{{.Architecture}}'`）                      |

## 安全注意事项

> Web 控制台和 `/api/console/*` 当前没有身份认证，可执行代码、读写仓库、推送分支。默认监听 `0.0.0.0`。**禁止直接暴露到公网**。

部署建议：

- 仅在极空间内网使用，路由器关闭 3000 端口的端口转发
- 若需外网访问，通过极空间自带反向代理或 Nginx 加 Basic Auth / IP 白名单
- `.docker.env` 文件权限保持 `600`，避免其他用户读取密钥
- `./data/codex` 包含 Codex 登录凭据，只允许部署管理员读取，不要提交到版本控制或公开备份
- `GH_TOKEN` 使用最小权限的 fine-grained PAT，仅授权必要仓库的必要权限
- 部署后定期更新 `@openai/codex` 和 `@anthropic-ai/claude-code`（重新构建镜像即可）
