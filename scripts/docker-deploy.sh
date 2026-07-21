#!/usr/bin/env bash
# 在极空间 NAS 执行：加载 cpx 镜像并启动容器。
# 前置：
#   1. 把 cpx-latest.tar.gz 拷贝到 NAS 某目录（如 /tmp/cpx/）
#   2. 把 docker-compose.yml 和 .docker.env.example 也拷到同目录
#   3. 把本脚本也拷到同目录，或直接在 NAS 上执行
# 用法： ./docker-deploy.sh [tar文件] [工作目录]
#   tar 文件默认 cpx-latest.tar.gz
#   工作目录默认 /tmp/cpx
set -euo pipefail

TAR="${1:-cpx-latest.tar.gz}"
WORKDIR="${2:-/tmp/cpx}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "${TAR}" ]; then
  echo "Error: 找不到 ${TAR}"
  echo "请把 cpx-latest.tar.gz 拷贝到当前目录，或通过参数指定路径"
  exit 1
fi

echo "==> Loading image from ${TAR}"
docker load < "${TAR}"

echo "==> Preparing working dir ${WORKDIR}"
mkdir -p "${WORKDIR}/data" "${WORKDIR}/config" "${WORKDIR}/logs"

# 复制 compose 文件（首次部署或更新）
if [ -f "${SCRIPT_DIR}/docker-compose.yml" ]; then
  cp "${SCRIPT_DIR}/docker-compose.yml" "${WORKDIR}/docker-compose.yml"
elif [ -f ./docker-compose.yml ]; then
  cp ./docker-compose.yml "${WORKDIR}/docker-compose.yml"
fi

# 首次部署：生成 .docker.env 并提示用户编辑
if [ ! -f "${WORKDIR}/.docker.env" ]; then
  if [ -f "${SCRIPT_DIR}/.docker.env.example" ]; then
    cp "${SCRIPT_DIR}/.docker.env.example" "${WORKDIR}/.docker.env"
  elif [ -f ./.docker.env.example ]; then
    cp ./.docker.env.example "${WORKDIR}/.docker.env"
  else
    echo "Error: 找不到 .docker.env.example 模板"
    exit 1
  fi
  chmod 600 "${WORKDIR}/.docker.env"
  echo ""
  echo "==> 已生成 ${WORKDIR}/.docker.env"
  echo "    请编辑此文件，填入 CODEX_API_KEY / ANTHROPIC_API_KEY / GH_TOKEN 等（Agent 也可稍后在模型设置中登录）"
  echo "    然后重新运行本脚本： ${0} ${TAR} ${WORKDIR}"
  exit 0
fi

cd "${WORKDIR}"
echo "==> Starting container"
docker compose up -d

echo ""
echo "==> Status"
docker compose ps

CONTAINER_IP=$(docker inspect cpx --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null || echo "")
echo ""
if [ -n "${CONTAINER_IP}" ]; then
  echo "Open http://${CONTAINER_IP}:3000 or http://<NAS-IP>:3000 on your phone"
else
  echo "Open http://<NAS-IP>:3000 on your phone"
fi
