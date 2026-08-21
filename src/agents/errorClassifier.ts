/**
 * Agent 子进程错误分类。
 *
 * 当 codex CLI 退出码非 0 或启动失败时，AgentTaskManager
 * 通过 classifyAgentError 判定错误种类,以决定是否触发 fallback:
 *  - rate_limit / auth:额度耗尽或鉴权失败,可切换到下一个 Agent
 *  - crash / unknown:Agent 自身崩溃或 CLI 未安装,不切换
 */

export type AgentErrorKind = 'rate_limit' | 'auth' | 'crash' | 'cancelled' | 'unknown';

/** 关键字匹配(子串包含,不区分大小写)。覆盖中英文常见措辞。 */
const RATE_LIMIT_PATTERNS = [
  '429',
  'rate limit',
  'rate_limit',
  'rate-limit',
  'too many requests',
  'quota',
  'insufficient_quota',
  '余额不足',
  '配额',
  '额度',
  '限流',
  'credit',
  'billing required',
  'exhausted',
];

const AUTH_PATTERNS = [
  '401',
  '403',
  'unauthorized',
  'forbidden',
  'invalid api key',
  'invalid_api_key',
  'authentication failed',
  '认证失败',
  '无权限',
  '鉴权失败',
];

/** spawn 退出码非 0 时抛出。携带 stderr / stdout 供 fallback 分类。 */
export class AgentProcessError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
    public readonly stdout: string,
  ) {
    const detail = diagnosticLine(stderr);
    super(`${command} 退出码 ${exitCode ?? 'null'}${detail ? `: ${detail}` : ''}`);
    this.name = 'AgentProcessError';
  }
}

/**
 * 把错误归为 AgentErrorKind。仅 rate_limit / auth 触发 fallback。
 * cancelled 由调用方在 fallback 循环中通过 task.status 判定,不经过这里。
 */
export function classifyAgentError(error: Error): AgentErrorKind {
  if (!(error instanceof AgentProcessError)) {
    return 'unknown';
  }
  const text = `${error.stderr}\n${error.stdout}`.toLowerCase();
  if (RATE_LIMIT_PATTERNS.some((pattern) => text.includes(pattern.toLowerCase()))) {
    return 'rate_limit';
  }
  if (AUTH_PATTERNS.some((pattern) => text.includes(pattern.toLowerCase()))) {
    return 'auth';
  }
  return 'crash';
}

export function lastLine(value: string): string {
  return value.trim().split(/\r?\n/).pop() ?? value.trim();
}

/** 优先展示 CLI 的真实错误，避免只把末尾的 `try --help` 提示暴露给用户。 */
export function diagnosticLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  return (
    lines.find((line) => /^error(?:\s|:|\[)/i.test(line)) ??
    lines.find(
      (line) =>
        !/^for more information, try/i.test(line) &&
        !/^usage:/i.test(line) &&
        !/^tip:/i.test(line),
    ) ??
    lines[lines.length - 1]
  );
}

/** 错误种类中文标签,用于日志输出。 */
export function kindLabel(kind: AgentErrorKind): string {
  return (
    {
      rate_limit: '额度/限流',
      auth: '鉴权',
      crash: '崩溃',
      cancelled: '取消',
      unknown: '未知',
    } as const
  )[kind];
}
