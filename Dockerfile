# syntax=docker/dockerfile:1.7

# ---------- Stage 1: builder ----------
FROM node:22-slim AS builder

# better-sqlite3 编译工具（prebuilt 优先命中时不会真编译）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# --ignore-scripts 防止 better-sqlite3 安装脚本提前触发
RUN npm ci --ignore-scripts || npm install --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# 修剪 dev 依赖，并尝试补齐 better-sqlite3 原生模块
RUN npm prune --omit=dev && \
    (npm rebuild better-sqlite3 2>/dev/null || true)

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runtime

# 系统依赖：git、gh、SSH 客户端、curl、CA 证书
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git gnupg openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# 全局安装 Codex 和 Claude Code CLI
RUN npm install -g @openai/codex@latest @anthropic-ai/claude-code@latest

WORKDIR /app

# 从 builder 拷贝编译产物与生产依赖
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# 静态资源 + 配置示例（agent-cli init 命令需要）
COPY public/ ./public/
COPY config/ ./config/

# 数据目录占位（实际通过 volume 挂载覆盖）
RUN mkdir -p /app/data /app/logs

ENV NODE_ENV=production \
    AGENT_SERVER_HOST=0.0.0.0 \
    AGENT_SERVER_PORT=3000 \
    AGENT_STORAGE_PATH=/app/data/agent.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/console/settings >/dev/null || exit 1

CMD ["node", "dist/cli.js", "start", "-d", "/app/config"]
