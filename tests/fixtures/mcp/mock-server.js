#!/usr/bin/env node
/**
 * 测试用 MCP mock 服务器
 *
 * 从 stdin 按行读取 JSON-RPC 2.0 请求，按行返回响应到 stdout。
 * 支持 initialize、notifications/initialized、tools/list、echo 方法。
 */
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }

  // 通知（无 id）：不响应
  if (msg.method && msg.id === undefined) {
    if (msg.method === 'notifications/initialized') {
      // 静默确认
    }
    return;
  }

  // 请求
  if (msg.method) {
    switch (msg.method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'mock-mcp', version: '1.0.0' },
          },
        });
        break;
      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: '回显输入',
                inputSchema: {
                  type: 'object',
                  properties: { message: { type: 'string' } },
                },
              },
            ],
          },
        });
        break;
      case 'echo':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(msg.params) }] },
        });
        break;
      case 'error_method':
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: '故意失败' },
        });
        break;
      default:
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
    }
  }
});

// 保持进程存活
process.stdin.on('end', () => process.exit(0));
