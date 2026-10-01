import { z } from 'zod';

const argument = z
  .string()
  .max(64 * 1024)
  .refine((value) => !value.includes('\0'), '不能包含 NUL');
export const ExtensionNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, '名称必须以小写字母开头，只含小写字母、数字、下划线或连字符');
export const CliArgumentsSchema = z.array(argument).max(256);

/** env 的值是父进程环境变量名，而非凭据本身。 */
export const CliExtensionSchema = z
  .object({
    version: z.literal(1).default(1),
    name: ExtensionNameSchema,
    description: z.string().max(4000).default(''),
    command: argument.refine((value) => Boolean(value.trim()), 'command 不能为空'),
    args: CliArgumentsSchema.default([]),
    versionArgs: CliArgumentsSchema.refine(
      (args) => args.length > 0,
      '版本检查参数不能为空',
    ).default(['--version']),
    cwd: argument.optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
    enabled: z.boolean().default(true),
    agentEnabled: z.boolean().default(false),
    allowedPrefixes: z
      .array(CliArgumentsSchema.refine((args) => args.length > 0, '前缀不能为空'))
      .max(100)
      .default([]),
    timeoutMs: z.number().int().min(10).max(600_000).default(30_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(256)
      .max(10 * 1024 * 1024)
      .default(128 * 1024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.agentEnabled && value.allowedPrefixes.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allowedPrefixes'],
        message: '启用 Agent 必须显式授权至少一个命令前缀',
      });
    }
    for (const key of Object.keys(value.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['env', key],
          message: '无效环境变量名',
        });
      }
    }
  });

export type CliExtension = z.infer<typeof CliExtensionSchema>;
export type CliExtensionInput = z.input<typeof CliExtensionSchema>;

export const CliRunInputSchema = z
  .object({
    name: ExtensionNameSchema,
    args: CliArgumentsSchema.default([]),
  })
  .strict();
