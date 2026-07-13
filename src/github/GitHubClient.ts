import axios, { AxiosInstance, AxiosError } from 'axios';
import { Logger } from '../utils/Logger';
import { GitHubError } from '../utils/errors';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * GitHub API 客户端：封装认证、限流处理
 */
export class GitHubClient {
  private client: AxiosInstance;
  private logger: Logger;

  constructor(token: string, logger: Logger) {
    this.logger = logger;
    this.client = axios.create({
      baseURL: GITHUB_API_BASE,
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  async get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', url, undefined, params);
  }

  async post<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', url, body);
  }

  async put<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', url, body);
  }

  async delete<T>(url: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', url, body);
  }

  private async request<T>(
    method: string,
    url: string,
    body?: unknown,
    params?: Record<string, unknown>,
  ): Promise<T> {
    try {
      const res = await this.client.request<T>({
        method,
        url,
        data: body,
        params,
      });
      this.checkRateLimit(res.headers);
      return res.data;
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string }>;
      const status = axiosErr.response?.status;
      const message = axiosErr.response?.data?.message ?? axiosErr.message;

      if (status === 403 && axiosErr.response?.headers?.['x-ratelimit-remaining'] === '0') {
        const reset = axiosErr.response.headers['x-ratelimit-reset'];
        throw new GitHubError(`GitHub API 限流，将在 ${reset} 后恢复`);
      }
      throw new GitHubError(`GitHub API 错误 (${status}): ${message}`, status);
    }
  }

  private checkRateLimit(headers: Record<string, unknown>): void {
    const remaining = headers?.['x-ratelimit-remaining'];
    if (remaining !== undefined && Number(remaining) < 10) {
      this.logger.warn(`GitHub API 剩余调用次数过低: ${remaining}`);
    }
  }
}
