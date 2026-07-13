/**
 * JSON-RPC 2.0 协议工具
 *
 * MCP（Model Context Protocol）基于 JSON-RPC 2.0 通信。
 * 本模块提供请求/响应的构造与解析，与传输层解耦。
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

/** 无 id 的通知（单向消息，不期望响应） */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/** JSON-RPC 标准错误码 */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** 构造请求 */
export function createRequest(
  id: number | string,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
  if (params !== undefined) {
    req.params = params;
  }
  return req;
}

/** 构造通知（无 id，不需响应） */
export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  const notif: JsonRpcNotification = { jsonrpc: '2.0', method };
  if (params !== undefined) {
    notif.params = params;
  }
  return notif;
}

/** 是否为响应（有 id 且包含 result 或 error） */
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg);
}

/** 是否为请求（有 method 且有 id） */
export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return 'method' in msg && 'id' in msg;
}

/** 是否为通知（有 method 但无 id） */
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg);
}

/**
 * 解析一条 JSON-RPC 消息
 * @throws 当 JSON 无效或不符合基本结构时抛出 Error
 */
export function parseMessage(data: string): JsonRpcMessage {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    throw new Error(`JSON-RPC 消息不是有效的 JSON: ${data.slice(0, 200)}`);
  }

  if (typeof obj !== 'object' || obj === null) {
    throw new Error('JSON-RPC 消息必须是对象');
  }

  const msg = obj as Record<string, unknown>;
  if (msg.jsonrpc !== '2.0') {
    throw new Error(`JSON-RPC 版本不兼容: ${String(msg.jsonrpc)}`);
  }

  return msg as unknown as JsonRpcMessage;
}

/** 序列化为字符串 */
export function serialize(msg: JsonRpcMessage): string {
  return JSON.stringify(msg);
}
