# 极空间 NAS Docker Compose 部署指南

本文档只使用极空间文件管理器和 Docker 图形界面完成 NAS 侧操作，不要求开启远程终端服务，也不要求在 NAS 上执行命令。

推荐把完整源代码上传到 NAS 后，由极空间 Compose 直接构建。NAS 网络或性能不适合现场构建时，可在开发机生成镜像包，再通过极空间 Docker 的镜像导入功能部署。

部署完成后：

- cpx 运行在极空间的 Docker 容器中；
- 手机或电脑通过 `http://<NAS-IP>:3000` 打开 Web 控制台；
- SQLite 数据、任务工作区、GitHub 配置和 Agent 登录资料保存在 NAS 持久化目录中；
- 容器重建或 NAS 重启后继续使用已有数据。

整体架构见 [ARCHITECTURE.md](../ARCHITECTURE.md)，安全边界见 [SECURITY.md](SECURITY.md)。

## 一、安全边界

> cpx 的 Web 控制台、`/command` 和 `/api/console/*` 当前没有通用身份认证，却可以启动 Agent、修改仓库并推送分支。不要把 3000 端口直接映射到公网，也不要在路由器上为它配置端口转发。

建议只在家庭或办公内网访问。确需远程管理时，应在可信反向代理后增加 TLS、登录认证和访问限制。钉钉和飞书均使用由容器主动发起的长连接，不需要对公网开放任何回调路径。

## 二、准备工作

### 极空间 NAS

- 已安装并启动 Docker 应用；
- 已启用 Docker Compose 图形化项目功能；
- 有一个不会在重启后清空的持久化目录；
- NAS 可以访问 GitHub、Debian 软件源、npm 以及所用 Agent 的登录和模型服务；
- 3000 端口未被其他容器占用，或者准备改用其他宿主机端口。

本文用 `<CPX_DIR>` 表示项目存储目录。可以在极空间文件管理器中创建 `Docker/cpx` 文件夹，并在创建 Compose 项目时把它选为项目存储位置。不同系统版本的菜单名称可能略有变化。

### 开发机

- 能获取本仓库目标分支的完整源码；
- 使用离线镜像方案时，已安装 Docker Desktop 或 Docker Engine；
- 私有仓库的下载凭据只保留在开发机，不上传到 NAS 项目目录。

## 三、推荐方式：上传源码并由 Compose 构建

### 1. 在开发机准备源码

在开发机取得要部署的分支。当前尚未合并到主分支的部署改动可以从 `dev` 分支获取；正式发布后应优先使用经过确认的主分支或版本标签。

可以直接使用 GitHub 网页的“Download ZIP”，也可以在开发机仓库中生成不包含本地密钥和运行数据的源码包：

```bash
git archive --format=zip --output=cpx-source.zip dev
```

这条命令只在开发机执行。不要把开发机上的 `.env`、`.docker.env`、`config/config.yaml`、`data` 或任何 Token 一起打包。

### 2. 通过极空间文件管理器上传

在极空间文件管理器中：

1. 创建持久化目录 `<CPX_DIR>`；
2. 上传源码 ZIP 并解压到该目录；
3. 确认 `Dockerfile`、`docker-compose.yml`、`package.json`、`src/` 和 `public/` 位于同一层；
4. 创建 `data/codex`、`data/workspaces`、`config` 和 `logs` 子目录；
5. 将该目录访问权限限制为管理员或可信用户。

源码包本身已经包含 `config/config.example.yaml` 和 `config/permissions.example.yaml`。不要删除整个 `config` 目录。

### 3. 在极空间创建 Compose 项目

打开极空间管理界面：

1. 进入“Docker → Compose”；
2. 选择“新建项目”；
3. 项目名称填写 `cpx`；
4. 项目存储位置选择刚才上传源码的 `<CPX_DIR>`；
5. 导入该目录中的 `docker-compose.yml`，或者把文件内容粘贴到 Compose 编辑框；
6. 确认构建上下文为当前目录 `.`，然后创建项目。

根目录 [docker-compose.yml](../docker-compose.yml) 会调用同目录的 `Dockerfile`，在 NAS 本机架构上构建本地镜像并启动 `cpx`。首次构建需要下载基础镜像、系统包和 npm 包，耗时取决于 NAS 性能和网络状况。

创建过程中打开项目构建日志，确认没有下载超时或编译错误。构建成功后，项目中应出现一个名为 `cpx` 的容器。

### 4. Codex 自动安装

不需要在极空间或容器内手工安装 Codex。镜像构建时，项目 `Dockerfile` 会执行：

```dockerfile
RUN npm install -g @openai/codex@latest
```

因此源码 Compose 构建成功后，`codex` 命令已经包含在容器镜像中；开发机生成的离线镜像包也包含同一套 CLI。可以在极空间构建日志中找到这一步，确认 npm 安装完成。如果这一步失败，通常是 NAS 无法访问 npm 或相关下载源，应先检查构建日志和 NAS 出站网络，或者改用开发机构建的离线镜像。

容器启动后，在 cpx Web 控制台进入“模型设置”，在 Codex 项点击连接或登录，按页面展示的验证地址和设备码完成授权，然后执行该项内的测试。无需打开 NAS 终端。登录资料保存在 `<CPX_DIR>/data/codex`，对应容器内 `/root/.codex`；只要不删除这个目录，重新创建或重新构建容器后仍可继续使用。

### 5. 环境变量

默认 Compose 已提供服务地址、端口、时区和日志级别。Codex、GitHub、钉钉和飞书的可选密钥默认留空，不会阻止首次启动。

推荐启动后通过 cpx Web 控制台连接 GitHub，并完成 Codex 登录。如果确实要通过环境变量提供密钥，可在极空间 Compose 项目的环境变量界面填写对应变量，再保存并重新创建容器：

```dotenv
CODEX_API_KEY=
GH_TOKEN=
AGENT_GITHUB_TOKEN=
AGENT_GITHUB_DEFAULT_REPO=
AGENT_DINGTALK_ENABLED=true
AGENT_DINGTALK_CLIENT_ID=
AGENT_DINGTALK_CLIENT_SECRET=
AGENT_FEISHU_ENABLED=true
AGENT_FEISHU_APP_ID=
AGENT_FEISHU_APP_SECRET=
AGENT_LOGGING_LEVEL=info
APT_MIRROR=http://deb.debian.org
NPM_REGISTRY=https://registry.npmjs.org
```

空值应保持为空，不要填写 `sk-...`、`ghp_xxx` 等示例占位符。环境变量来源的 GitHub Token 不能在 cpx 页面中替换；更新时需要在 Compose 项目中修改变量并重新创建容器。

`APT_MIRROR` 和 `NPM_REGISTRY` 只在源码镜像构建阶段使用。它们默认分别使用 Debian 和 npm 官方源；国内开发或构建环境可分别设置为 `http://mirrors.aliyun.com` 和 `https://registry.npmmirror.com`。APT 仓库元数据和软件包由 Debian 签名验证；使用 HTTP 可避免基础镜像尚未安装 CA 证书时的循环依赖。`NPM_REGISTRY` 会同时用于项目依赖和 Codex CLI 的 npm 包下载。两个变量都不会写入最终容器环境，也不能代理运行时模型请求。

#### 出站代理

如果 NAS 所在网络不能直接连接 Codex、GitHub、npm 或 Debian 软件源，可以在极空间 Compose 项目的环境变量界面增加标准代理变量：

```dotenv
HTTP_PROXY=http://192.168.1.10:7890
HTTPS_PROXY=http://192.168.1.10:7890
ALL_PROXY=
NO_PROXY=localhost,127.0.0.1,::1
```

把 `192.168.1.10:7890` 替换为代理服务在局域网中的实际地址和 HTTP 代理端口。代理软件必须允许局域网设备连接，并通过防火墙放行 NAS；如果代理需要用户名和密码，可使用 `http://用户名:密码@地址:端口`，但这些凭据会显示在 Compose 配置中，应限制项目和备份文件的访问权限。

不要填写 `127.0.0.1` 或 `localhost`：它们在容器中指向 cpx 容器自身，不是电脑、路由器或 NAS 上的代理。代理运行在电脑上时填写电脑的局域网 IP；运行在路由器或其他常开设备上时填写该设备的局域网 IP。只有 SOCKS5 端口而没有 HTTP 端口时，将 `HTTP_PROXY` 和 `HTTPS_PROXY` 留空，并把 `ALL_PROXY` 填为 `socks5h://<局域网IP>:<端口>`；优先使用 HTTP 代理，兼容性更好。

根目录 `docker-compose.yml` 会把这些变量同时传给镜像构建和运行中的容器：

- 构建阶段用于下载 Debian 包、npm 包以及 Codex CLI；
- 运行阶段用于 Codex 登录、模型请求和其他支持标准代理变量的出站请求；
- `NO_PROXY` 保证容器健康检查等本地请求不绕行代理。

保存环境变量后，在极空间 Compose 项目详情中选择重新构建并重新创建容器，再通过“模型设置”重新执行 Codex 登录或测试。设备码页面由电脑或手机浏览器打开，因此该浏览器也必须具备可用网络。

构建参数无法控制 Docker 在构建开始前拉取 `node:22-slim` 基础镜像。如果构建日志停在拉取基础镜像，需在极空间 Docker 应用或系统网络界面配置 Docker 的出站代理；若当前系统界面没有该选项，使用本文“开发机构建并在 NAS 导入镜像”的备用方式。导入镜像后仍需在 `docker-compose.image.yml` 项目中填写上述运行时代理变量，Codex 才能从容器访问模型服务。

#### NAS 内置 Mihomo 容器

已有合法可用的 Clash/Mihomo 配置时，可以使用根目录 [docker-compose.mihomo.yml](../docker-compose.mihomo.yml)，在同一个 Compose 项目中运行 cpx 与 Mihomo：

```text
cpx → http://mihomo:7890 → Mihomo 配置的上游 → 外部服务
```

这份 Compose 使用显式 HTTP 代理，不启用 TUN，不需要 `privileged`、`NET_ADMIN`、`/dev/net/tun`、host 网络或 NAS 终端。Mihomo 的 7890 端口只通过 Compose 默认网络提供给 cpx，没有映射到 NAS 或局域网。代理容器本身仍需具有合法可用的上游配置；只启动一个空代理容器不能改变外部服务的可达性或地区支持政策。

##### 首次准备

1. 在开发机或可信设备上复制 [config/mihomo.example.yaml](../config/mihomo.example.yaml)，并命名为 `config.yaml`；
2. 用真实订阅地址替换示例中的 `https://example.invalid/replace-with-your-subscription-url`；订阅地址必须用引号包裹；
3. 通过极空间文件管理器创建 `<CPX_DIR>/data/mihomo`，把配置上传为 `<CPX_DIR>/data/mihomo/config.yaml`；
4. 限制该目录的访问权限。实际配置可能包含订阅地址、节点密码和其他凭据，不应提交到 Git 或复制到不可信备份。

如果 NAS 不能直接拉取镜像，在开发机按 NAS 架构准备 cpx 与 Mihomo 镜像。以下示例适用于 amd64：

```bash
scripts/docker-build.sh latest linux/amd64
docker pull --platform linux/amd64 metacubex/mihomo:v1.19.30
docker save -o mihomo-v1.19.30-amd64.tar metacubex/mihomo:v1.19.30
```

ARM64 NAS 把两个命令中的平台改为 `linux/arm64`，并相应修改导出文件名。这些命令只在开发机执行。随后通过极空间文件管理器上传 `cpx-latest.tar`、Mihomo 镜像包和 `docker-compose.mihomo.yml`，再从 Docker 镜像页面导入两个镜像。Mihomo 的默认镜像版本固定在 Compose 的 `MIHOMO_IMAGE` 默认值中；升级前应先核对配置兼容性，也可以在 Compose 环境变量中显式选择其他已导入版本。

在极空间“Docker → Compose”中新建项目，项目存储位置选择 `<CPX_DIR>`，导入或粘贴 `docker-compose.mihomo.yml`。创建后依次检查：

1. `cpx-mihomo` 日志没有配置解析、订阅下载或节点连接错误；
2. `cpx` 日志显示服务监听 `0.0.0.0:3000`；
3. 浏览器访问 `http://<NAS-IP>:3000/health`；
4. 在 cpx“模型设置”中重新连接并测试 Codex。

如果 Mihomo 正常运行但 Codex 仍然超时，检查当前代理组是否选择了可用节点、最终 `MATCH` 规则是否走代理，以及用于设备码登录的电脑或手机是否也能打开验证页面。

##### 开发阶段快速迭代

Mihomo 镜像和配置只准备一次、每轮仅替换 cpx 开发镜像的完整操作流程，见 [极空间 NAS 开发调试指南](NAS-DEBUGGING.md)。该文档同时说明同名镜像缓存、唯一开发标签、图形界面验证和日志脱敏方式。

### 6. 端口调整

默认端口映射为：

```yaml
ports:
  - "3000:3000"
```

如果 3000 已被占用，在 Compose 编辑器中只修改左侧，例如：

```yaml
ports:
  - "13000:3000"
```

此时访问地址变为 `http://<NAS-IP>:13000`，容器内部端口仍保持 3000。

## 四、备用方式：开发机构建并在 NAS 导入镜像

当 NAS 无法稳定访问构建所需的软件源，或者不希望占用 NAS 资源时，在开发机构建与 NAS 架构一致的镜像。

先在极空间系统信息或设备规格页面确认处理器架构：

| NAS 架构 | Docker 构建平台 |
|---|---|
| x86_64 / amd64 | `linux/amd64` |
| aarch64 / arm64 | `linux/arm64` |

在开发机仓库根目录执行：

```bash
scripts/docker-build.sh latest linux/amd64
```

ARM64 NAS 将平台改为：

```bash
scripts/docker-build.sh latest linux/arm64
```

这些命令只在开发机执行，并生成 `cpx-latest.tar`。

然后在极空间界面完成：

1. 通过文件管理器把 `cpx-latest.tar` 和 `docker-compose.image.yml` 上传到持久化目录；
2. 打开“Docker → 镜像”，选择本地镜像导入，导入 `cpx-latest.tar`；
3. 确认镜像列表中出现 `cpx:latest`；
4. 在文件管理器中创建 `data/codex`、`data/workspaces`、`config` 和 `logs`；使用 Mihomo 方案时再创建 `data/mihomo`；
5. 打开“Docker → Compose → 新建项目”；
6. 项目存储位置选择该持久化目录；
7. 导入或粘贴 `docker-compose.image.yml` 的内容并创建项目。

离线镜像 Compose 使用与源码方案相同的端口、环境变量和数据目录。

## 五、启动验证

在极空间 Docker 界面检查：

1. Compose 项目状态为运行中；
2. `cpx` 容器状态为运行中；
3. 等待健康状态变为 `healthy`；
4. 在容器日志中确认服务监听 `0.0.0.0:3000`，且没有持续重启或数据库错误。

浏览器打开：

```text
http://<NAS-IP>:3000/health
```

预期返回包含 `"status":"ok"` 的 JSON。随后打开：

```text
http://<NAS-IP>:3000
```

如果修改过宿主机端口，使用修改后的端口。

页面打不开时依次检查：

1. Compose 项目是否创建成功；
2. 容器是否处于运行和健康状态；
3. 端口映射是否显示为 `3000:3000` 或自定义端口；
4. 手机是否与 NAS 在同一局域网；
5. 访客 Wi-Fi、AP 隔离、VLAN 或极空间防火墙是否阻止访问。

## 六、连接 GitHub

推荐在 Web 控制台的“GitHub”页面配置：

1. 点击“创建 GitHub Token”；
2. 在 GitHub 页面选择资源所有者；
3. 只选择 cpx 需要操作的仓库；
4. 确认 Contents 和 Pull requests 为 Read and write；
5. 仅在任务需要修改 `.github/workflows/*` 时授予 Workflows 写权限；
6. 生成 Token，复制回控制台并验证；
7. 确认控制台能显示 GitHub 用户和已授权仓库。

通过控制台验证的 Token 会写入挂载目录中的 `config/config.yaml`。该文件包含密钥，不能公开分享或备份到不可信位置。

NAS 部署推荐使用 GitHub HTTPS 仓库地址和页面中验证的 Token，不需要为 NAS 宿主机配置额外的仓库凭据。

## 七、连接 Codex 并选择模型

进入控制台“Agent 设置”。每一项代表一套 Codex 模型与推理强度配置。

### Codex

1. 在 Codex 区域点击“ChatGPT 设备码登录”，或输入 OpenAI API Key；
2. 等待页面显示验证地址和一次性设备码；
3. 在可信浏览器打开验证地址并完成设备码登录；
4. 返回控制台，等待状态显示“已连接”；
5. 点击“刷新模型列表”；页面会读取当前账号在 Codex 交互式 `/model` 中使用的同一模型目录；
6. 选择模型及该模型支持的推理强度，保存为一套配置；
7. 输入一条简短内容并执行测试。

登录资料保存在 `<CPX_DIR>/data/codex`，容器重建后继续保留。

## 八、运行第一条验证任务

不要把首次验证直接指向重要仓库。建议准备一个测试仓库：

1. 在“GitHub”页确认测试仓库可见；
2. 在“Agent 设置”中确认至少一套 Codex 配置测试成功；
3. 创建任务并选择明确的基础分支；
4. 首次不要勾选“创建 Pull Request”；
5. 输入“读取 README 并总结启动方式，不修改文件”等无破坏性任务；
6. 观察任务日志直到成功；
7. 再测试修改文件和创建 Pull Request。

任务状态和实时日志保存在进程内存中，重启容器后不会恢复。任务 Git 工作区保存在 `<CPX_DIR>/data/workspaces/<task-id>`。

## 九、日常管理

所有操作都在极空间 Docker 图形界面完成：

- 查看状态：打开 Compose 项目详情；
- 查看日志：打开 `cpx` 容器的日志页；
- 重启：在容器或项目菜单中选择重启；
- 停止：在 Compose 项目菜单中选择停止；
- 修改配置：编辑 Compose 内容或环境变量后重新创建容器；
- 重新构建：源码更新后在 Compose 项目中选择重新构建。

停止或删除容器不会删除相对目录中的持久化数据，但不要在文件管理器中删除 `<CPX_DIR>/data` 和 `<CPX_DIR>/config`。执行带“删除数据卷”含义的操作前必须确认目标；本项目主要使用目录挂载，不应把删除项目数据作为普通更新步骤。

## 十、更新

### 源码部署

1. 在开发机取得并审查新版本源码；
2. 备份 NAS 上的 `data`、`config`、`logs` 和 Compose 配置；
3. 在极空间界面停止 `cpx` Compose 项目；
4. 通过文件管理器覆盖源码文件，但保留 NAS 上的 `data`、`config` 和 `logs`；
5. 如果新版 `docker-compose.yml` 有变化，在项目编辑器中同步更新；
6. 在 Compose 项目中选择重新构建并启动；
7. 检查健康状态和日志，再运行一条测试任务。

不要先删除整个 `<CPX_DIR>` 再上传，这会一起删除数据库、任务工作区和登录资料。

### 离线镜像部署

1. 在开发机重新生成 `cpx-latest.tar`；
2. 备份 NAS 上的持久化目录；
3. 通过文件管理器上传新镜像包；
4. 在极空间 Docker 镜像页面重新导入 `cpx:latest`；
5. 在 Compose 项目详情中重新创建 `cpx` 容器；
6. 检查容器实际使用的新镜像、健康状态和日志。

## 十一、备份与恢复

至少备份：

```text
<CPX_DIR>/config/
<CPX_DIR>/data/
<CPX_DIR>/docker-compose.yml        # 或实际使用的 docker-compose.mihomo.yml
<CPX_DIR>/logs/                 # 可选，便于排障
```

其中：

- `data/agent.db` 是 SQLite 数据库；
- `data/workspaces/` 保存任务克隆和未提交改动；
- `data/console-settings.json` 保存 Codex 配置和当前选择；
- `data/codex/` 保存 Codex CLI 登录资料；
- `data/mihomo/` 在启用可选 Mihomo Compose 时保存代理配置与运行数据；
- `config/config.yaml` 可能保存通过 Web 控制台验证的 GitHub Token。

一致备份流程：

1. 在极空间 Compose 页面停止项目；
2. 使用极空间备份工具或文件管理器复制上述目录；
3. 备份完成后重新启动项目。

恢复时把目录放回 Compose 项目的存储位置。源码部署同时恢复兼容版本源码并重新构建；离线部署先导入兼容镜像，再重新创建项目。恢复后的 Token 和 Agent 登录资料仍属于敏感凭据。

## 十二、钉钉和飞书机器人

Web 控制台在内网部署后即可使用，不需要公网入口。进入“消息平台”页填写应用凭据并启用：

- 钉钉在开放平台创建企业内部应用和机器人，消息接收模式选择 Stream；填写 Client ID（AppKey）和 Client Secret（AppSecret）；
- 飞书在开放平台创建企业自建应用并启用机器人，在事件订阅中选择“使用长连接接收事件”；填写 App ID 和 App Secret；
- 两个平台均由 cpx 主动建立 WebSocket/Stream 连接，不配置 HTTP 回调地址，也不配置固定群 Webhook；
- 保存后在页面确认“已连接”，再向机器人发消息。回复会发送到产生该消息的会话。

命令语法见 [README.md](../README.md) 的“聊天命令”小节。

## 十三、常见故障

| 现象 | 图形界面检查与处理 |
|---|---|
| 找不到 Compose 功能 | 更新极空间 Docker 应用和系统版本，确认当前机型支持 Compose 项目 |
| 源码构建无法下载依赖 | 查看项目构建日志，检查 NAS DNS、默认网关以及 Docker Hub、Debian、npm 和 GitHub 连通性；网络受限时改用离线镜像 |
| 构建停在 `apt-get` | 设置构建变量 `APT_MIRROR=http://mirrors.aliyun.com` 后重新构建 |
| 构建停在 `npm install` | 设置构建变量 `NPM_REGISTRY=https://registry.npmmirror.com` 后重新构建；这只处理 npm 包 |
| `exec format error` | 离线镜像架构与 NAS 不一致；在开发机按正确平台重新构建并导入 |
| `better-sqlite3` 加载失败 | 检查镜像架构；源码方案应在 NAS 本机重新构建，离线方案应重新生成对应架构镜像 |
| 容器不断重启 | 打开 `cpx` 容器日志，检查配置、目录挂载、目录权限和数据库错误 |
| 健康状态为 `unhealthy` | 查看容器日志，并在浏览器访问 `http://<NAS-IP>:<端口>/health` |
| NAS 页面可见但手机打不开 | 检查端口映射、防火墙、访客 Wi-Fi、AP 隔离、VLAN 和实际 NAS IP |
| 端口已被占用 | 在 Compose 编辑器中修改映射左侧，例如 `13000:3000`，再重新创建项目 |
| GitHub 页面验证失败 | 检查 Token 有效期、资源所有者、仓库范围、组织批准状态和权限 |
| 私有仓库返回 403 | 确认目标仓库已授权给控制台中验证的 Token，并使用 GitHub HTTPS 仓库地址 |
| Agent 显示未连接 | 在 Agent 设置中重新登录并测试，检查 `data/codex` 挂载是否存在 |
| Agent 返回 401 | 检查 Compose 环境变量中是否存在无效占位值，并重新完成官方登录 |
| `cpx-mihomo` 不断重启 | 检查 `data/mihomo/config.yaml` 是否存在，确认 YAML 可被 Mihomo 解析且 `mixed-port` 为 7890 |
| Mihomo 正常但 Agent 请求超时 | 检查代理组选择、最终匹配规则、节点状态，以及 cpx 使用的代理地址是否为 `http://mihomo:7890` |
| 更新后仍运行旧版本 | 在 Compose 项目详情确认执行了重新构建或重新创建，并检查当前容器镜像标识 |
| 重建后登录丢失 | 检查 `data/codex` 是否仍挂载到原来的项目存储目录 |

需要反馈问题时，从极空间界面导出或复制 Compose 项目状态、容器健康状态和最近日志。分享前删除 Token、应用 Secret、仓库敏感内容和其他凭据。
