import { once } from 'events';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  chmodSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
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
import { createLocalStory } from '../../src/workspace/Story';

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
const useGitHub = prompt.includes('本轮已授权使用 cpx');
if ((process.env.GH_TOKEN === 'ghp_cpx_fixture_only') !== useGitHub) process.exit(6);
if (process.env.AGENT_GITHUB_TOKEN || process.env.AGENT_WORKSPACE_WEB_TOKEN) process.exit(7);
if (useGitHub) console.error('credential redaction fixture ' + process.env.GH_TOKEN);
const emit = (event) => console.log(JSON.stringify(event));
if (prompt.startsWith('你是 cpx 会话意图分类器')) {
  if (!process.argv.includes('shell_tool') || !process.argv.includes('--ephemeral') || process.env.GH_TOKEN) process.exit(8);
  const {message, candidates} = JSON.parse(prompt.split('\\n').at(-1));
  const items = candidates.filter(candidate => (candidate.title || '').includes('NAS 历史'));
  let intent = {action:'send'};
  if (message === '继续 NAS 历史，检查设置') {
    intent = {action:'clarify', operation:'resume', choices:items.map(x=>x.choice), prompt:'检查设置'};
  } else if (message === '继续浏览器发起的想法，检查日志') {
    intent = {action:'resume', choices:[candidates.find(x=>x.title==='浏览器发起的想法').choice], prompt:'检查日志'};
  } else if (message === '看看进度') {
    intent = {action:'status'};
  } else if (message === '停掉当前任务') {
    intent = {action:'stop'};
  } else if (message === '补齐缺的 GitHub 仓库') {
    intent = {action:'github-clone'};
  } else if (message === '切回刚才的会话') {
    intent = {action:'previous'};
  }
  emit({type:'item.completed', item:{type:'agent_message', text:JSON.stringify(intent)}});
} else {
  const thread = process.argv.find(x => x.startsWith('native-')) || 'native-' + require('crypto').randomUUID();
  const resume = process.argv.includes('resume');
  if (resume && !process.argv.includes(thread)) process.exit(2);
  emit({type:'thread.started', thread_id:thread});
  if (prompt.includes('保持运行用于停止验证')) { setTimeout(() => {}, 30_000); }
  else emit({type:'item.completed', item:{type:'agent_message', text:resume ? '已继续原线程' : '已创建线程'}});
}
`,
  );
  chmodSync(codex, 0o700);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  let system: AgentSystem | undefined;
  try {
    const { root } = await initializeWorkspace(join(fixture, 'workspace'));
    const upstream = join(fixture, 'fixture-repository');
    execFileSync('git', ['init', '-q', '--initial-branch=main', upstream]);
    execFileSync('git', ['-C', upstream, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture', '--allow-empty']);
    writeFileSync(join(root, 'repos.txt'), 'test-project git@github.com:fixture/test-project.git\n');
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(upstream)}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'https://github.com/fixture/test-project.git');
    vi.stubEnv('AGENT_WORKSPACE_CONSOLE_URL', 'http://cpx.example.test:3000');
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
        github: { token: 'ghp_cpx_fixture_only' },
        dingtalk: { enabled: false, clientId: 'ding-fixture' },
        feishu: { enabled: false, appId: 'cli_fixture' },
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
      privateChat: true,
    };
    const feishu = {
      source: 'feishu' as const,
      userId: 'ou-owner',
      userName: 'Feishu',
      replyRouteId: 'oc-chat:ou-owner',
      privateChat: true,
    };
    const browser = await web('run-story', { description: '浏览器发起的想法', useGitHub: true });
    const initial = await system.getWebConsole().getStoryRunner().waitForRun(browser.id);
    expect(initial).toMatchObject({ status: 'completed', response: '已创建线程' });
    expect(initial.logs.join(' ')).toContain('credential redaction fixture [REDACTED]');
    expect(JSON.stringify(initial)).not.toContain('ghp_cpx_fixture_only');
    const id = initial.storyId!;
    expect(readdirSync(join(root, 'story'))).toEqual(['.gitkeep']);

    const unauthorized = await system.processCommand('/sessions', { ...ding, userId: 'guest' });
    expect(unauthorized).toMatchObject({
      success: false,
      message: expect.stringContaining('尚未获准'),
    });
    expect(unauthorized.message).not.toContain(id);
    const dingPair = await web('pair-messaging', { platform: 'dingtalk' });
    expect((await system.processCommand(dingPair.message, { ...ding, privateChat: false })).success).toBe(false);
    expect((await system.processCommand(dingPair.message, feishu)).success).toBe(false);
    expect((await system.processCommand(dingPair.message, ding)).success).toBe(true);
    expect((await system.processCommand(dingPair.message, ding)).success).toBe(false);
    const feishuPair = await web('pair-messaging', { platform: 'feishu' });
    expect((await system.processCommand(feishuPair.message, feishu)).success).toBe(true);
    expect((await web('list-messaging-bindings', {platform:'feishu'})).bindings).toEqual([{userId:feishu.userId,root}]);
    expect((await system.processCommand('查询所有会话', { ...feishu, privateChat: false })).success).toBe(false);

    expect(
      (await post('/command', { text: '/sessions', source: 'dingtalk', userId: ding.userId }))
        .status,
    ).toBe(403);
    expect(await system.processCommand('/whoami', feishu)).toMatchObject({
      success: true,
      message: expect.stringContaining(feishu.userId),
    });
    expect((await system.processCommand('/sessions', ding)).message).toContain(id);
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
    const feishuTurn = await waitForTurn('继续浏览器发起的想法，检查日志', feishu);
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
      '检查日志',
    ]);
    expect(readdirSync(join(root, 'story'))).toEqual(['.gitkeep']);

    const resumed = await web('run-story', { id, description: '浏览器不勾选授权' });
    expect(await system.getWebConsole().getStoryRunner().waitForRun(resumed.id))
      .toMatchObject({ status: 'completed', response: '已继续原线程' });

    const alternate = await waitForTurn('/new 开第二个会话', ding);
    expect(alternate.storyId).not.toBe(id);
    expect(alternate.response).toBe('已创建线程');
    expect((await web('sessions')).sessions).toEqual([
      { id: alternate.storyId, title: '开第二个会话' },
      { id, title: '浏览器发起的想法' },
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
    expect((await waitForTurn('开始第三个会话', ding)).storyId).toMatch(/^session-/);

    const oldStories = [
      await createLocalStory(root, 'NAS 历史甲', 'nas-history-a'),
      await createLocalStory(root, 'NAS 历史乙', 'nas-history-b'),
    ];
    for (const old of oldStories) {
      const started = await web('run-story', { id: old.id, description: '旧会话原始轮次' });
      expect((await system.getWebConsole().getStoryRunner().waitForRun(started.id)).status).toBe('completed');
    }
    const clarification = await system.processCommand('继续 NAS 历史，检查设置', ding);
    expect(clarification.message).toContain('回复编号');
    expect(clarification.data).toBeUndefined();
    const selected = await waitForTurn('第二个', ding);
    expect(selected).toMatchObject({ storyId: oldStories[0].id, description:'检查设置', response:'已继续原线程' });
    expect((await system.processCommand('切回刚才的会话', ding)).success).toBe(true);

    const readyToClone = await system.processCommand('补齐缺的 GitHub 仓库', feishu);
    expect(readyToClone.message).toContain('fixture/test-project');
    expect(existsSync(join(root, 'code/test-project'))).toBe(false);
    expect((await system.processCommand('确认克隆', ding)).message).toContain('没有待确认');
    const cloning = await system.processCommand('确认克隆', feishu);
    expect(cloning.data).toHaveProperty('runId');
    await vi.waitFor(() => expect(existsSync(join(root, 'code/test-project/.git'))).toBe(true), {timeout:3000});

    const received = { ...feishu, platformMessageId: 'duplicate-event' };
    const active = await system.processCommand('保持运行用于停止验证', received);
    expect(active.data).toHaveProperty('runId');
    const duplicate = await system.processCommand('保持运行用于停止验证', received);
    expect(duplicate.data).toEqual({suppressReply:true});
    expect((await system.processCommand('看看进度', feishu)).message).toContain('正在执行');
    expect((await system.processCommand('停掉当前任务', feishu)).message).toContain('已停止');
    await system.getWebConsole().getStoryRunner().waitForRun((active.data as {runId:string}).runId);
    await web('revoke-messaging-binding', {platform:'feishu',userId:feishu.userId});
    expect((await system.processCommand('查询所有会话', feishu)).message).toContain('已撤销');

  } finally {
    await system?.stop();
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15000);
