import { describe, expect, it } from 'vitest';
import { CommandParser } from '../../../src/core/CommandParser';

const parser = new CommandParser();

describe('CommandParser Coding Agent 命令', () => {
  it('应识别 GitHub 概览和分支查询', () => {
    expect(parse('查看GitHub').name).toBe('github_overview');
    expect(parse('github status').name).toBe('github_overview');
    expect(parse('查看分支 paoxia/cpx')).toMatchObject({
      name: 'github_branches',
      args: { repository: 'paoxia/cpx' },
    });
  });

  it('应解析包含基础分支和新分支的开发任务', () => {
    expect(parse('开发 paoxia/cpx#dev -> feature/fix-login 修复登录页面布局')).toMatchObject({
      name: 'agent_develop',
      args: {
        repository: 'paoxia/cpx',
        baseBranch: 'dev',
        taskBranch: 'feature/fix-login',
        prompt: '修复登录页面布局',
      },
    });
  });

  it('省略分支时应将仓库后的全部文本作为需求', () => {
    expect(parse('开发 paoxia/cpx 修复登录页面布局并补充测试')).toMatchObject({
      name: 'agent_develop',
      args: {
        repository: 'paoxia/cpx',
        baseBranch: undefined,
        taskBranch: undefined,
        prompt: '修复登录页面布局并补充测试',
      },
    });
  });

  it('应识别任务列表、状态和取消命令', () => {
    expect(parse('最近任务 3')).toMatchObject({
      name: 'agent_task_list',
      args: { limit: 3 },
    });
    expect(parse('任务 abcdef12')).toMatchObject({
      name: 'agent_task_status',
      args: { id: 'abcdef12' },
    });
    expect(parse('取消任务 abcdef12')).toMatchObject({
      name: 'agent_task_cancel',
      args: { id: 'abcdef12' },
    });
    expect(parse('继续 abcdef12 把按钮颜色改成蓝色')).toMatchObject({
      name: 'agent_task_continue',
      args: { id: 'abcdef12', prompt: '把按钮颜色改成蓝色' },
    });
  });

  it('飞书和钉钉普通文本应路由到 Coding Agent 对话', () => {
    for (const [source, text] of [
      ['feishu', '/agent 帮我分析一下登录流程'],
      ['dingtalk', '@agent-bot 帮我分析一下登录流程'],
    ] as const) {
      expect(
        parser.parse(text, {
          userId: 'user-1',
          userName: 'Tester',
          source,
        }),
      ).toMatchObject({
        name: 'agent_chat',
        args: { prompt: '帮我分析一下登录流程' },
      });
    }
    expect(parse('帮我分析一下登录流程').name).toBe('帮我分析一下登录流程');
  });

  it('消息平台应只为少量斜杠入口保留确定性控制', () => {
    const user = { userId: 'user-1', userName: 'Tester', source: 'feishu' as const };
    expect(parser.parse('/new', user).name).toBe('agent_new');
    expect(parser.parse('/tasks 3', user)).toMatchObject({
      name: 'agent_task_list',
      args: { limit: 3 },
    });
    expect(parser.parse('/status', user)).toMatchObject({
      name: 'agent_task_status',
      args: { id: undefined },
    });
    expect(parser.parse('/stop abcdef12', user)).toMatchObject({
      name: 'agent_task_cancel',
      args: { id: 'abcdef12' },
    });
    expect(parser.parse('帮我看看有哪些仓库', user)).toMatchObject({
      name: 'agent_chat',
      args: { prompt: '帮我看看有哪些仓库' },
    });
  });

  it('应保留消息来源会话路由但不改变用户身份', () => {
    const command = parser.parse('/agent 版本', {
      userId: 'user-1',
      userName: 'Tester',
      source: 'feishu',
      replyRouteId: 'chat-1:user-1',
    });
    expect(command).toMatchObject({
      userId: 'user-1',
      replyRouteId: 'chat-1:user-1',
    });
  });
});

function parse(text: string) {
  return parser.parse(text, {
    userId: 'user-1',
    userName: 'Tester',
    source: 'cli',
  });
}
