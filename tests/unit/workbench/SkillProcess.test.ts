import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillLoader } from '../../../src/skills/SkillLoader';
import { SkillManager } from '../../../src/skills/SkillManager';
import { DatabaseService } from '../../../src/storage/Database';
import { Logger } from '../../../src/utils/Logger';
import { InstanceLock } from '../../../src/workbench/InstanceLock';

describe('supervised Skill execution and instance ownership', () => {
  let root: string;
  let db: DatabaseService;
  let manager: SkillManager;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cpx-skill-'));
    db = new DatabaseService(join(root, 'agent.db'), new Logger('error'));
    db.prepare(
      'INSERT INTO skills(name,version,entry,permissions,source,path,installed_at) VALUES(?,?,?,?,?,?,?)',
    ).run('demo', '1', 'index.js', '{}', 'local', root, Date.now());
    manager = new SkillManager(
      new SkillLoader(root, db, new Logger('error')),
      new Logger('error'),
      1500,
    );
  });
  afterEach(() => {
    manager.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  it('runs code outside the main process and excludes inherited secrets', async () => {
    writeFileSync(
      join(root, 'index.js'),
      'exports.execute=async ctx=>({success:true,message:String(process.pid),data:{echo:ctx.args.echo,secret:process.env.CPX_TEST_SECRET}})',
    );
    process.env.CPX_TEST_SECRET = 'never-inherit';
    try {
      const result = await manager.execute('demo', { echo: 'hello' }, 'cmd');
      expect(result.message).not.toBe(String(process.pid));
      expect(result.data).toEqual({ echo: 'hello' });
    } finally {
      delete process.env.CPX_TEST_SECRET;
    }
  });
  it('kills a hung Skill on timeout and survives a Skill process exit', async () => {
    writeFileSync(join(root, 'index.js'), 'exports.execute=async()=>{while(true){}}');
    await expect(manager.execute('demo', {}, 'cmd')).rejects.toThrow('超时');
    writeFileSync(join(root, 'index.js'), 'process.exit(2)');
    await expect(manager.execute('demo', {}, 'cmd')).rejects.toThrow('提前退出');
  });
  it('refuses a second controller and only removes its own instance lock', () => {
    const first = new InstanceLock(root);
    try {
      expect(() => new InstanceLock(root)).toThrow('已有实例锁');
      first.assert();
    } finally {
      first.release();
    }
    const next = new InstanceLock(root);
    next.assert();
    next.release();
  });
});
