# 极空间 NAS Docker 部署指南

本文档给出从构建镜像、传输文件、启动容器，到连接 GitHub 和 Codex / Claude Code、验证任务、更新与备份的完整流程。默认采用“开发机离线构建镜像，极空间 NAS 加载镜像并用 Docker Compose 启动”的方式，不依赖公开镜像仓库。

部署完成后：

- cpx 运行在极空间的 Docker 容器中；
- 手机或电脑通过 `http://<NAS-IP>:3000` 打开 Web 控制台；
- SQLite 数据、Agent 工作区、GitHub 配置和 CLI 登录信息保存在 NAS 持久化目录中；
- 容器重建或 NAS 重启后，服务会自动启动并继续使用持久化数据。

整体架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)，安全边界见 [SECURITY.md](SECURITY.md)。

## 一、部署前必须知道的安全边界

> cpx 的 Web 控制台、`/command` 和 `/api/console/*` 当前没有通用身份认证，却可以启动 Agent、修改仓库并推送分支。不要把 3000 端口直接映射到公网，也不要在路由器上为它配置端口转发。

建议先仅在家庭或办公内网使用。确需远程管理时，应在可信反向代理之后增加 TLS、登录认证和访问限制。钉钉或飞书只需公网回调时，应只代理相应的 webhook 路径，不要同时暴露控制台和 `/api/console/*`。

## 二、准备清单

### 1. 极空间 NAS

- 已安装并启动 Docker 应用；
- 已在系统设置中开启 SSH；
- 有一个不会在重启后清空的持久化目录；
- NAS 可以访问 GitHub，以及所用 Agent 的登录和模型服务；
- 准备一个未占用的 TCP 端口，默认使用 `3000`。

不要把正式部署目录放在 `/tmp`。本文用 `<CPX_DIR>` 表示持久化目录，例如你在极空间文件管理器中为 Docker 应用创建的 `cpx` 文件夹。不同型号和系统版本的宿主机绝对路径可能不同，应以文件管理器显示或复制出的真实路径为准。

### 2. 开发机

- 已安装 Docker Desktop 或 Docker Engine；
- 已克隆本仓库；
- 使用 Windows 时，运行仓库脚本还需要 Git Bash 或 WSL。也可以使用本文提供的 PowerShell 命令；
- 构建时能够访问 Debian、Node.js、GitHub CLI、npm、OpenAI 和 Anthropic 的软件源。

### 3. 凭据

首次启动不要求把真实密钥写进 `.docker.env`。可以启动后通过控制台完成连接。

- GitHub：公开仓库只读任务可以暂不配置；访问私有仓库、推送分支或创建 Pull Request 时需要 Token；
- Codex：可使用控制台发起官方设备码登录，或提供 `CODEX_API_KEY`；
- Claude Code：可使用控制台发起官方浏览器登录，或提供 `ANTHROPIC_API_KEY`；
- 钉钉和飞书：仅在需要群机器人时配置。

至少连接一个可用的 Coding Agent 才能运行任务。

## 三、确认 NAS 架构和端口

SSH 登录极空间后执行：

```bash
uname -m
docker info --format '{{.Architecture}}'
docker compose version
```

常见结果：

| 输出 | 构建平台 |
|---|---|
| `x86_64` 或 `amd64` | `linux/amd64` |
| `aarch64` 或 `arm64` | `linux/arm64` |

当前部署方案默认并优先验证 `linux/amd64`。ARM NAS 需要按 `linux/arm64` 构建，并在首次部署后重点检查 `better-sqlite3` 能否加载。

检查 3000 端口是否已被其他容器占用：

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

如果已有服务使用 `0.0.0.0:3000`，编辑 `docker-compose.yml`，只修改端口映射左侧，例如改为：

```yaml
ports:
  - "13000:3000"
```

此时外部访问地址变为 `http://<NAS-IP>:13000`；容器内部端口和 `.docker.env` 中的 `AGENT_SERVER_PORT=3000` 不要改。

## 四、在开发机构建镜像

### 方式 A：macOS、Linux、Git Bash 或 WSL

在仓库根目录执行。x86_64 NAS：

```bash
scripts/docker-build.sh latest linux/amd64
```

ARM64 NAS：

```bash
scripts/docker-build.sh latest linux/arm64
```

脚本会：

1. 构建 `cpx:latest`；
2. 安装生产依赖、Git、SSH 客户端、GitHub CLI、Codex CLI 和 Claude Code CLI；
3. 导出 `cpx-latest.tar.gz`。

### 方式 B：Windows PowerShell

Windows 不依赖 `gzip` 时，可以导出未压缩的 tar 文件。x86_64 NAS：

```powershell
docker build --platform linux/amd64 -t cpx:latest .
docker save -o cpx-latest.tar cpx:latest
```

ARM64 NAS 将平台改为 `linux/arm64`。未压缩的 `.tar` 较大，但部署脚本同样支持。

### 构建后检查

```bash
docker image inspect cpx:latest --format '{{.Os}}/{{.Architecture}}'
```

结果必须与 NAS 架构一致，例如 `linux/amd64`。不要直接使用为开发机本机架构构建、但与 NAS 架构不同的镜像。

## 五、把部署文件上传到极空间

在极空间文件管理器中创建持久化目录 `<CPX_DIR>`，把以下文件放在同一目录：

```text
<CPX_DIR>/
├── cpx-latest.tar.gz       # PowerShell 构建时为 cpx-latest.tar
├── docker-compose.yml
├── .docker.env.example
└── docker-deploy.sh        # 仓库中的 scripts/docker-deploy.sh
```

可使用极空间文件管理器上传，也可从开发机使用 `scp`。下面只是格式示例，用户名、IP 和目标路径应替换为实际值：

```bash
scp cpx-latest.tar.gz docker-compose.yml .docker.env.example \
  scripts/docker-deploy.sh <NAS_USER>@<NAS_IP>:<CPX_DIR>/
```

注意：

- `.docker.env.example` 是以点开头的隐藏文件，上传后需确认它确实存在；
- 不要上传开发机上的 `.docker.env`；它可能包含真实密钥；
- 不建议把仓库中已有的历史镜像包当作最新构建，部署前应从当前代码重新构建。

## 六、首次安装

SSH 登录 NAS，进入部署目录。路径含空格时需要加引号：

```bash
cd "<CPX_DIR>"
chmod +x docker-deploy.sh
ls -la
```

如果上传的是压缩包，执行：

```bash
./docker-deploy.sh cpx-latest.tar.gz "$(pwd)"
```

如果上传的是 PowerShell 导出的 tar，执行：

```bash
./docker-deploy.sh cpx-latest.tar "$(pwd)"
```

第一次运行会加载镜像，创建持久化目录，并从模板生成 `.docker.env`，然后主动退出，让你先检查配置。此时目录应类似：

```text
<CPX_DIR>/
├── .docker.env
├── .docker.env.example
├── docker-compose.yml
├── docker-deploy.sh
├── config/
├── data/
│   ├── claude/
│   └── codex/
└── logs/
```

## 七、配置 `.docker.env`

使用 NAS 上可用的编辑器打开 `<CPX_DIR>/.docker.env`：

```bash
vi .docker.env
```

### 推荐的首次启动配置

如果准备在 Web 控制台完成 GitHub 和 Agent 登录，只保留服务配置即可，其他值保持为空：

```dotenv
AGENT_SERVER_PORT=3000
AGENT_SERVER_HOST=0.0.0.0

CODEX_API_KEY=
ANTHROPIC_API_KEY=

GH_TOKEN=
AGENT_GITHUB_TOKEN=
AGENT_GITHUB_DEFAULT_REPO=

AGENT_DINGTALK_WEBHOOK_URL=
AGENT_DINGTALK_SECRET=

AGENT_FEISHU_WEBHOOK_URL=
AGENT_FEISHU_APP_ID=
AGENT_FEISHU_APP_SECRET=

AGENT_LOGGING_LEVEL=info
```

不要保留 `sk-...`、`ghp_xxx` 之类的示例占位值。它们不是有效密钥，还可能让 CLI 误判鉴权方式。

### 可选：直接通过环境变量提供凭据

如果不使用 Web 登录，可填写：

```dotenv
CODEX_API_KEY=<真实 Codex API Key>
ANTHROPIC_API_KEY=<真实 Anthropic API Key>

AGENT_GITHUB_TOKEN=<真实 GitHub Token>
GH_TOKEN=<与上面相同的 GitHub Token>
```

cpx 读取 `AGENT_GITHUB_TOKEN`。任务执行时会把已连接的 GitHub Token 安全传给 Git 和 `gh`；保留相同的 `GH_TOKEN` 也便于在容器内手工使用 GitHub CLI。

如果配置了 `AGENT_GITHUB_TOKEN`，控制台会把它标记为“环境变量来源”，不能在页面中替换；更新 Token 需要修改 `.docker.env` 并重建容器。

模型名、Base URL 和 Agent 的其他高级设置由各自官方 CLI 管理。控制台只保存 Codex / Claude Code 的关联和执行顺序，不保存或覆盖模型名、服务地址和 API Key。

最后限制文件权限：

```bash
chmod 600 .docker.env
chmod 700 data/codex data/claude
```

## 八、启动并验证容器

重新运行部署脚本：

```bash
./docker-deploy.sh cpx-latest.tar.gz "$(pwd)"
```

使用 `.tar` 时相应替换文件名。启动后执行：

```bash
docker compose ps
docker inspect cpx --format '{{.State.Status}} / {{.State.Health.Status}}'
curl http://127.0.0.1:3000/health
```

预期结果：

- Compose 中 `cpx` 为 `Up`；
- 健康状态在启动后变为 `healthy`；
- `/health` 返回包含 `"status":"ok"` 的 JSON。

健康检查有最长约几十秒的启动窗口。尚未变为 `healthy` 时先查看日志：

```bash
docker compose logs --tail=200 cpx
```

如果修改过宿主机端口映射，NAS 本机的检查地址也应使用修改后的宿主机端口。

## 九、从手机或电脑打开控制台

先在极空间网络设置或路由器管理页确认 NAS 的内网 IP，例如 `192.168.1.20`。同一内网的浏览器打开：

```text
http://<NAS-IP>:3000
```

若页面打不开，依次检查：

1. `docker compose ps` 中端口是否为 `0.0.0.0:3000->3000/tcp`；
2. 手机是否与 NAS 在同一局域网，访客 Wi-Fi 是否隔离内网设备；
3. 极空间防火墙是否允许该端口；
4. 路由器 AP 隔离或 VLAN 规则是否阻止访问；
5. 是否修改过 Compose 的宿主机端口。

极空间 Docker 页面也可以用于查看 `cpx` 容器状态、日志和重启容器。菜单名称会随系统版本变化；实际运行参数仍以本目录中的 `docker-compose.yml` 为准。

## 十、连接 GitHub

推荐在 Web 控制台的“GitHub”页面配置，而不是把 Token 发给其他人代填：

1. 点击“创建 GitHub Token”；
2. 在 GitHub 页面选择资源所有者；
3. 只选择 cpx 需要操作的仓库；
4. 确认仓库权限至少包括：
   - Contents：Read and write；
   - Pull requests：Read and write；
   - Workflows：仅当任务需要修改 `.github/workflows/*` 时设为 Read and write；
5. 生成 Token，复制回控制台并验证；
6. 确认控制台能显示 GitHub 用户和已授权仓库。

GitHub 对 fine-grained PAT 的权限说明见 [GitHub 官方文档](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)。组织仓库可能要求管理员批准 Token；这种情况下应等待组织批准后再验证。

通过控制台验证的 Token 会写入挂载目录中的 `config/config.yaml`。该文件包含密钥，不能提交到 Git、公开分享或备份到不可信位置。

## 十一、连接 Codex 或 Claude Code

进入控制台“模型设置”。这里的每一项只代表一个 Agent 及其执行顺序，实际账号、模型和网关设置来自容器内对应的官方 CLI。

### Codex

1. 在 Codex 项点击连接或登录；
2. 等待页面显示验证地址和一次性设备码；
3. 在可信浏览器打开验证地址，用有权使用 Codex 的账号登录并输入设备码；
4. 返回控制台，等待状态显示“已连接”；
5. 在该关联项中输入一条简短内容并执行测试。

命令行复核：

```bash
docker compose exec cpx codex login status
```

登录资料保存在 `<CPX_DIR>/data/codex`，容器重建后仍会保留。

### Claude Code

1. 在 Claude Code 项点击连接或登录；
2. 在可信浏览器打开页面显示的官方授权地址；
3. 如果页面要求回填授权码或完整 callback 地址，将它粘贴回控制台；
4. 等待状态显示“已连接”；
5. 在该关联项中执行一次简短测试。

命令行复核：

```bash
docker compose exec cpx claude auth status --json
```

登录资料保存在 `<CPX_DIR>/data/claude`。`data/codex` 和 `data/claude` 都应按密钥目录保护。

## 十二、运行第一条验证任务

不要把首次验证直接指向重要仓库。建议准备一个测试仓库，按以下顺序验证：

1. 在“GitHub”页确认测试仓库可见；
2. 在“模型设置”中确认至少一个 Agent 测试成功；
3. 创建任务，选择测试仓库和明确的基础分支；
4. 首次不要勾选“创建 Pull Request”；
5. 输入无破坏性的任务，例如“读取 README，并总结项目启动方式，不修改文件”；
6. 观察任务日志直到成功；
7. 再创建一个会修改测试文件的任务，并勾选“创建 Pull Request”；
8. 到 GitHub 核对新分支、提交内容和 PR 目标分支。

任务状态和实时日志保存在进程内存中，重启容器后不会恢复；每个任务的 Git 工作区仍会保留在 `<CPX_DIR>/data/workspaces/<task-id>`。

## 十三、日常管理命令

以下命令均在 `<CPX_DIR>` 中执行：

```bash
# 查看状态
docker compose ps

# 查看最近 200 行日志
docker compose logs --tail=200 cpx

# 持续跟踪日志，按 Ctrl+C 退出
docker compose logs -f cpx

# 重启
docker compose restart cpx

# 停止并删除容器；不会删除 bind mount 中的持久化目录
docker compose down

# 重新启动
docker compose up -d

# 修改 .docker.env 后强制重建容器，使环境变量生效
docker compose up -d --force-recreate
```

不要随意执行 `docker compose down -v`，也不要删除 `<CPX_DIR>/data` 和 `<CPX_DIR>/config`。

## 十四、更新版本

1. 在开发机拉取并审查最新代码；
2. 重新构建 `cpx:latest` 和镜像包；
3. 先备份 NAS 上的 `data`、`config` 和 `.docker.env`；
4. 把新镜像包、`docker-compose.yml`、`.docker.env.example` 和 `docker-deploy.sh` 上传到 `<CPX_DIR>`；
5. 在 NAS 重新执行部署脚本；
6. 检查健康状态和日志；
7. 运行一条测试任务。

```bash
cd "<CPX_DIR>"
./docker-deploy.sh cpx-latest.tar.gz "$(pwd)"
docker compose ps
docker compose logs --tail=100 cpx
```

部署脚本不会覆盖已有 `.docker.env`，也不会删除 `data`、`config` 和 `logs`。镜像使用固定标签 `cpx:latest`，加载新镜像后 Compose 会根据新镜像重建容器；若没有重建，可执行：

```bash
docker compose up -d --force-recreate
```

## 十五、备份与恢复

至少备份：

```text
<CPX_DIR>/.docker.env
<CPX_DIR>/config/
<CPX_DIR>/data/
<CPX_DIR>/docker-compose.yml
```

其中：

- `data/agent.db` 是 SQLite 数据库；
- `data/workspaces/` 保存任务克隆和未提交改动；
- `data/console-settings.json` 保存 Agent 关联和执行顺序；
- `data/codex/`、`data/claude/` 保存 CLI 登录资料；
- `config/config.yaml` 可能保存通过 Web 控制台验证的 GitHub Token。

为获得一致备份，建议先停止容器，再使用极空间的备份工具复制整个目录：

```bash
cd "<CPX_DIR>"
docker compose down
# 在极空间中完成目录备份
docker compose up -d
```

恢复时，把上述目录放回相同的 Compose 项目目录，加载相同或兼容版本镜像，再执行 `docker compose up -d`。恢复后的 Token 和 CLI 登录信息仍属于敏感凭据。

## 十六、可选：SSH 仓库地址

推荐优先使用 HTTPS 仓库地址和 GitHub Token。若必须使用 `git@github.com:owner/repo.git`：

1. 在 NAS 的受保护目录准备专用 SSH 私钥，并把公钥添加到 GitHub；
2. 在 `docker-compose.yml` 的 `volumes` 中增加只读挂载：

   ```yaml
   - /真实/ssh/目录:/root/.ssh:ro
   ```

3. 在 `.docker.env` 增加：

   ```dotenv
   GIT_SSH_COMMAND=ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new
   ```

4. 重建容器并测试连接：

   ```bash
   docker compose up -d --force-recreate
   docker compose exec cpx ssh -T git@github.com
   ```

不要挂载个人日常使用的整个 SSH 目录；优先使用只授权目标仓库的部署密钥。

## 十七、钉钉和飞书机器人

Web 控制台在内网部署后即可使用，不需要公网入口。钉钉或飞书事件回调则由平台服务器发起，NAS 必须有一个平台可以访问的 HTTPS 地址。

- 钉钉回调路径：`/webhook/dingtalk`；
- 飞书回调路径：`/webhook/feishu`；
- 应配置钉钉加签 Secret 或飞书 App Secret，并保持签名校验开启；
- 反向代理只开放需要的 webhook 路径；
- 不要通过同一个公开入口暴露 `/`、`/command` 或 `/api/console/*`。

环境变量字段见 [.docker.env.example](../.docker.env.example)，命令语法见 [README.md](../README.md) 的“聊天命令”小节。

## 十八、常见故障

| 现象 | 检查与处理 |
|---|---|
| `docker compose` 不存在 | 更新极空间 Docker 应用或确认 Compose 插件已安装；本项目脚本使用 Compose V2 的 `docker compose` 命令 |
| `exec format error` | 镜像架构与 NAS 不一致；重新按 `linux/amd64` 或 `linux/arm64` 构建 |
| `better-sqlite3` 加载失败 | 通常是原生模块架构不匹配；确认镜像平台，并重新构建，不要跨架构复用 `node_modules` |
| 容器不断重启 | 执行 `docker compose logs --tail=200 cpx`；检查配置格式、目录权限和镜像架构 |
| 健康状态为 `unhealthy` | 执行 `docker compose exec cpx curl -v http://127.0.0.1:3000/health`，再检查启动日志 |
| NAS 本机可访问，手机打不开 | 检查宿主机端口、防火墙、访客 Wi-Fi、AP 隔离、VLAN 和实际 NAS IP |
| 端口已被占用 | 修改 Compose 中映射左侧端口，例如 `13000:3000`，然后重建容器 |
| GitHub 页面验证失败 | 检查 Token 有效期、资源所有者、仓库范围、组织批准状态和权限；环境变量来源的 Token 需修改 `.docker.env` 后重建 |
| 私有仓库 clone 返回 403 | 确认仓库已授权给 Token，HTTPS 地址使用已连接 Token；SSH 地址需另配私钥 |
| `gh pr create` 未登录或无权限 | 确认 GitHub 已在控制台验证，Token 有 Contents 与 Pull requests 写权限，目标分支策略允许创建 PR |
| Agent 显示未连接 | 在模型设置中重新登录；命令行运行 `codex login status` 或 `claude auth status --json`；检查持久化目录权限 |
| Agent 返回 401 | 删除 `.docker.env` 中无效占位值，检查 API Key、官方 CLI 登录和 CLI 自身的网关配置 |
| Agent 无法访问模型或 GitHub | 检查 NAS DNS、默认网关、代理和出站网络；容器内可用 `curl` 做连通性检查 |
| 更新后仍运行旧版本 | 确认新包已 `docker load`，再执行 `docker compose up -d --force-recreate` 并查看容器镜像 ID |
| 重建后登录丢失 | 检查 `./data/codex:/root/.codex` 和 `./data/claude:/root/.claude` 挂载是否仍存在，以及是否在同一 Compose 目录启动 |

需要收集诊断信息时，可执行：

```bash
cd "<CPX_DIR>"
docker compose ps
docker inspect cpx --format 'image={{.Image}} status={{.State.Status}} health={{.State.Health.Status}}'
docker image inspect cpx:latest --format 'platform={{.Os}}/{{.Architecture}} id={{.Id}}'
docker compose logs --tail=200 cpx
```

分享日志前应检查并删除 Token、Webhook 地址、授权 callback、仓库敏感内容和其他凭据。
