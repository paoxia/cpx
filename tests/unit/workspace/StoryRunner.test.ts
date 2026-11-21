import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
    const first = await runner.start(root, '请修改笔记');
    expect(first.status).toBe('naming');
    await vi.waitFor(() => expect(runner.get(first.id).status).toBe('completed'), {
      timeout: 4000,
    });
    const original = runner.get(first.id);
    expect(original.story?.id).toMatch(/-build-notes$/);
    expect(original.story?.content).toContain('# 修改笔记');
    expect(original.story?.content).toContain('请修改笔记');
    expect(original.story?.content).not.toContain('完成第一轮');
    const directory = original.story!.directory;
    const storyFile = join(directory, '说明.md');
    const initialDocument = readFileSync(storyFile);
    expect(readFileSync(join(directory, 'fixture.txt'), 'utf8')).toBe('started');

    await runner.stop();
    runner = startRunner('another-runtime');
    expect(await runner.listSessions(root)).toEqual([{ id: original.storyId, title: '修改笔记' }]);
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
