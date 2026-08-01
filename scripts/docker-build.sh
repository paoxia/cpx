#!/usr/bin/env bash
# 在开发机执行：构建 cpx Docker 镜像并导出为 tar.gz，便于拷贝到极空间 NAS。
# 用法： scripts/docker-build.sh [version] [platform]
#   version 默认为 latest
#   platform 默认为 DOCKER_PLATFORM 环境变量，未设置时为 linux/amd64
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-latest}"
PLATFORM="${2:-${DOCKER_PLATFORM:-linux/amd64}}"
IMAGE="cpx:${VERSION}"
TAR="cpx-${VERSION}.tar.gz"

echo "==> Building ${IMAGE} for ${PLATFORM}"
docker build --platform "${PLATFORM}" -t "${IMAGE}" .

echo "==> Saving to ${TAR}"
docker save "${IMAGE}" | gzip > "${TAR}"

echo ""
echo "Done: $(ls -lh "${TAR}" | awk '{print $5, $9}')"
echo "Next steps:"
echo "  1. Copy ${TAR} to NAS (e.g. /tmp/cpx/)"
echo "  2. Copy docker-compose.yml and .docker.env.example to the same dir"
echo "  3. Run scripts/docker-deploy.sh on NAS"
