import axios, { AxiosInstance } from 'axios';

/**
 * HTTP 客户端工厂：创建带默认超时和重试的 axios 实例
 */
export function createHttpClient(options: {
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
}): AxiosInstance {
  return axios.create({
    baseURL: options.baseURL,
    timeout: options.timeout ?? 10000,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}
