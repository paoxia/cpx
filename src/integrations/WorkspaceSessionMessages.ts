import type { Command, CommandResult } from '../core/types';
import type { StoryRunner } from '../workspace/StoryRunner';

const pageSize = 8;

export class WorkspaceSessionMessages {
  constructor(private readonly runner: StoryRunner) {}

  async handle(
    command: Command,
    root: string | undefined,
    allowedUsers: string[],
  ): Promise<CommandResult> {
    const { id: commandId, source, userId, replyRouteId, args } = command;
    const reply = (message: string, success = true): CommandResult => ({
      commandId,
      success,
      message,
    });
    if ((source !== 'dingtalk' && source !== 'feishu') || !replyRouteId) {
      return reply('请在钉钉或飞书机器人会话里使用这个命令。', false);
    }
    if (args.action === 'identity') return reply(`你的机器人用户 ID：${userId}`);
    if (!root)
      return reply('消息平台的工作区未配置，请在 cpx 中配置 messagingWorkspaceRoot。', false);
    if (!allowedUsers.includes(userId)) {
      return reply('此账号尚未获准访问工作区会话。发送 /whoami 可查看自己的用户 ID。', false);
    }

    const routeKey = JSON.stringify([source, userId, replyRouteId]);
    const storyId = typeof args.id === 'string' ? args.id : undefined;
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    switch (args.action) {
      case 'list': {
        const page = args.page === undefined ? 1 : Number(args.page);
        if (!Number.isSafeInteger(page) || page < 1) return reply('用法：/sessions [页码]', false);
        const { sessions, current } = await this.runner.listMessagingSessions(root, routeKey);
        if (!sessions.length) return reply('当前工作区暂无会话。发送 /new <想法> 可以创建。');
        const pages = Math.ceil(sessions.length / pageSize);
        if (page > pages) return reply(`共 ${pages} 页，请使用 /sessions <页码>。`, false);
        const rows = sessions
          .slice((page - 1) * pageSize, page * pageSize)
          .map(
            ({ id, title }) =>
              `• ${title?.slice(0, 80) ?? id.slice(11)}${id === current ? '（当前）' : ''}\n  ${id}`,
          );
        const navigation = page < pages ? `\n\n下一页：/sessions ${page + 1}` : '';
        return reply(
          `工作区会话（${page}/${pages} 页，共 ${sessions.length} 个）\n${rows.join('\n')}${navigation}`,
        );
      }
      case 'new':
        if (!prompt) {
          await this.runner.selectMessagingSession(root, routeKey);
          return reply('下一条消息将开启新会话。');
        }
        break;
      case 'switch':
      case 'resume':
        if (!storyId || (args.action === 'switch' && prompt)) {
          const usage = args.action === 'switch' ? '/switch <会话 ID>' : '/resume <会话 ID> [消息]';
          return reply(`用法：${usage}\n发送 /sessions 可查看会话 ID。`, false);
        }
        if (!prompt) {
          const session = await this.runner.selectMessagingSession(root, routeKey, storyId);
          return reply(`已切换到「${session?.title ?? storyId}」。下一条消息将继续这个会话。`);
        }
        break;
      case 'send':
        break;
      default:
        return reply('未知会话命令。发送 /help 查看用法。', false);
    }

    if (!prompt || prompt.length > 20_000) return reply('请输入 1 到 20,000 字的消息。', false);
    const run = await this.runner.start(root, prompt, storyId, {
      routeKey,
      startNew: args.action === 'new',
    });
    return { ...reply('已提交给 Codex，完成后会在这里回复。'), data: { runId: run.id } };
  }

  async result(commandId: string, runId: string): Promise<CommandResult> {
    const run = await this.runner.waitForRun(runId);
    const reference = run.storyId ? `会话：${run.storyId}\n\n` : '';
    const result =
      run.status === 'completed'
        ? run.response || 'Codex 已完成本轮。'
        : run.status === 'cancelled'
          ? '本轮已停止。'
          : run.error || 'Codex 本轮执行失败。';
    const limit = 1000;
    const message =
      result.length <= limit
        ? result
        : `${result.slice(0, limit)}…\n\n完整回复请在 cpx 会话中查看。`;
    return { commandId, success: run.status === 'completed', message: reference + message };
  }
}
