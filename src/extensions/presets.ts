import type { CliExtensionInput } from './schema';

/** 只注册调用方式；可执行文件和登录状态由外部 CLI 管理。 */
export const CLI_PRESETS: Readonly<Record<string, CliExtensionInput>> = {
  dingtalk: {
    name: 'dingtalk',
    description:
      '钉钉 Workspace CLI。先用 --help 发现产品命令，再读取子命令帮助；登录由 dws 管理。',
    command: 'dws',
    versionArgs: ['version'],
  },
  feishu: {
    name: 'feishu',
    description: '飞书官方 CLI。先用 --help 发现产品命令；登录由 lark-cli 管理。',
    command: 'lark-cli',
  },
};
