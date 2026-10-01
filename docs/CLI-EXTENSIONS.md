# 动态 CLI 扩展

CPX 用 YAML manifest 注册外部可执行文件。钉钉、飞书和自定义工具共用 `CliExtensionRegistry`，无需为每个 CLI 编写适配代码。注册、覆盖、启停与移除后，下一次调用会读取最新配置，不需要重启服务。

全局 `--home` 放在子命令前，例如 `cpx --home /path/to/cpx cli list`；外部 CLI 的参数放在 `run <name> --` 后。

注册目录默认为 `~/.cpx/config/extensions/`；`CPX_HOME` 或 `--home` 改变运行根目录。源码或 Docker 使用自定义配置目录时，管理命令必须指定与 `start --dir` 相同的目录，例如 `cpx cli --dir ./config list`。每个扩展保存为 `<name>.yaml`，执行元数据写入同目录的 `.audit.jsonl`。

## 钉钉和飞书

内置模板分别使用官方 [钉钉 Workspace CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli) 的 `dws` 和 [飞书 CLI](https://github.com/larksuite/cli) 的 `lark-cli`。CPX 的 `add` 只保存注册信息，可执行文件、账号登录、凭据刷新和版本升级由这些 CLI 自己管理。机器人长连接配置与 CLI 登录是两套独立凭据。

以下命令用于开发机或普通 CLI 主机，且登录和 CPX 服务必须使用同一系统用户。在极空间 NAS 部署时使用本文后面的图形界面流程。

```bash
# 按两个 CLI 的官方说明安装后，分别完成登录
dws auth login
lark-cli config init
lark-cli auth login --recommend

# 注册并运行：默认只供本地调用，Agent 未授权
cpx cli add dingtalk
cpx cli add feishu
cpx cli doctor
cpx cli run dingtalk -- calendar event list
cpx cli run feishu -- calendar +agenda
```

如需让 Agent 查询日程，显式授权相关前缀：

```bash
cpx cli add dingtalk --force --agent \
  --allow '["--help"]' --allow '["version"]' \
  --allow '["calendar","event","list"]'
cpx cli add feishu --force --agent \
  --allow '["--help"]' --allow '["--version"]' \
  --allow '["calendar","+agenda"]'
```

运行中的聊天协调 Agent、聊天开发任务和 Web 开发任务均可发现这些扩展。用户可以在聊天中提出“查一下今天的日程”，Agent 先通过 `cli_list` 查看已授权能力，再用 `cli_run` 执行。授权更精细的子命令时，Agent 可在该前缀后追加 `--help` 查看参数。`description` 可以补充工具用途和使用步骤。

## 自定义 CLI

最简单的注册方式：

```bash
cpx cli add github --command gh
cpx cli run github -- repo list
cpx cli list
cpx cli info github
cpx cli disable github
cpx cli enable github
cpx cli remove github
```

`--command` 是可执行文件名或路径，不能填写 `gh repo list` 这样的 shell 文本。固定前置参数可通过 `--args '["参数1","参数2"]'` 配置，例如使用 `node` 调用 JS 程序。`--preset feishu` 可以给模板指定自定义注册名称；`--force` 会完整替换注册，未再次提供的设置不会保留。

复杂配置可以从 YAML 导入。仓库和 npm 包提供可直接使用的 [GitHub CLI 示例](../config/cli-extension.example.yaml)：

```bash
# 本机已安装 gh；AGENT_GITHUB_TOKEN 已由服务环境提供
cpx cli add github --file config/cli-extension.example.yaml
cpx cli run github -- repo list
```

manifest 字段如下：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `version` | `1` | manifest 格式版本 |
| `name` | 必填 | 小写字母开头，只含小写字母、数字、`_`、`-`，最多 64 字符；必须匹配文件名 |
| `command` | 必填 | 可执行文件名或路径；通过 `PATH` 查找名称，相对路径以注册目录为基准 |
| `description` | 空字符串 | 对人和 Agent 的用途与操作提示，最多 4000 字符 |
| `args` | `[]` | 固定前置参数；运行时在后面追加调用参数 |
| `versionArgs` | `["--version"]` | `doctor` 使用的调用参数；钉钉模板使用 `["version"]` |
| `cwd` | 配置目录的父目录 | 固定工作目录；显式相对路径以注册目录为基准 |
| `env` | `{}` | 目标环境变量名 → 服务进程环境变量名，禁止填写密钥值 |
| `enabled` | `true` | 是否启用；禁用后拒绝新的调用 |
| `agentEnabled` | `false` | 是否授权给 Agent；为 `true` 时必须填写非空 `allowedPrefixes` |
| `allowedPrefixes` | `[]` | 参数数组前缀列表；非空时同时约束本地与 Agent 调用，空列表只允许本地不限制参数 |
| `timeoutMs` | `30000` | 超时，范围 10–600000 毫秒 |
| `maxOutputBytes` | `131072` | stdout 与 stderr 合计上限，范围 256–10485760 字节 |

参数最多 256 项，每项最多 64 KiB，不允许 NUL。未知字段、无效 manifest 或文件名不一致会报错，不会静默忽略配置。`--allow` 接受一个 JSON 字符串数组，可重复提供；它匹配运行时调用参数，不匹配固定 `args`。例如 `["calendar","event","list"]` 允许追加参数，但不允许 `calendar event delete` 或在该前缀之前插入全局选项。

如需固定账号、组织或输出格式，使用 manifest 的固定 `args` 或原 CLI 支持的环境变量，并仔细确认原 CLI 是否允许后续参数覆盖这些设置。前缀限制是命令入口控制，不是按资源或用户的权限隔离。

## 执行与 Agent 边界

- CPX 使用 `spawn` 和参数数组，不经过 shell；`$()`、`;`、管道等内容作为普通参数传入。外部工具本身仍可能执行脚本或访问任意文件，不构成安全沙箱。
- stdin 立即关闭，交互式安装和登录应先通过原 CLI 完成。Windows 下请使用 `.exe` 或以 `node` 加固定脚本路径注册，扩展执行器不会用 shell 执行 `.cmd` 文件。
- 超时、取消和输出超限会终止子进程；POSIX 系统同时终止其进程组，并在 300 毫秒后强制终止。Windows 只保证终止直接子进程。
- 本地 `run` 返回原退出码；超时返回 124，输出超限返回 125。Agent 收到结构化 stdout、stderr、退出码、信号和限制状态；非零退出、超时及超限均标记为失败。
- 子进程继承服务环境，`env` 仅增加变量映射。返回输出会尽力隐藏已知密钥环境变量和显式映射的值；外部工具仍可能打印其他敏感内容，不应在参数、描述或固定 `args` 中填写凭据。
- 审计记录扩展名、执行 ID、来源类型、起止时间和退出状态，不保存参数或输出。聊天调用另外沿用现有随机会话/任务 Token 校验及 SQLite 的 `agent_platform_tool` 审计；聊天 `cli_list`、`cli_run` 可通过操作黑名单禁用。
- CLI 操作使用服务运营者的账号，不会自动绑定原聊天用户或会话。所有能使用 CPX 的 Agent 共享已授权的扩展；需要隔离身份时，使用独立 CPX 实例和原 CLI 的最小权限账号。原会话回复继续使用 `platform_send_message`。
- 禁用或移除只影响后续调用，已开始的命令不会因此回滚或取消。进程停止不能撤销已经提交到外部平台的请求。

Web 任务通过本地 `cpx_cli` stdio MCP 调用扩展，聊天通过现有 `cpx_platform` 回调接口执行扩展；CPX 不会修改用户全局 MCP 配置。新增扩展在下一次 `cli_list` / `cli_run` 时可用，包括既有任务的续写。

## 极空间 NAS

默认镜像没有安装 `dws` 或 `lark-cli`。在开发机按目标 NAS 架构准备包含所需 CLI 的自定义镜像和登录材料，再按 [部署指南](DEPLOYMENT.md) 上传镜像、从 Docker 镜像页面导入，通过 Compose 图形界面替换并重新创建容器。不要把开发机上的登录状态视为容器已经登录；凭据迁移和持久化应遵循原 CLI 官方说明。

通过极空间文件管理器在挂载的 `config` 目录创建 `extensions`，上传 `<name>.yaml` manifest；容器会从 `/app/config/extensions` 动态读取。使用可执行文件的容器内路径，环境变量在 Compose 图形界面配置，凭据文件通过 Compose 挂载并限制访问权限。查看容器详情和日志排查可执行文件、工作目录及环境变量问题。整个 NAS 流程使用文件管理器和 Docker 图形界面，不需要 NAS 终端。
