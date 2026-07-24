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
  });
});

function parse(text: string) {
  return parser.parse(text, {
    userId: 'user-1',
    userName: 'Tester',
    source: 'cli',
  });
}
