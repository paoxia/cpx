#!/usr/bin/env bash
# 在极空间 NAS 执行：加载 cpx 镜像并启动容器。
# 前置：
#   1. 把 cpx-latest.tar.gz 拷贝到 NAS 某目录（如 /tmp/cpx/）
#   2. 把 docker-compose.yml 和 .docker.env.example 也拷到同目录
#   3. 把本脚本也拷到同目录，或直接在 NAS 上执行
# 用法： ./docker-deploy.sh [tar文件] [工作目录]
#   tar 文件默认 cpx-latest.tar.gz
#   工作目录默认脚本所在目录；请把脚本放在 NAS 的持久化目录中执行
set -euo pipefail

TAR="${1:-cpx-latest.tar.gz}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${2:-${SCRIPT_DIR}}"

case "${WORKDIR}" in
  /*) ;;
  *) WORKDIR="$(pwd)/${WORKDIR}" ;;
esac

copy_if_needed() {
  local source="$1"
  local destination="$2"
  if [ "$(cd "$(dirname "${source}")" && pwd)/$(basename "${source}")" != \
       "$(cd "$(dirname "${destination}")" && pwd)/$(basename "${destination}")" ]; then
    cp "${source}" "${destination}"
  fi
}

if [ ! -f "${TAR}" ]; then
  echo "Error: 找不到 ${TAR}"
  echo "请把 cpx-latest.tar.gz 拷贝到当前目录，或通过参数指定路径"
  exit 1
fi

echo "==> Loading image from ${TAR}"
docker load < "${TAR}"

echo "==> Preparing working dir ${WORKDIR}"
mkdir -p \
  "${WORKDIR}/data/codex" \
  "${WORKDIR}/data/claude" \
  "${WORKDIR}/config" \
  "${WORKDIR}/logs"
chmod 700 "${WORKDIR}/data/codex" "${WORKDIR}/data/claude"

# 复制 compose 文件（首次部署或更新）
if [ -f "${SCRIPT_DIR}/docker-compose.yml" ]; then
  copy_if_needed "${SCRIPT_DIR}/docker-compose.yml" "${WORKDIR}/docker-compose.yml"
elif [ -f ./docker-compose.yml ]; then
  copy_if_needed ./docker-compose.yml "${WORKDIR}/docker-compose.yml"
else
  echo "Error: 找不到 docker-compose.yml"
  exit 1
fi

# 首次部署：生成 .docker.env 并提示用户编辑
if [ ! -f "${WORKDIR}/.docker.env" ]; then
  if [ -f "${SCRIPT_DIR}/.docker.env.example" ]; then
    copy_if_needed "${SCRIPT_DIR}/.docker.env.example" "${WORKDIR}/.docker.env"
  elif [ -f ./.docker.env.example ]; then
    copy_if_needed ./.docker.env.example "${WORKDIR}/.docker.env"
  else
    echo "Error: 找不到 .docker.env.example 模板"
    exit 1
  fi
  chmod 600 "${WORKDIR}/.docker.env"
  echo ""
  echo "==> 已生成 ${WORKDIR}/.docker.env"
  echo "    请编辑此文件；不用的密钥保持为空，也可启动后在控制台完成 GitHub 和 Agent 登录"
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
