import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export interface CodexRuntimeConfiguration {
  model?: string;
  modelReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  approvalPolicy: 'untrusted' | 'on-request' | 'never';
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  webSearch: 'cached' | 'indexed' | 'live' | 'disabled';
}

const DEFAULT_CONFIG: CodexRuntimeConfiguration = {
  model: undefined,
  modelReasoningEffort: 'high',
  approvalPolicy: 'never',
  sandboxMode: 'workspace-write',
  webSearch: 'cached',
};

const CONFIG_KEYS = {
  model: 'model',
  modelReasoningEffort: 'model_reasoning_effort',
  approvalPolicy: 'approval_policy',
  sandboxMode: 'sandbox_mode',
  webSearch: 'web_search',
} as const;

/** 只维护 cpx 页面暴露的 Codex 顶层设置，保留 config.toml 中其余配置和注释。 */
export class CodexConfigManager {
  private readonly codexHome: string;
  private readonly configPath: string;

  constructor(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')) {
    this.codexHome = resolve(codexHome);
    this.configPath = join(this.codexHome, 'config.toml');
  }

  getConfig(): CodexRuntimeConfiguration {
    if (!existsSync(this.configPath)) return { ...DEFAULT_CONFIG };
    const preamble = topLevelPreamble(readFileSync(this.configPath, 'utf8'));
    return validateConfiguration({
      model: readTomlString(preamble, CONFIG_KEYS.model),
      modelReasoningEffort:
        readTomlString(preamble, CONFIG_KEYS.modelReasoningEffort) ??
        DEFAULT_CONFIG.modelReasoningEffort,
      approvalPolicy:
        readTomlString(preamble, CONFIG_KEYS.approvalPolicy) ?? DEFAULT_CONFIG.approvalPolicy,
      sandboxMode:
        readTomlString(preamble, CONFIG_KEYS.sandboxMode) ?? DEFAULT_CONFIG.sandboxMode,
      webSearch: readTomlString(preamble, CONFIG_KEYS.webSearch) ?? DEFAULT_CONFIG.webSearch,
    });
  }

  saveConfig(value: CodexRuntimeConfiguration): CodexRuntimeConfiguration {
    const next = validateConfiguration(value);
    const current = existsSync(this.configPath) ? readFileSync(this.configPath, 'utf8') : '';
    const firstTable = current.search(/^\s*\[/m);
    let preamble = firstTable === -1 ? current : current.slice(0, firstTable);
    const remainder = firstTable === -1 ? '' : current.slice(firstTable);

    preamble = updateTopLevelString(preamble, CONFIG_KEYS.model, next.model);
    preamble = updateTopLevelString(
      preamble,
      CONFIG_KEYS.modelReasoningEffort,
      next.modelReasoningEffort,
    );
    preamble = updateTopLevelString(preamble, CONFIG_KEYS.approvalPolicy, next.approvalPolicy);
    preamble = updateTopLevelString(preamble, CONFIG_KEYS.sandboxMode, next.sandboxMode);
    preamble = updateTopLevelString(preamble, CONFIG_KEYS.webSearch, next.webSearch);

    mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
    const content = `${preamble.trimEnd()}${remainder ? `\n\n${remainder.trimStart()}` : '\n'}`;
    writeFileSync(this.configPath, content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.configPath, 0o600);
    return next;
  }
}

function validateConfiguration(value: {
  model?: unknown;
  modelReasoningEffort?: unknown;
  approvalPolicy?: unknown;
  sandboxMode?: unknown;
  webSearch?: unknown;
}): CodexRuntimeConfiguration {
  const model = typeof value.model === 'string' ? value.model.trim() : undefined;
  if (model && !/^[a-zA-Z0-9._:/-]{1,128}$/.test(model)) {
    throw new Error('Codex 模型名称格式无效');
  }
  return {
    ...(model ? { model } : {}),
    modelReasoningEffort: oneOf(
      value.modelReasoningEffort,
      ['low', 'medium', 'high', 'xhigh'],
      '推理强度',
    ),
    approvalPolicy: oneOf(
      value.approvalPolicy,
      ['untrusted', 'on-request', 'never'],
      '审批策略',
    ),
    sandboxMode: oneOf(
      value.sandboxMode,
      ['read-only', 'workspace-write', 'danger-full-access'],
      '沙箱模式',
    ),
    webSearch: oneOf(value.webSearch, ['cached', 'indexed', 'live', 'disabled'], '网页搜索模式'),
  };
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`${label}无效`);
  }
  return value as T[number];
}

function topLevelPreamble(content: string): string {
  const firstTable = content.search(/^\s*\[/m);
  return firstTable === -1 ? content : content.slice(0, firstTable);
}

function readTomlString(content: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`, 'm'));
  return match?.[2];
}

function updateTopLevelString(content: string, key: string, value?: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=.*(?:\\r?\\n|$)`, 'm');
  if (!value) return content.replace(pattern, '');
  const line = `${key} = ${JSON.stringify(value)}\n`;
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.trimEnd()}${content.trim() ? '\n' : ''}${line}`;
}
