import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexConfigManager } from '../../../src/web/CodexConfigManager';

const TMP_DIR = join(process.cwd(), 'tmp-test-codex-config');

describe('CodexConfigManager', () => {
  beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
  afterEach(() => rmSync(TMP_DIR, { recursive: true, force: true }));

  it('配置文件不存在时返回适合后台任务的安全默认值', () => {
    expect(new CodexConfigManager(TMP_DIR).getConfig()).toEqual({
      modelReasoningEffort: 'high',
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      webSearch: 'cached',
    });
  });

  it('只更新页面管理的顶层配置并保留其他 TOML 段落', () => {
    const path = join(TMP_DIR, 'config.toml');
    writeFileSync(
      path,
      '# keep this comment\nmodel = "old-model"\napproval_policy = "on-request"\n\n[features]\nmulti_agent = true\n',
    );
    const manager = new CodexConfigManager(TMP_DIR);

    expect(
      manager.saveConfig({
        model: 'gpt-5.2-codex',
        modelReasoningEffort: 'xhigh',
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        webSearch: 'live',
      }),
    ).toMatchObject({ model: 'gpt-5.2-codex', webSearch: 'live' });

    const stored = readFileSync(path, 'utf8');
    expect(stored).toContain('# keep this comment');
    expect(stored).toContain('model = "gpt-5.2-codex"');
    expect(stored).toContain('model_reasoning_effort = "xhigh"');
    expect(stored).toContain('approval_policy = "never"');
    expect(stored).toContain('sandbox_mode = "workspace-write"');
    expect(stored).toContain('web_search = "live"');
    expect(stored).toContain('[features]\nmulti_agent = true');
    expect(manager.getConfig()).toMatchObject({
      model: 'gpt-5.2-codex',
      modelReasoningEffort: 'xhigh',
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      webSearch: 'live',
    });
  });

  it('拒绝无效枚举和可注入 TOML 的模型名', () => {
    const manager = new CodexConfigManager(TMP_DIR);
    expect(() =>
      manager.saveConfig({
        model: 'model"\napproval_policy="never',
        modelReasoningEffort: 'high',
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        webSearch: 'cached',
      }),
    ).toThrow('模型名称');
    expect(() =>
      manager.saveConfig({
        modelReasoningEffort: 'high',
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        webSearch: 'unknown' as 'cached',
      }),
    ).toThrow('网页搜索');
  });
});
