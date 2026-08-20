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

# Docker daemon 代理负责拉取 Dockerfile frontend 和基础镜像；这里的
# build args 负责把开发机已有的代理配置传给 apt、npm 等构建步骤。
# 不打印代理值，避免包含认证信息的 URL 进入终端日志。
BUILD_ARGS=()
for PROXY_NAME in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY; do
  PROXY_VALUE="${!PROXY_NAME:-}"
  if [[ -n "${PROXY_VALUE}" ]]; then
    BUILD_ARGS+=(--build-arg "${PROXY_NAME}=${PROXY_VALUE}")
  fi
done
if [[ -n "${NPM_REGISTRY:-}" ]]; then
  BUILD_ARGS+=(--build-arg "NPM_REGISTRY=${NPM_REGISTRY}")
fi
if [[ -n "${APT_MIRROR:-}" ]]; then
  BUILD_ARGS+=(--build-arg "APT_MIRROR=${APT_MIRROR}")
fi

echo "==> Building ${IMAGE} for ${PLATFORM}"
if (( ${#BUILD_ARGS[@]} > 0 )); then
  echo "==> Forwarding configured build network settings"
fi
docker build "${BUILD_ARGS[@]}" --platform "${PLATFORM}" -t "${IMAGE}" .

echo "==> Saving to ${TAR}"
docker save -o "${TAR}" "${IMAGE}"

echo ""
echo "Done: $(ls -lh "${TAR}" | awk '{print $5, $9}')"
echo "Next steps:"
echo "  1. Upload ${TAR} to a persistent folder with the ZSpace file manager"
echo "  2. Import ${TAR} from the ZSpace Docker image page"
echo "  3. Create a Compose project with docker-compose.image.yml"
