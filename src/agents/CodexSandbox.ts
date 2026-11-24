import { CodexConfigManager, CodexRuntimeConfiguration } from './CodexConfigManager';

export type CodexSandboxMode = CodexRuntimeConfiguration['sandboxMode'];

/** 每轮重新读取配置；仅用户显式选择完全访问时取消命名/协调的只读沙箱。 */
export function configuredCodexSandbox(): CodexSandboxMode {
  return new CodexConfigManager().getConfig().sandboxMode;
}

export function effectiveCodexSandbox(mode: CodexSandboxMode, readOnly = false): CodexSandboxMode {
  return readOnly && mode !== 'danger-full-access' ? 'read-only' : mode;
}
