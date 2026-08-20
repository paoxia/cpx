# 极空间 NAS 开发调试指南

本文说明如何把开发机上的当前 cpx 代码快速部署到极空间 NAS 试运行。NAS 侧只使用极空间文件管理器、Docker 镜像页面、Compose 图形界面、容器详情和日志页面，不要求开启 SSH，也不在 NAS 上执行命令。

正式部署、备份和更新规则见 [DEPLOYMENT.md](DEPLOYMENT.md)。本文聚焦开发阶段的短循环：Mihomo 镜像和配置只准备一次，此后每轮只替换 cpx 开发镜像。

## 一、调试方式

使用预构建镜像和 [docker-compose.mihomo.yml](../docker-compose.mihomo.yml)：

```text
开发机源码 → cpx:dev 镜像包 → 极空间图形界面导入
                                      │
                                      ▼
浏览器 ← NAS:3000 ← cpx → http://mihomo:7890 → 外部服务
```

不要同时创建 `docker-compose.yml`、`docker-compose.image.yml` 和 `docker-compose.mihomo.yml` 三个项目。它们都会使用容器名 `cpx` 和宿主机端口 3000：

- `docker-compose.yml`：在 NAS 上从源码构建；
- `docker-compose.image.yml`：运行预先导入的 cpx 镜像，不启动 Mihomo；
- `docker-compose.mihomo.yml`：运行预先导入的 cpx 镜像，并在同一 Docker 网络中启动 Mihomo。

本调试流程只使用 `docker-compose.mihomo.yml`。

## 二、首次准备

### 1. 确认 NAS 架构

在极空间系统信息或设备规格页面确认处理器架构：

| NAS 架构 | Docker 平台参数 |
|---|---|
| x86_64 / amd64 | `linux/amd64` |
| aarch64 / arm64 | `linux/arm64` |

后文默认使用 `linux/amd64`。ARM64 NAS 必须把构建和拉取命令中的平台改成 `linux/arm64`。

### 2. 在开发机构建当前代码

在开发机的项目根目录执行：

```bash
scripts/docker-build.sh dev linux/amd64
```

国内网络可同时使用 Debian 和 npm 镜像：

```bash
APT_MIRROR=http://mirrors.aliyun.com \
NPM_REGISTRY=https://registry.npmmirror.com \
  scripts/docker-build.sh dev linux/amd64
```

脚本构建 `cpx:dev` 并生成：

```text
cpx-dev.tar
```

该命令只能在开发机执行。生成的 tar 是本地构建产物，不应提交到 Git。

脚本会把开发机已经设置的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`、`APT_MIRROR` 和 `NPM_REGISTRY` 作为 Docker build args 传给构建步骤，但不会打印代理值。`APT_MIRROR` 影响 Debian 系统包，`NPM_REGISTRY` 同时影响项目依赖、Codex CLI 和 Claude Code CLI 的 npm 包下载。基础镜像拉取发生在构建步骤之前，仍由 Docker daemon 的网络和镜像加速配置负责。

### 3. 在开发机准备 Mihomo 镜像

首次部署需要准备 Compose 默认使用的 Mihomo 镜像：

```bash
docker pull --platform linux/amd64 metacubex/mihomo:v1.19.30
docker save -o mihomo-v1.19.30-amd64.tar metacubex/mihomo:v1.19.30
```

如果极空间能够稳定拉取该镜像，可以不生成 Mihomo tar，由 Compose 创建项目时拉取。网络不稳定时优先使用离线导入，以免把镜像拉取问题和 cpx 运行问题混在一起。

### 4. 准备 Mihomo 配置

项目的 [config/mihomo.example.yaml](../config/mihomo.example.yaml) 是可直接引用 Clash/Mihomo 订阅地址的完整示例。在开发机或可信设备上：

1. 复制该文件并命名为 `config.yaml`；
2. 用真实订阅地址替换 `https://example.invalid/replace-with-your-subscription-url`；
3. 如果服务商要求特定 User-Agent，将示例中的 `mihomo` 改为要求的值；
4. 通过极空间文件管理器上传为 `<CPX_DIR>/data/mihomo/config.yaml`。

示例使用 `proxy-providers` 每小时更新订阅，通过 `AUTO` 组自动选择节点，并让 cpx 的所有出站请求走 `PROXY`。首次启动时还没有可用节点，因此订阅地址本身必须可以直连下载。代理容器仍需具有合法可用的上游配置；空配置不能改变外部服务的可达性或地区支持政策。

### 5. 通过极空间文件管理器准备目录

在项目持久化目录中整理以下结构：

```text
<CPX_DIR>/
├── docker-compose.mihomo.yml
├── data/
│   ├── mihomo/
│   │   └── config.yaml
│   ├── codex/
│   ├── claude/
│   └── workspaces/
├── config/
└── logs/
```

通过文件管理器上传：

- `docker-compose.mihomo.yml`；
- `cpx-dev.tar`；
- 首次部署时的 Mihomo 镜像包；
- `data/mihomo/config.yaml`。

`data/mihomo/config.yaml` 可能包含订阅地址、节点密码和其他凭据。限制目录访问权限，不要把它提交到 Git、发送到聊天或复制到不可信备份。

### 6. 通过极空间图形界面导入镜像

进入“Docker → 镜像 → 本地导入”，依次导入：

```text
cpx-dev.tar
mihomo-v1.19.30-amd64.tar
```

导入后确认镜像列表中存在：

```text
cpx:dev
metacubex/mihomo:v1.19.30
```

### 7. 创建 Compose 调试项目

进入“Docker → Compose → 新建项目”：

1. 项目名称填写 `cpx-dev`；
2. 项目存储位置选择 `<CPX_DIR>`；
3. 只导入或粘贴 `docker-compose.mihomo.yml`；
4. 在 Compose 环境变量界面填写：

   ```dotenv
   CPX_IMAGE=cpx:dev
   MIHOMO_IMAGE=metacubex/mihomo:v1.19.30
   ```

5. 其他 Token 暂时可以留空，然后创建项目。

不要额外覆盖 `HTTP_PROXY` 或 `HTTPS_PROXY`。这份 Compose 已把 cpx 的代理地址固定为 `http://mihomo:7890`，且没有把 Mihomo 的代理端口映射到 NAS 或局域网。

## 三、首次启动验证

项目创建后应出现两个容器：

```text
cpx-mihomo
cpx
```

按以下顺序验证：

1. 打开 `cpx-mihomo` 日志，确认没有 `config.yaml not found`、YAML 解析错误、持续重启或节点加载错误；
2. 打开 `cpx` 日志，确认服务监听 `0.0.0.0:3000`；
3. 浏览器访问 `http://<NAS-IP>:3000/health`，预期返回包含 `"status":"ok"` 的 JSON；
4. 浏览器访问 `http://<NAS-IP>:3000`；
5. 在“模型设置”中连接 Codex，完成设备码登录并执行一条简短测试；
6. 首个开发任务使用测试仓库，不创建 Pull Request，先验证读取型任务。

用于设备码登录的电脑或手机也必须能够打开验证页面。网络可达不等于外部服务在当前地区受到官方支持，使用前应确认账号、位置和上游配置符合相应政策与当地要求。

## 四、日常开发循环

Mihomo 镜像、Mihomo 配置和持久化目录通常不需要变化。每次修改 cpx 代码后执行以下流程。

### 开发机

```bash
APT_MIRROR=http://mirrors.aliyun.com \
NPM_REGISTRY=https://registry.npmmirror.com \
  scripts/docker-build.sh dev linux/amd64
```

### 极空间图形界面

1. 通过文件管理器覆盖上传新的 `cpx-dev.tar`；
2. 在 Docker 镜像页面重新导入 `cpx-dev.tar`；
3. 在 Compose 项目中重新创建 `cpx` 容器；
4. 如果界面只能重新创建整个项目，可以执行项目级重新创建；
5. 在容器详情中确认 cpx 使用的镜像标识已经变化；
6. 检查 `/health`、页面功能和本轮改动对应的行为。

重新创建容器或项目不会删除目录挂载中的 `data/mihomo`、`data/codex`、`data/claude`、`data/workspaces`、`config` 和数据库。不要在调试更新时删除这些目录，也不要选择带“删除数据卷”含义的操作。

## 五、同名镜像未更新时

某些极空间版本可能仍让新容器引用旧的 `cpx:dev` 镜像。出现这种情况时，每轮使用唯一标签：

```bash
scripts/docker-build.sh dev-20260820-1 linux/amd64
```

上传并导入生成的 `cpx-dev-20260820-1.tar`，然后在 Compose 环境变量中更新：

```dotenv
CPX_IMAGE=cpx:dev-20260820-1
```

重新创建 cpx 容器并检查镜像标识。验证完成后，可以通过极空间镜像页面删除不再被容器使用的旧开发镜像；不要删除项目持久化目录。

## 六、常见问题

| 现象 | 图形界面检查与处理 |
|---|---|
| `cpx-mihomo` 持续重启 | 检查 `data/mihomo/config.yaml` 是否存在，确认 YAML 能被 Mihomo 解析且 `mixed-port` 为 7890 |
| Mihomo 正常但 Codex 超时 | 检查代理组选择、最终 `MATCH` 规则和节点状态，确认 cpx 代理地址仍为 `http://mihomo:7890` |
| Compose 尝试拉取 `cpx:dev` | `cpx-dev.tar` 尚未成功导入，或导入后的镜像标签与 `CPX_IMAGE` 不一致 |
| 页面仍是旧版本 | 重新导入镜像并重新创建容器，检查新旧镜像标识；必要时使用唯一开发标签 |
| 端口 3000 被占用 | 在 Compose 中只修改端口映射左侧，例如 `13000:3000`，然后访问 `http://<NAS-IP>:13000` |
| Codex 登录后重建又丢失 | 检查 `./data/codex:/root/.codex` 是否仍挂载到原来的持久化目录 |
| 架构错误或 `exec format error` | 按 NAS 实际架构重新构建并导入 cpx 与 Mihomo 镜像 |
| `resolve image config` 或 `registry-1.docker.io` 超时 | Docker daemon 无法拉取 Dockerfile frontend 或基础镜像；在开发机为 Docker Engine/BuildKit 配置出站代理，不能只设置当前 shell 或 build args |
| 构建长时间停在 `apt-get` | 终止当前构建，设置 `APT_MIRROR=http://mirrors.aliyun.com` 后重新执行构建脚本 |
| 构建长时间停在 `npm install` | 终止当前构建，设置 `NPM_REGISTRY=https://registry.npmmirror.com` 后重新执行构建脚本；确认两个 CLI 包在该镜像中存在 |

需要反馈问题时，从极空间界面复制 Compose 状态、两个容器的镜像标识、健康状态和最近日志。分享前删除订阅地址、节点凭据、Token、设备码、callback 地址和仓库敏感内容。
