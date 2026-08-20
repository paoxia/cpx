import { randomUUID } from 'crypto';
import type { Command, CommandSource } from './types';
import { CommandError } from '../utils/errors';

export interface ParsedUserInfo {
  userId: string;
  userName: string;
  source: CommandSource;
  replyRouteId?: string;
}

/**
 * 命令解析器：将原始消息文本解析为 Command 对象
 *
 * 支持的命令格式：
 * - @agent 修改 <file> <description>   -> github_modify
 * - @agent 新建文件 <file> <description> -> github_create
 * - @agent 查看GitHub                  -> github_overview
 * - @agent 查看分支 <owner/repo>       -> github_branches
 * - @agent 开发 <repo>[#base] [-> branch] <prompt> -> agent_develop
 * - @agent 任务 <id>                   -> agent_task_status
 * - @agent 执行 <skill> [json]          -> skill_execute
 * - @agent 确认 <id>                    -> confirm
 * - @agent 取消 <id>                    -> cancel
 * - @agent 列出 skill                   -> list_skills
 * - @agent 列出 mcp                     -> list_mcp
 * - @agent 列出 agent                   -> list_agent
 * - @agent version / 版本               -> version
 * - @agent help / 帮助                  -> help
 * - @agent <cmd> <json>                 -> <cmd> (fallback)
 */
export class CommandParser {
  parse(rawText: string, userInfo: ParsedUserInfo): Command {
    const text = this.stripPrefix(rawText, userInfo.source).trim();
    if (!text) {
      throw new CommandError('空命令');
    }

    const { name, args } = this.matchCommand(text);
    return {
      id: randomUUID(),
      source: userInfo.source,
      userId: userInfo.userId,
      userName: userInfo.userName,
      ...(userInfo.replyRouteId ? { replyRouteId: userInfo.replyRouteId } : {}),
      rawText,
      name,
      args,
      timestamp: Date.now(),
    };
  }

  /** 移除 @agent / /agent 前缀 */
  private stripPrefix(text: string, source: CommandSource): string {
    let t = text.trim();
    // 钉钉：@agent 或 @小助手xxx
    if (source === 'dingtalk') {
      t = t.replace(/^@\S+\s+/, '');
    }
    // 飞书：/agent
    if (source === 'feishu') {
      t = t.replace(/^\/agent\s+/i, '').replace(/^@\S+\s+/, '');
    }
    return t;
  }

  private matchCommand(text: string): { name: string; args: Record<string, unknown> } {
    const lower = text.toLowerCase();

    // version
    if (lower === 'version' || lower === '版本') {
      return { name: 'version', args: {} };
    }
    // help
    if (lower === 'help' || lower === '帮助' || lower === '?') {
      return { name: 'help', args: {} };
    }

    // 查看 GitHub 账号和最近仓库
    if (
      /^(?:查看\s*github(?:\s*(?:情况|状态))?|github(?:\s*(?:status|情况|状态))?|仓库|列出仓库)$/i.test(
        text,
      )
    ) {
      return { name: 'github_overview', args: {} };
    }

    // 查看分支 <owner/repo>
    let m = text.match(/^(?:查看\s*分支|分支|branches?)\s+([a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+)$/i);
    if (m) {
      return { name: 'github_branches', args: { repository: m[1] } };
    }

    // 开发 owner/repo[#base] [-> task-branch] <prompt>
    m = text.match(
      /^(?:开发|编码|coding|code)\s+([a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+)(?:#([a-zA-Z0-9._/-]+))?(?:\s+->\s+([a-zA-Z0-9._/-]+))?\s+([\s\S]+)$/i,
    );
    if (m) {
      return {
        name: 'agent_develop',
        args: {
          repository: m[1],
          baseBranch: m[2],
          taskBranch: m[3],
          prompt: m[4].trim(),
        },
      };
    }

    // 取消任务 <id>
    m = text.match(/^(?:取消任务|cancel\s+task)\s+([a-f0-9-]{6,36})$/i);
    if (m) {
      return { name: 'agent_task_cancel', args: { id: m[1] } };
    }

    // 最近任务 [数量]
    m = text.match(/^(?:最近任务|任务列表|tasks?)(?:\s+(\d+))?$/i);
    if (m) {
      return { name: 'agent_task_list', args: { limit: m[1] ? Number(m[1]) : undefined } };
    }

    // 任务 <id>
    m = text.match(/^(?:任务|task)\s+([a-f0-9-]{6,36})$/i);
    if (m) {
      return { name: 'agent_task_status', args: { id: m[1] } };
    }

    // 确认 <id>
    m = text.match(/^(?:确认|confirm)\s+(cf_[a-f0-9]+)$/i);
    if (m) {
      return { name: 'confirm', args: { id: m[1] } };
    }
    // 取消 <id>
    m = text.match(/^(?:取消|cancel)\s+(cf_[a-f0-9]+)$/i);
    if (m) {
      return { name: 'cancel', args: { id: m[1] } };
    }

    // 修改 <file> <description>
    m = text.match(/^(?:修改|modify|update)\s+(\S+)\s+(.+)$/);
    if (m) {
      return { name: 'github_modify', args: { file: m[1], description: m[2] } };
    }
    // 新建文件 <file> <description>
    m = text.match(/^(?:新建文件|创建文件|create\s+file)\s+(\S+)\s+(.+)$/i);
    if (m) {
      return { name: 'github_create', args: { file: m[1], description: m[2] } };
    }
    // 读取文件 <file>
    m = text.match(/^(?:读取文件|读文件|read\s+file)\s+(\S+)$/i);
    if (m) {
      return { name: 'github_read', args: { file: m[1] } };
    }

    // 执行 <skill> [json]
    m = text.match(/^(?:执行|execute|run)\s+(\S+)\s*(.*)$/);
    if (m) {
      const skill = m[1];
      const rest = m[2].trim();
      let args: Record<string, unknown> = { skill };
      if (rest) {
        try {
          const parsed = JSON.parse(rest);
          if (typeof parsed === 'object' && parsed !== null) {
            args = { skill, ...parsed };
          } else {
            args = { skill, input: parsed };
          }
        } catch {
          args = { skill, input: rest };
        }
      }
      return { name: 'skill_execute', args };
    }

    // 调用mcp <连接> <方法> [params]
    m = text.match(/^(?:调用mcp|mcp\s+call|call\s+mcp)\s+(\S+)\s+(\S+)\s*(.*)$/i);
    if (m) {
      const params = m[3].trim();
      let parsedParams: unknown = undefined;
      if (params) {
        try {
          parsedParams = JSON.parse(params);
        } catch {
          parsedParams = params;
        }
      }
      return {
        name: 'mcp_call',
        args: { connectionId: m[1], method: m[2], params: parsedParams },
      };
    }

    // 连接mcp <name>
    m = text.match(/^(?:连接mcp|mcp\s+connect|connect\s+mcp)\s+(\S+)$/i);
    if (m) {
      return { name: 'mcp_connect', args: { name: m[1] } };
    }

    // 断开mcp <id|name>
    m = text.match(/^(?:断开mcp|mcp\s+disconnect|disconnect\s+mcp)\s+(\S+)$/i);
    if (m) {
      return { name: 'mcp_disconnect', args: { id: m[1] } };
    }

    // 列出 <resource>
    m = text.match(/^(?:列出|list|ls)\s+(skill|mcp|agent|skill|插件|mcp服务|agent)s?$/i);
    if (m) {
      const resource = m[1].toLowerCase();
      const normalized =
        resource.includes('skill') || resource.includes('插件')
          ? 'skills'
          : resource.includes('mcp')
            ? 'mcp'
            : 'agents';
      return { name: `list_${normalized}`, args: {} };
    }

    // Fallback: <cmd> [json]
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = parts.slice(1).join(' ').trim();
    let args: Record<string, unknown> = {};
    if (rest) {
      try {
        const parsed = JSON.parse(rest);
        args = typeof parsed === 'object' && parsed !== null ? parsed : { input: parsed };
      } catch {
        args = { input: rest };
      }
    }
    return { name: cmd, args };
  }
}
