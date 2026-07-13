import type { CommandResult, CommandSource } from './types';

export interface FormattedMessage {
  msgtype: string;
  [key: string]: unknown;
}

/**
 * 响应格式化器：将 CommandResult 转换为各平台消息格式
 */
export class ResponseFormatter {
  format(result: CommandResult, source: CommandSource): FormattedMessage {
    switch (source) {
      case 'dingtalk':
        return this.formatDingTalk(result);
      case 'feishu':
        return this.formatFeishu(result);
      case 'cli':
        return this.formatCli(result);
    }
  }

  /** 钉钉 markdown 消息 */
  private formatDingTalk(result: CommandResult): FormattedMessage {
    const icon = result.success ? '✅' : '❌';
    let text = `${icon} ${result.message}`;
    if (result.prUrl) {
      text += `\n\n**PR 链接**: [${result.prUrl}](${result.prUrl})`;
    }
    if (result.needsConfirmation && result.confirmationId) {
      text = `⚠️ 危险操作确认\n\n${result.message}\n\n回复 \`@agent 确认 ${result.confirmationId}\` 以继续，或 \`@agent 取消 ${result.confirmationId}\` 取消`;
    }
    return {
      msgtype: 'markdown',
      markdown: {
        title: `Agent 结果`,
        text,
      },
    };
  }

  /** 飞书富文本消息 */
  private formatFeishu(result: CommandResult): FormattedMessage {
    const icon = result.success ? '✅' : '❌';
    let text = `${icon} ${result.message}`;
    if (result.prUrl) {
      text += `\n\nPR 链接: ${result.prUrl}`;
    }
    if (result.needsConfirmation && result.confirmationId) {
      text = `⚠️ 危险操作确认\n\n${result.message}\n\n回复 @agent 确认 ${result.confirmationId} 以继续，或 @agent 取消 ${result.confirmationId} 取消`;
    }
    return {
      msgtype: 'text',
      content: {
        text,
      },
    };
  }

  /** CLI 纯文本 */
  private formatCli(result: CommandResult): FormattedMessage {
    let text = result.message;
    if (result.prUrl) {
      text += `\nPR: ${result.prUrl}`;
    }
    if (result.data !== undefined) {
      text += `\n${JSON.stringify(result.data, null, 2)}`;
    }
    return { msgtype: 'text', text };
  }

  /** 构造错误结果 */
  static error(commandId: string, message: string, source: CommandSource): { result: CommandResult; source: CommandSource } {
    return {
      result: {
        commandId,
        success: false,
        message,
      },
      source,
    };
  }

  /** 构造成功结果 */
  static success(commandId: string, message: string, extra?: Partial<CommandResult>): CommandResult {
    return {
      commandId,
      success: true,
      message,
      ...extra,
    };
  }
}
