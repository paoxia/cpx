import { randomUUID } from 'crypto';
import { basename } from 'path';
import type { Command, CommandResult } from '../core/types';
import type { StoryRunner } from '../workspace/StoryRunner';
import { terminalStatuses } from '../workspace/WorkspaceSessions';
import type { WorkspaceCloneTarget } from '../workspace/WorkspaceGitHubProjects';
import {
  interpretWorkspaceIntent, sessionCandidates, SessionCandidate, WorkspaceIntentModel,
} from './WorkspaceSessionIntent';

const pageSize = 8;
const selectionLifetime = 5 * 60_000;
const statuses = {
  queued: '等待执行', naming: '正在命名', creating: '正在创建', running: '正在执行',
  completed: '已完成', failed: '执行失败', cancelled: '已停止',
};

interface WorkspaceMessageServices {
  interpret?: WorkspaceIntentModel;
  missingGitHubProjects?: (root: string) => Promise<WorkspaceCloneTarget[] | undefined>;
  cloneGitHubProjects?: (root: string, targets: WorkspaceCloneTarget[]) => Promise<string>;
  sessionLink?: (root: string, id: string) => string | undefined;
}

type Choice = {
  kind: 'session'; sessions: SessionCandidate[]; prompt: string; action: 'resume' | 'switch';
} | { kind: 'clone'; targets: WorkspaceCloneTarget[] };

export class WorkspaceSessionMessages {
  private readonly pending = new Map<string, { choice: Choice; expiresAt: number }>();
  private readonly routing = new Set<string>();
  private readonly cloneJobs = new Map<string, Promise<CommandResult>>();
  private readonly cloningRoots = new Set<string>();

  constructor(private readonly runner: StoryRunner, private readonly services: WorkspaceMessageServices = {}) {}

  async handle(
    command: Command, root: string | undefined, allowedUsers: string[], stillAuthorized = () => true,
  ): Promise<CommandResult> {
    const { id: commandId, source, userId, replyRouteId, args } = command;
    const reply = (message: string, success = true): CommandResult => ({ commandId, success, message });
    if ((source !== 'dingtalk' && source !== 'feishu') || !replyRouteId) {
      return reply('请在钉钉或飞书机器人会话里使用这个命令。', false);
    }
    if (args.action === 'identity') return reply(`你的机器人用户 ID：${userId}`);
    if (!root || !allowedUsers.includes(userId)) {
      return reply('请先在 cpx「消息平台」绑定工作区，然后在机器人私聊完成绑定。', false);
    }

    const routeKey = JSON.stringify([source, userId, replyRouteId]);
    const pendingKey = JSON.stringify([root, routeKey]);
    if (this.routing.has(pendingKey)) return reply('上一条消息还在确认目标，请稍等。', false);
    this.routing.add(pendingKey);
    try {
      let action = String(args.action);
      let storyId = typeof args.id === 'string' ? args.id : undefined;
      let prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (prompt.length > 20_000) return reply('单条消息最多 20,000 字。', false);
      const { sessions, current, previous } = await this.runner.listMessagingSessions(root, routeKey);
      if (!stillAuthorized()) return reply('工作区授权已变化，请重新发送。', false);
      const pending = this.pending.get(pendingKey);
      this.pending.delete(pendingKey);

      if (action === 'send' && pending && pending.expiresAt > Date.now()) {
        if (/^(?:取消|算了|不用了)[。！!]?$/u.test(prompt)) return reply('已取消上次选择。');
        if (pending.choice.kind === 'clone' && /^(?:确认|确认克隆)[。！!]?$/u.test(prompt)) {
          if (!this.services.cloneGitHubProjects) return reply('GitHub 克隆服务未配置。', false);
          if (this.cloningRoots.has(root)) return reply('这个工作区正在克隆项目，请稍等。', false);
          const jobId = randomUUID();
          this.cloningRoots.add(root);
          const clone = this.services.cloneGitHubProjects;
          const { targets } = pending.choice;
          const work = this.runner.runMaintenance(root, () => {
            if (!stillAuthorized()) throw new Error('工作区授权已变化，请重新发送。');
            return clone(root, targets);
          });
          this.cloneJobs.set(jobId, work
            .then(message => reply(message))
            .catch(error => reply(error instanceof Error ? error.message : '克隆未完成。', false))
            .finally(() => { this.cloningRoots.delete(root); }));
          return { ...reply('已开始克隆确认的项目，完成后会在这里回复。'), data: { runId: jobId } };
        }
        if (pending.choice.kind === 'session') {
          const index = pickSession(prompt, pending.choice.sessions);
          if (index !== undefined) {
            action = pending.choice.action;
            storyId = pending.choice.sessions[index].id;
            prompt = pending.choice.prompt;
          }
        }
      } else if (action === 'send' && /^(?:确认克隆|确认|取消)[。！!]?$/u.test(prompt)) {
        return reply('当前没有待确认的操作。');
      }

      if (action === 'send' && this.services.interpret) {
        const candidates = sessionCandidates(prompt, sessions, current);
        const intent = await interpretWorkspaceIntent(this.services.interpret, prompt, candidates, current)
          .catch(() => undefined);
        if (!stillAuthorized()) return reply('工作区授权已变化，请重新发送。', false);
        if (!intent) return reply('暂时无法判断你的操作。请重试，或用 /sessions 查看会话。', false);
        action = intent.action;
        const selection = [...new Set(intent.choices ?? [])].map(index => candidates[index - 1]);
        const original = prompt;
        const extracted = intent.prompt?.trim();
        if (action === 'new' || action === 'resume' || action === 'clarify') {
          prompt = extracted && original.includes(extracted) ? extracted : '';
        }
        if (['resume', 'switch', 'clarify'].includes(action)) {
          if (selection.length === 1 && action !== 'clarify') storyId = selection[0].id;
          else {
            const choices = (selection.length ? selection : candidates).slice(0, 3);
            if (!choices.length) return reply('还没有可续接的会话。你可以说想新开一个会话做什么。');
            this.remember(pendingKey, { kind: 'session', sessions: choices, prompt,
              action: action === 'switch' || intent.operation === 'switch' ? 'switch' : 'resume' });
            return reply(['你想打开哪一个会话？', ...choices.map((session, index) =>
              `${index + 1}. ${session.title ?? '未命名会话'}${session.updatedAt ? `（${formatDate(session.updatedAt)}）` : ''}`),
              '回复编号或会话标题即可。'].join('\n'));
          }
        }
      }

      if (action === 'previous') {
        if (!previous) return reply('这个聊天还没有上一条会话。', false);
        storyId = previous;
        prompt = '';
        action = 'switch';
      }

      switch (action) {
        case 'list': {
          const page = args.page === undefined ? 1 : Number(args.page);
          if (!Number.isSafeInteger(page) || page < 1) return reply('请提供正确的页码。', false);
          if (!sessions.length) return reply('这个工作区还没有会话。你可以直接发一条需求来开始。');
          const pages = Math.ceil(sessions.length / pageSize);
          if (page > pages) return reply(`共有 ${pages} 页。`, false);
          const rows = sessions.slice((page - 1) * pageSize, page * pageSize).map(({ id, title }) =>
            `• ${title?.slice(0, 80) ?? id}${id === current ? '（当前）' : ''}${args.page || command.rawText.startsWith('/sessions') ? `\n  ${id}` : ''}`);
          return reply([`工作区会话（${page}/${pages} 页）`, ...rows, '说「继续」加会话标题即可打开。'].join('\n'));
        }
        case 'current':
          return reply(`工作区：${basename(root)}\n当前会话：${sessions.find(item => item.id === current)?.title ?? '尚未选择'}`);
        case 'history':
        case 'status':
        case 'stop': {
          if (!current) return reply('当前聊天还没有选中会话。你可以先说「查看会话」。', false);
          const { title, run } = await this.runner.messagingRun(root, current, action === 'stop');
          if (!run) return reply('当前会话还没有运行记录。');
          const detail = action === 'history' || run.status === 'failed' ? run.response || run.error || '' : '';
          return reply(this.formatResult(root, current, `${title ?? '当前会话'}：${statuses[run.status]}${detail ? `\n\n${detail}` : ''}`));
        }
        case 'switch':
        case 'resume':
          if (!storyId) return reply('请告诉我想打开哪条会话，可以直接说标题。', false);
          if (!prompt || action !== 'resume') {
            const session = await this.runner.selectMessagingSession(root, routeKey, storyId);
            return reply(this.formatResult(root, storyId, `已切换到「${session?.title ?? storyId}」。下一条消息会继续这个会话。`));
          }
          break;
        case 'new':
          if (!prompt) {
            await this.runner.selectMessagingSession(root, routeKey);
            return reply('下一条消息将开启新会话。');
          }
          break;
        case 'github-clone': {
          const targets = await this.services.missingGitHubProjects?.(root);
          if (!stillAuthorized()) return reply('工作区授权已变化，请重新发送。', false);
          if (!targets) return reply('请先在 cpx 的 GitHub 页面连接账号。', false);
          if (!targets.length) return reply('这个工作区没有待克隆的 GitHub 清单项目。');
          if (targets.length > 30) return reply('待克隆项目超过 30 个，请在 cpx 工作区检查清单后分批处理。', false);
          this.remember(pendingKey, { kind: 'clone', targets });
          return reply(['将把以下仓库克隆到当前工作区的 code/：',
            ...targets.map(({ name, repository }) => `• ${name} ← ${repository}`),
            '回复「确认克隆」开始，或回复「取消」。'].join('\n'));
        }
        case 'github-publish':
          return reply('推送或创建 PR 请在 cpx 网页核对仓库和分支后发起。', false);
        case 'send':
          break;
        default:
          return reply('暂时无法识别这条操作，请换一种说法。', false);
      }

      if (!prompt) return reply('请告诉我这轮要做什么。', false);
      const active = await this.runner.latest(root);
      if (active && !terminalStatuses.has(active.status)) {
        const title = sessions.find(item => item.id === active.storyId)?.title ?? '另一条会话';
        return reply(`「${title}」正在执行。可以查看当前会话进度，或等这一轮结束再发送。`, false);
      }
      if (!stillAuthorized()) return reply('工作区授权已变化，请重新发送。', false);
      const run = await this.runner.start(root, prompt, storyId, { messaging: { routeKey, startNew: action === 'new' } });
      return { ...reply(`已提交「${run.session?.title ?? '会话'}」，完成后会在这里回复。`), data: { runId: run.id } };
    } finally {
      this.routing.delete(pendingKey);
    }
  }

  private remember(key: string, choice: Choice): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(id);
    if (this.pending.size >= 256) {
      const first = this.pending.keys().next().value;
      if (first) this.pending.delete(first);
    }
    this.pending.set(key, { choice, expiresAt: now + selectionLifetime });
  }

  async result(commandId: string, runId: string): Promise<CommandResult> {
    const job = this.cloneJobs.get(runId);
    if (job) {
      try { return await job; } finally { this.cloneJobs.delete(runId); }
    }
    const run = await this.runner.waitForRun(runId);
    const message = run.status === 'completed' ? run.response || 'Codex 已完成本轮。'
      : run.status === 'cancelled' ? '本轮已停止。' : run.error || 'Codex 本轮执行失败。';
    return { commandId, success: run.status === 'completed',
      message: this.formatResult(run.path, run.storyId, message) };
  }

  private formatResult(root: string, storyId: string | undefined, message: string): string {
    const link = storyId && this.services.sessionLink?.(root, storyId);
    if (/(?:no (?:session|conversation|rollout) found|thread .+ not found|找不到.*线程)/i.test(message)) {
      message = '原 Codex 线程暂时无法续接，原会话和历史仍可查看。可以另开会话，并引用这条会话里需要保留的上下文。';
    }
    const body = message.length <= 1000 ? message : `${message.slice(0, 1000)}…\n\n完整内容请在 cpx 会话中查看。`;
    return link ? `${body}\n\n${link}` : body;
  }
}

function pickSession(message: string, sessions: SessionCandidate[]): number | undefined {
  const trimmed = message.trim().replace(/[。！!]+$/u, '');
  const numeric = trimmed.match(/^(?:第\s*)?([123一二三])(?:\s*[个条])?$/u)?.[1];
  if (numeric) {
    const index = '一二三'.includes(numeric) ? '一二三'.indexOf(numeric) : Number(numeric) - 1;
    return index < sessions.length ? index : undefined;
  }
  const matches = sessions.flatMap((session, index) => session.title === trimmed ? [index] : []);
  return matches.length === 1 ? matches[0] : undefined;
}

function formatDate(time: number): string {
  return new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
