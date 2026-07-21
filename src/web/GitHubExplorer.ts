interface GitHubUserResponse {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

interface GitHubRepositoryResponse {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  default_branch: string;
}

export interface GitHubAccount {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  htmlUrl: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stars: number;
  updatedAt: string;
  defaultBranch: string;
}

export interface GitHubConnection {
  user: GitHubAccount;
  repositories: GitHubRepository[];
}

export interface GitHubApiClient {
  get<T>(url: string, params?: Record<string, unknown>): Promise<T>;
}

export type GitHubClientFactory = (token: string) => GitHubApiClient;

/** 验证 GitHub 身份并读取该 Token 可访问的全部仓库。 */
export async function inspectGitHubAccount(client: GitHubApiClient): Promise<GitHubConnection> {
  const user = await client.get<GitHubUserResponse>('/user');
  const repositories: GitHubRepositoryResponse[] = [];
  const perPage = 100;

  for (let page = 1; ; page += 1) {
    const batch = await client.get<GitHubRepositoryResponse[]>('/user/repos', {
      affiliation: 'owner,collaborator,organization_member',
      visibility: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: perPage,
      page,
    });
    repositories.push(...batch);
    if (batch.length < perPage) break;
  }

  return {
    user: {
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      htmlUrl: user.html_url,
    },
    repositories: repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      fullName: repository.full_name,
      owner: repository.owner.login,
      private: repository.private,
      htmlUrl: repository.html_url,
      description: repository.description,
      fork: repository.fork,
      archived: repository.archived,
      language: repository.language,
      stars: repository.stargazers_count,
      updatedAt: repository.updated_at,
      defaultBranch: repository.default_branch,
    })),
  };
}
