import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** 远程实例首次启动生成访问密码，保存在数据库旁，重建容器时复用。 */
export function resolveWorkspaceWebToken(
  host: string,
  configuredToken: string | undefined,
  dataDirectory: string,
): string | undefined {
  const configured = configuredToken?.trim();
  if (configured) return configured;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return undefined;

  mkdirSync(dataDirectory, { recursive: true });
  const tokenFile = join(dataDirectory, 'workspace-web-token');
  try {
    writeFileSync(tokenFile, `${randomBytes(32).toString('hex')}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!token) {
    throw new Error(`工作区访问令牌文件为空：${tokenFile}，请填写非空令牌、设置 AGENT_WORKSPACE_WEB_TOKEN，或移除该文件后重启以重新生成`);
  }
  return token;
}
