export type AgentServiceTier = 'default' | 'fast';

export function normalizeServiceTier(value: unknown): AgentServiceTier | undefined {
  if (value === undefined) return undefined;
  if (value === 'default' || value === 'fast') return value;
  throw new Error('推理速度无效，只支持标准或 Fast');
}

/** 未设置时沿用 CLI；标准档显式覆盖 config.toml 或上一轮的 Fast。 */
export function codexSpeedArgs(value?: AgentServiceTier): string[] {
  const tier = normalizeServiceTier(value);
  if (!tier) return [];
  return [
    ...(tier === 'fast' ? ['--config', 'features.fast_mode=true'] : []),
    '--config',
    `service_tier=${JSON.stringify(tier)}`,
  ];
}
