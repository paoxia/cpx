import type { SkillContext, SkillModule } from '../core/types';

interface Rpc {
  type: string;
  id?: number;
  service?: string;
  method?: string;
  args?: unknown[];
  result?: unknown;
  error?: string;
  entry?: string;
  input?: Record<string, unknown>;
  commandId?: string;
  github?: boolean;
  mcp?: boolean;
}
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let sequence = 0;
const call = (service: string, method: string, args: unknown[]): Promise<unknown> =>
  new Promise((resolvePromise, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolvePromise, reject });
    process.send?.({ type: 'rpc', id, service, method, args });
  });

process.on('message', (message: Rpc) => {
  if (message.type === 'reply') {
    const entry = pending.get(message.id!);
    if (!entry) return;
    pending.delete(message.id!);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
    return;
  }
  if (message.type !== 'start') return;
  void (async () => {
    try {
      // Trusted administrator-installed code runs only in this child process.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const loaded = require(message.entry!) as SkillModule & { default?: SkillModule };
      const module = loaded.default ?? loaded;
      const logger = Object.fromEntries(
        ['debug', 'info', 'warn', 'error'].map((level) => [
          level,
          (text: string) =>
            process.send?.({ type: 'log', level, text: String(text).slice(0, 4096) }),
        ]),
      ) as unknown as SkillContext['logger'];
      const ctx: SkillContext = {
        commandId: message.commandId!,
        args: message.input ?? {},
        logger,
      };
      if (message.github)
        ctx.github = Object.fromEntries(
          ['readFile', 'modifyFile', 'createFile', 'createBranch', 'createPR'].map((method) => [
            method,
            (...args: unknown[]) => call('github', method, args),
          ]),
        ) as unknown as SkillContext['github'];
      if (message.mcp)
        ctx.mcp = { call: (id, method, params) => call('mcp', 'call', [id, method, params]) };
      const result = await module.execute(ctx);
      process.send?.({ type: 'result', result });
    } catch (error) {
      process.send?.({
        type: 'failure',
        error: error instanceof Error ? error.message : 'Skill 执行失败',
      });
    }
  })();
});
process.on('disconnect', () => process.exit(0));
