# AGENTS 文档

本文帮助 AI 和贡献者快速找到项目文档。文档内容应描述已经存在的事实、明确的决策或正在执行的计划；不要为可能出现的功能预建空模板。

## 文档入口

- `README.md`：安装、配置、命令和公开使用说明
- `docs/DEPLOYMENT.md`：极空间 Docker 部署、镜像构建和密钥配置说明
- `ARCHITECTURE.md`：当前系统架构、数据流和扩展边界
- `docs/README.md`：项目文档的唯一导航入口

## docs/ 目录

- `PRODUCT.md`：产品定位、目标用户、核心场景和范围边界
- `DEVELOPMENT.md`：开发环境、代码组织、验证方式和文档维护规则
- `SECURITY.md`：当前安全控制、信任边界和已知风险
- `specs/agent-system.md`：系统能力与验收要求
- `plans/roadmap.md`：已交付能力和未排期方向
- `DATABASE.md`：从数据库迁移定义整理出的表结构

## 维护约定

- 使用方式变化时更新 `README.md`。
- 组件关系或数据流变化时更新 `ARCHITECTURE.md`。
- 用户可观察行为变化时更新对应规格。
- 只有正在推进且有明确结果的事项才进入计划文档。
- `src/storage/migrations.ts` 是数据库结构的事实来源，变更后同步 `docs/DATABASE.md`。
