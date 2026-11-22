import { once } from 'events';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { expect, it, vi } from 'vitest';
import { AgentSystem } from '../../src/core/AgentSystem';
import { initializeWorkspace } from '../../src/workspace/Workspace';

it('在网页、钉钉和飞书之间共享 Codex 线程，分别保留当前会话', async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cpx-workspace-messaging-')));
  const bin = join(fixture, 'bin');
  const config = join(fixture, 'config');
  mkdirSync(bin);
  mkdirSync(config);
  const codex = join(bin, 'codex');
  writeFileSync(
    codex,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const prompt = fs.readFileSync(0, 'utf8');
const emit = (event) => console.log(JSON.stringify(event));
if (prompt.includes('负责为一个 digital-avatar Story 起名')) {
  emit({type:'item.completed', item:{type:'agent_message', text:'{"name":"shared-session","title":"跨端会话"}'}});
} else {
  const thread = 'native-' + path.basename(process.cwd());
  const resume = process.argv.includes('resume');
  if (resume && !process.argv.includes(thread)) process.exit(2);
  emit({type:'thread.started', thread_id:thread});
  emit({type:'item.completed', item:{type:'agent_message', text:resume ? '已继续原线程' : '已创建线程'}});
}
`,
  );
  chmodSync(codex, 0o700);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  let system: AgentSystem | undefined;
  try {
    const { root } = await initializeWorkspace(join(fixture, 'workspace'));
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Could not allocate test port');
    const { port } = address;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    writeFileSync(
      join(config, 'config.yaml'),
      JSON.stringify({
        server: { host: '127.0.0.1', port },
        storage: { path: join(fixture, 'agent.db') },
        logging: { level: 'error' },
        messagingWorkspaceRoot: root,
        dingtalk: { enabled: false, workspaceUsers: ['ding-owner'] },
        feishu: { enabled: false, workspaceUsers: ['ou-owner'] },
      }),
    );
    system = new AgentSystem(config);
    await system.start();
    const push = vi.fn(async () => {});
    system.setResultPusher(push);
    const base = `http://127.0.0.1:${port}`;
    const post = (endpoint: string, payload: object) =>
      fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    const web = async (operation: string, data: object = {}) => {
      const response = await post('/api/console/workspace', { operation, path: root, ...data });
      expect(response.ok).toBe(true);
      return response.json();
    };
    const ding = {
      source: 'dingtalk' as const,
      userId: 'ding-owner',
      userName: 'Ding',
      replyRouteId: 'ding-chat:ding-owner',
    };
    const feishu = {
      source: 'feishu' as const,
      userId: 'ou-owner',
      userName: 'Feishu',
      replyRouteId: 'oc-chat:ou-owner',
    };
    const browser = await web('run-story', { description: '浏览器发起的想法' });
    const initial = await system.getWebConsole().getStoryRunner().waitForRun(browser.id);
    expect(initial).toMatchObject({ status: 'completed', response: '已创建线程' });
    const id = initial.storyId!;
    const file = join(root, 'story', id, '说明.md');
    const document = readFileSync(file, 'utf8');

    const unauthorized = await system.processCommand('/sessions', { ...ding, userId: 'guest' });
    expect(unauthorized).toMatchObject({
      success: false,
      message: expect.stringContaining('尚未获准'),
    });
    expect(unauthorized.message).not.toContain(id);
    expect(
      (await post('/command', { text: '/sessions', source: 'dingtalk', userId: ding.userId }))
        .status,
    ).toBe(403);
    expect(await system.processCommand('/whoami', feishu)).toMatchObject({
      success: true,
      message: expect.stringContaining(feishu.userId),
    });
    expect((await system.processCommand('查询所有会话', ding)).message).toContain(id);
    expect((await system.processCommand('/switch ' + id, ding)).success).toBe(true);
    expect(await web('latest-story-run', { id, knownRunId: initial.id })).toBeNull();

    const waitForTurn = async (message: string, origin: typeof ding | typeof feishu) => {
      const accepted = await system!.processCommand(message, origin);
      expect(accepted.success, accepted.message).toBe(true);
      const runId = (accepted.data as { runId: string }).runId;
      const outcome = await system!.getWebConsole().getStoryRunner().waitForRun(runId);
      expect(outcome.status, outcome.error).toBe('completed');
      return outcome;
    };
    const dingTurn = await waitForTurn('来自钉钉的普通消息', ding);
    expect(dingTurn).toMatchObject({ storyId: id, response: '已继续原线程' });
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        'dingtalk',
        ding.userId,
        expect.objectContaining({
          markdown: expect.objectContaining({ text: expect.stringContaining('已继续原线程') }),
        }),
        ding.replyRouteId,
      ),
    );
    const feishuTurn = await waitForTurn(`/resume ${id} 来自飞书的普通消息`, feishu);
    expect(feishuTurn).toMatchObject({ storyId: id, response: '已继续原线程' });
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        'feishu',
        feishu.userId,
        expect.objectContaining({ content: { text: expect.stringContaining('已继续原线程') } }),
        feishu.replyRouteId,
      ),
    );
    const latest = await web('latest-story-run', { id, knownRunId: initial.id });
    expect(latest.turns.map((turn: { description: string }) => turn.description)).toEqual([
      '浏览器发起的想法',
      '来自钉钉的普通消息',
      '来自飞书的普通消息',
    ]);
    expect(readFileSync(file, 'utf8')).toBe(document);

    const alternate = await waitForTurn('/new 开第二个会话', ding);
    expect(alternate.storyId).not.toBe(id);
    expect(alternate.response).toBe('已创建线程');
    expect((await web('sessions')).sessions).toEqual([
      { id: alternate.storyId, title: '跨端会话' },
      { id, title: '跨端会话' },
    ]);

    await system.stop();
    system = new AgentSystem(config);
    await system.start();
    system.setResultPusher(push);
    expect((await waitForTurn('重启后继续，使用钉钉选中的会话', ding)).storyId).toBe(
      alternate.storyId,
    );
    expect((await waitForTurn('飞书仍在第一个会话', feishu)).storyId).toBe(id);
    expect((await system.processCommand('/new', ding)).message).toContain('下一条');
    expect((await waitForTurn('开始第三个会话', ding)).storyId).toMatch(/-shared-session-3$/);
  } finally {
    await system?.stop();
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15000);
