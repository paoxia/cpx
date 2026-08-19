#!/usr/bin/env bash
# 仅在开发机执行：构建 cpx Docker 镜像并导出为 tar，供极空间 Docker 图形界面导入。
# 用法： scripts/docker-build.sh [version] [platform]
#   version 默认为 latest
#   platform 默认为 DOCKER_PLATFORM 环境变量，未设置时为 linux/amd64
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-latest}"
PLATFORM="${2:-${DOCKER_PLATFORM:-linux/amd64}}"
IMAGE="cpx:${VERSION}"
TAR="cpx-${VERSION}.tar"

echo "==> Building ${IMAGE} for ${PLATFORM}"
docker build --platform "${PLATFORM}" -t "${IMAGE}" .

echo "==> Saving to ${TAR}"
docker save -o "${TAR}" "${IMAGE}"

echo ""
echo "Done: $(ls -lh "${TAR}" | awk '{print $5, $9}')"
echo "Next steps:"
echo "  1. Upload ${TAR} to a persistent folder with the ZSpace file manager"
echo "  2. Import ${TAR} from the ZSpace Docker image page"
echo "  3. Create a Compose project with docker-compose.image.yml"
