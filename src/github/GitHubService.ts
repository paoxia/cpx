import { GitHubClient } from './GitHubClient';
import { Logger } from '../utils/Logger';
import { GitHubError } from '../utils/errors';

interface GitHubContent {
  content: { content: string; sha: string; encoding: string };
  sha?: string;
}

interface GitHubRef {
  ref: string;
  object: { sha: string };
}

interface GitHubPR {
  url: string;
  number: number;
  html_url: string;
}

/**
 * GitHub 高级服务：文件读写、分支管理、PR 创建
 */
export class GitHubService {
  private client: GitHubClient;
  private logger: Logger;
  private defaultRepo?: string;
  private defaultBranch: string;

  constructor(
    client: GitHubClient,
    logger: Logger,
    defaultRepo?: string,
    defaultBranch: string = 'main',
  ) {
    this.client = client;
    this.logger = logger;
    this.defaultRepo = defaultRepo;
    this.defaultBranch = defaultBranch;
  }

  /** 读取文件内容 */
  async readFile(
    repo: string,
    filePath: string,
    branch?: string,
  ): Promise<{ content: string; sha: string }> {
    const r = repo || this.defaultRepo;
    if (!r) {
      throw new GitHubError('未指定仓库（owner/repo）');
    }
    const params = branch ? { ref: branch } : undefined;
    const data = await this.client.get<GitHubContent>(
      `/repos/${r}/contents/${encodeURIComponent(filePath)}`,
      params,
    );
    const content = Buffer.from(
      data.content.content,
      (data.content.encoding as BufferEncoding) || 'base64',
    ).toString('utf8');
    return { content, sha: data.content.sha };
  }

  /** 创建分支 */
  async createBranch(repo: string, branchName: string, fromBranch?: string): Promise<void> {
    const r = repo || this.defaultRepo;
    if (!r) {
      throw new GitHubError('未指定仓库');
    }
    const base = fromBranch ?? this.defaultBranch;
    // 获取基准分支的 SHA
    const ref = await this.client.get<GitHubRef>(`/repos/${r}/git/refs/heads/${base}`);
    const sha = ref.object.sha;
    // 创建新分支
    await this.client.post(`/repos/${r}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha,
    });
    this.logger.info(`已创建分支 ${branchName} (基于 ${base})`);
  }

  /** 修改文件（需要 sha） */
  async modifyFile(
    repo: string,
    filePath: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<{ commit: { sha: string } }> {
    const r = repo || this.defaultRepo;
    if (!r) {
      throw new GitHubError('未指定仓库');
    }
    const { sha } = await this.readFile(r, filePath, branch);
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    return this.client.put(`/repos/${r}/contents/${encodeURIComponent(filePath)}`, {
      message,
      content: encoded,
      sha,
      branch,
    });
  }

  /** 创建新文件 */
  async createFile(
    repo: string,
    filePath: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<{ commit: { sha: string } }> {
    const r = repo || this.defaultRepo;
    if (!r) {
      throw new GitHubError('未指定仓库');
    }
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    return this.client.put(`/repos/${r}/contents/${encodeURIComponent(filePath)}`, {
      message,
      content: encoded,
      branch,
    });
  }

  /** 创建 Pull Request */
  async createPR(
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<{ url: string; number: number }> {
    const r = repo || this.defaultRepo;
    if (!r) {
      throw new GitHubError('未指定仓库');
    }
    const pr = await this.client.post<GitHubPR>(`/repos/${r}/pulls`, {
      title,
      body,
      head,
      base,
    });
    return { url: pr.html_url, number: pr.number };
  }

  /**
   * 完整流程：读取文件 -> 创建分支 -> 修改 -> 提交 -> 创建 PR
   * 用于 "@agent 修改 <file> <description>" 命令
   */
  async modifyAndCreatePR(
    filePath: string,
    description: string,
    repo?: string,
    baseBranch?: string,
  ): Promise<{ prUrl: string; branch: string }> {
    const r = repo || this.defaultRepo;
    if (!r) {
      throw new GitHubError('未指定仓库，请在配置中设置 github.defaultRepo');
    }
    const base = baseBranch ?? this.defaultBranch;
    const timestamp = Date.now();
    const branchName = `feature/update-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}`;

    // 1. 读取原文件
    this.logger.info(`读取文件 ${filePath}...`);
    const { content: original } = await this.readFile(r, filePath, base);

    // 2. 创建功能分支
    this.logger.info(`创建分支 ${branchName}...`);
    await this.createBranch(r, branchName, base);

    // 3. 修改内容（追加描述为新章节）
    const newSection = `\n\n## ${description}\n\n<!-- 由 Agent System 自动添加 -->\n`;
    const modified = original + newSection;

    // 4. 提交修改
    this.logger.info(`提交修改到 ${branchName}...`);
    await this.modifyFile(r, filePath, modified, branchName, `docs: ${description}`);

    // 5. 创建 PR
    this.logger.info(`创建 PR...`);
    const pr = await this.createPR(
      r,
      `${description}`,
      `## 修改说明\n\n本 PR 由 Agent System 自动创建。\n\n**文件**: \`${filePath}\`\n**描述**: ${description}\n**分支**: \`${branchName}\` -> \`${base}\`\n\n请审查后合并。`,
      branchName,
      base,
    );

    return { prUrl: pr.url, branch: branchName };
  }

  /**
   * 创建新文件并创建 PR
   * 用于 "@agent 新建文件 <file> <description>" 命令
   */
  async createFileAndPR(
    filePath: string,
    description: string,
    repo?: string,
    baseBranch?: string,
  ): Promise<{ prUrl: string; branch: string }> {
    const r = repo || this.defaultRepo;
    if (!r) {
      throw new GitHubError('未指定仓库');
    }
    const base = baseBranch ?? this.defaultBranch;
    const timestamp = Date.now();
    const branchName = `feature/create-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}-${timestamp}`;

    // 创建分支
    await this.createBranch(r, branchName, base);

    // 创建文件
    const content = `# ${description}\n\n<!-- 由 Agent System 自动创建 -->\n`;
    await this.createFile(r, filePath, content, branchName, `feat: ${description}`);

    // 创建 PR
    const pr = await this.createPR(
      r,
      `新建 ${filePath} - ${description}`,
      `## 修改说明\n\n本 PR 由 Agent System 自动创建。\n\n**文件**: \`${filePath}\`\n**描述**: ${description}\n**分支**: \`${branchName}\` -> \`${base}\`\n`,
      branchName,
      base,
    );

    return { prUrl: pr.url, branch: branchName };
  }
}
