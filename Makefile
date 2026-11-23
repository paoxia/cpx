.DEFAULT_GOAL := nas-docker-build

VERSION ?= dev-nas-image
PLATFORM ?= linux/amd64

.PHONY: nas-docker-build

# 仅在开发机执行：构建并导出供极空间导入的 Docker 镜像。
nas-docker-build:
	env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
		-u http_proxy -u https_proxy -u all_proxy \
		PATH="$$HOME/.docker/bin:$$PATH" \
		APT_MIRROR=http://mirrors.aliyun.com \
		NPM_REGISTRY=https://registry.npmmirror.com \
		bash scripts/docker-build.sh "$(VERSION)" "$(PLATFORM)"
