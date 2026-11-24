import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Logger } from '../../../src/utils/Logger';
import { createLocalStory } from '../../../src/workspace/Story';
import { StoryRunner } from '../../../src/workspace/StoryRunner';
import { listWorkspaceDirectory } from '../../../src/workspace/WorkspaceTree';
import { initializeWorkspace } from '../../../src/workspace/Workspace';

let temporary: string;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'cpx-story-runner-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temporary, { recursive: true, force: true });
});

it('服务重启后恢复同一 Codex 线程和消息，补充消息独立于 Story 说明', async () => {
  const bin = join(temporary, 'bin');
  mkdirSync(bin);
  const codex = join(bin, 'codex');
  writeFileSync(
    codex,
    `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
const emit = (event) => console.log(JSON.stringify(event));
if (prompt.includes('负责为一个 digital-avatar Story 起名')) {
  emit({type:'item.completed', item:{type:'agent_message', text:'{"name":"build-notes","title":"修改笔记"}'}});
} else {
  const resume = process.argv.includes('resume');
  if (resume && !process.argv.includes('test-codex-thread')) process.exit(2);
  emit({type:'thread.started', thread_id:'test-codex-thread'});
  fs.writeFileSync('fixture.txt', resume ? 'continued' : 'started');
  emit({type:'item.completed', item:{type:'agent_message', text:resume ? '完成第二轮' : '完成第一轮'}});
}
`,
  );
  chmodSync(codex, 0o700);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  const { root } = await initializeWorkspace(join(temporary, 'workspace'));
  const startRunner = (runtime: string) =>
    new StoryRunner(join(temporary, runtime), new Logger('error'), () => [
      { id: 'default', provider: 'codex' },
    ]);
  let runner = startRunner('runtime');

  try {
    const historical = await createLocalStory(root, '仅有说明的历史需求', 'old-story');
    expect(await runner.listSessions(root)).toEqual([]);
    expect(await listWorkspaceDirectory(root, `story/${historical.id}`)).toEqual([
      { name: '说明.md', type: 'file', storyId: historical.id },
    ]);
    const first = await runner.start(root, '请修改笔记', historical.id);
    await vi.waitFor(() => expect(runner.get(first.id).status).toBe('completed'), {
      timeout: 4000,
    });
    const original = runner.get(first.id);
    expect(original.story?.id).toBe(historical.id);
    expect(original.story?.content).toContain('仅有说明的历史需求');
    expect(original.story?.content).not.toContain('完成第一轮');
    const directory = original.story!.directory;
    const storyFile = join(directory, '说明.md');
    const initialDocument = readFileSync(storyFile);
    expect(readFileSync(join(directory, 'fixture.txt'), 'utf8')).toBe('started');

    await runner.stop();
    runner = startRunner('another-runtime');
    expect(await runner.listSessions(root)).toEqual([{ id: original.storyId, title: '仅有说明的历史需求' }]);
    expect(await runner.getForWorkspace(root, first.id)).toMatchObject({ status: 'completed' });
    expect((await runner.latest(root, original.storyId))?.turns).toMatchObject([
      { description: '请修改笔记', response: '完成第一轮' },
    ]);
    const next = await runner.start(root, '请补充检查', original.storyId);
    await vi.waitFor(() => expect(runner.get(next.id).status).toBe('completed'), { timeout: 4000 });
    const continued = runner.get(next.id);
    expect(continued.turns).toMatchObject([
      { description: '请修改笔记', response: '完成第一轮' },
      { description: '请补充检查', response: '完成第二轮' },
    ]);
    expect(readFileSync(storyFile)).toEqual(initialDocument);
    expect(readFileSync(join(directory, 'fixture.txt'), 'utf8')).toBe('continued');

    rmSync(storyFile);
    const third = await runner.start(root, '继续检查', original.storyId);
    await vi.waitFor(() => expect(runner.get(third.id).status).toBe('completed'), {
      timeout: 4000,
    });
    expect(runner.get(third.id).turns).toHaveLength(3);
    expect(() => readFileSync(storyFile)).toThrow(/ENOENT/);
  } finally {
    await runner.stop();
  }
}, 10000);

it('列出代码、需求、归档和根目录文件并限制目录穿越', async () => {
  const { root } = await initializeWorkspace(join(temporary, 'workspace'));
  const entries = await listWorkspaceDirectory(root, '');
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'code', type: 'directory' }),
      expect.objectContaining({ name: 'story', type: 'directory' }),
      expect.objectContaining({ name: 'archive', type: 'directory' }),
      { name: 'README.md', type: 'file' },
    ]),
  );
  expect(entries.some(({ name }) => name === '.git')).toBe(false);
  await expect(listWorkspaceDirectory(root, '../runtime')).rejects.toThrow('目录无效');
});

it('新会话仅存数据库，重启和跨轮续接不创建 Story，明确要求时交给 Codex 创建', async () => {
  const bin = join(temporary, 'bin');
  mkdirSync(bin);
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!/usr/bin/env node
const fs = require('fs');
const prompt = fs.readFileSync(0, 'utf8');
if (prompt.includes('负责为一个 digital-avatar Story 起名')) process.exit(9);
if (!prompt.includes('默认不创建 Story')) process.exit(8);
if (prompt.includes('请为这次任务创建 Story')) {
 fs.mkdirSync('story/2026-11-24-explicit', {recursive:true});
 fs.writeFileSync('story/2026-11-24-explicit/说明.md', '# Explicit');
}
console.log(JSON.stringify({type:'thread.started',thread_id:'new-session-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'完成'}}));
`);
  chmodSync(codex, 0o700);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  const { root } = await initializeWorkspace(join(temporary, 'workspace'));
  rmSync(join(root, 'story'), { recursive: true });
  const start = () => new StoryRunner(join(temporary, 'runtime'), new Logger('error'), () => [{id:'default',provider:'codex'}]);
  let runner = start();
  try {
    const first = await runner.start(root, '只修改代码');
    const completed = await runner.waitForRun(first.id);
    expect(completed).toMatchObject({status:'completed',session:{id:first.storyId,title:'只修改代码'}});
    expect(completed.story).toBeUndefined();
    expect(existsSync(join(root, 'story'))).toBe(false);
    await runner.stop();
    runner = start();
    expect(await runner.listSessions(root)).toEqual([{id:first.storyId,title:'只修改代码'}]);
    expect(await runner.session(root, first.storyId!)).toEqual({id:first.storyId,title:'只修改代码'});
    const next = await runner.start(root, '继续处理', first.storyId);
    expect((await runner.waitForRun(next.id)).turns).toHaveLength(2);
    expect(existsSync(join(root, 'story'))).toBe(false);
    const explicit = await runner.start(root, '请为这次任务创建 Story', first.storyId);
    expect((await runner.waitForRun(explicit.id)).status).toBe('completed');
    expect(readFileSync(join(root, 'story/2026-11-24-explicit/说明.md'),'utf8')).toBe('# Explicit');
    const reopened = await runner.latest(root, first.storyId);
    expect(reopened?.turns).toHaveLength(3);
    await expect(runner.session(root, 'session-does-not-exist')).rejects.toThrow();
  } finally { await runner.stop(); }
});
