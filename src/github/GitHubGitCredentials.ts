import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** 凭据只经临时 AskPass 的环境变量传递，不写入仓库 URL 或文件。 */
export async function withGitHubGitCredentials<T>(
  token: string | undefined,
  operation: (environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const normalized = token?.trim();
  if (!normalized) return operation({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
  const directory = mkdtempSync(join(tmpdir(), 'cpx-github-auth-'));
  const windows = process.platform === 'win32';
  const helper = join(directory, windows ? 'askpass.cmd' : 'askpass.sh');
  try {
    const content = windows
      ? '@echo off\r\necho %~1 | findstr /I "username" >nul\r\nif not errorlevel 1 (echo x-access-token) else (echo %CPX_GITHUB_TOKEN%)\r\n'
      : '#!/bin/sh\ncase "$1" in\n  *Username*|*username*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$CPX_GITHUB_TOKEN" ;;\nesac\n';
    writeFileSync(helper, content, { mode: 0o700 });
    if (!windows) chmodSync(helper, 0o700);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      CPX_GITHUB_TOKEN: normalized,
      GIT_ASKPASS: helper,
      GIT_ASKPASS_REQUIRE: 'force',
      GIT_TERMINAL_PROMPT: '0',
    };
    const parsed = Number.parseInt(environment.GIT_CONFIG_COUNT ?? '0', 10);
    const count = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    environment.GIT_CONFIG_COUNT = String(count + 1);
    environment[`GIT_CONFIG_KEY_${count}`] = 'credential.helper';
    environment[`GIT_CONFIG_VALUE_${count}`] = '';
    return await operation(environment);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
