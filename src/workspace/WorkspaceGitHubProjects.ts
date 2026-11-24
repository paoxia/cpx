import { withGitHubGitCredentials } from '../github/GitHubGitCredentials';
import { normalizeGitHubRepository } from '../web/GitHubWorkspace';
import { cloneRegisteredWorkspaceProject, inspectWorkspace } from './Workspace';

export interface WorkspaceCloneTarget {
  name: string;
  repository: string;
  remote: string;
}

export async function missingGitHubProjects(root: string): Promise<WorkspaceCloneTarget[]> {
  const workspace = await inspectWorkspace(root);
  return workspace.projects.flatMap(project => {
    if (project.present || !project.remote) return [];
    try {
      return [{ name: project.name, repository: normalizeGitHubRepository(project.remote), remote: project.remote }];
    } catch {
      return [];
    }
  });
}

export async function cloneGitHubProjects(
  token: string | undefined, root: string, targets: WorkspaceCloneTarget[],
): Promise<string> {
  if (!token?.trim()) throw new Error('请先在 cpx 的 GitHub 页面连接账号。');
  const outcomes: string[] = [];
  await withGitHubGitCredentials(token, async (env) => {
    // A failed clone must not prevent the rest of the confirmed projects from being attempted.
    for (const target of targets) {
      try {
        await cloneRegisteredWorkspaceProject(root, target.name, target.remote, `https://github.com/${target.repository}.git`, env);
        outcomes.push(`• ${target.name} 可用`);
      } catch (error) {
        outcomes.push(`• ${target.name}：${error instanceof Error ? error.message : '克隆失败'}`);
      }
    }
  });
  return ['GitHub 项目初始化结果', ...outcomes].join('\n');
}
