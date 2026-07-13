import { randomUUID } from 'crypto';
import type { Command, CommandSource } from './types';
import { CommandError } from '../utils/errors';

export interface ParsedUserInfo {
  userId: string;
  userName: string;
  source: CommandSource;
}

/**
 * 命令解析器：将原始消息文本解析为 Command 对象
 *
 * 支持的命令格式：
 * - @agent 修改 <file> <description>   -> github_modify
 * - @agent 新建文件 <file> <description> -> github_create
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

    // 确认 <id>
    let m = text.match(/^(?:确认|confirm)\s+(cf_[a-f0-9]+)$/i);
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
      const normalized = resource.includes('skill') || resource.includes('插件')
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
