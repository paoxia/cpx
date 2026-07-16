import { describe, it, expect, beforeEach } from 'vitest';
import { createHash, createHmac } from 'crypto';
import { DingTalkWebhook } from '../../../src/integrations/dingtalk/DingTalkWebhook';
import { FeishuWebhook } from '../../../src/integrations/feishu/FeishuWebhook';
import { Logger } from '../../../src/utils/Logger';

const logger = new Logger('error');

describe('DingTalkWebhook', () => {
  const secret = 'SECtest123';
  let dt: DingTalkWebhook;

  beforeEach(() => {
    dt = new DingTalkWebhook(secret, true, logger);
  });

  it('应校验正确的签名', () => {
    const timestamp = String(Date.now());
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = createHmac('sha256', secret).update(stringToSign).digest('base64');
    expect(dt.verify(timestamp, sign)).toBe(true);
  });

  it('应拒绝错误的签名', () => {
    expect(dt.verify(String(Date.now()), 'invalid-sign')).toBe(false);
  });

  it('应拒绝过期时间戳', () => {
    const oldTs = String(Date.now() - 2 * 60 * 60 * 1000); // 2 小时前
    const stringToSign = `${oldTs}\n${secret}`;
    const sign = createHmac('sha256', secret).update(stringToSign).digest('base64');
    expect(dt.verify(oldTs, sign)).toBe(false);
  });

  it('enableVerify=false 时跳过校验', () => {
    const dtNoVerify = new DingTalkWebhook(undefined, false, logger);
    expect(dtNoVerify.verify('whatever', 'bad')).toBe(true);
  });

  it('应解析文本消息', () => {
    const body = Buffer.from(
      JSON.stringify({
        msgtype: 'text',
        text: { content: '@agent version' },
        senderStaffId: 'staff123',
        senderNick: '张三',
      }),
    );
    const result = dt.parse(body);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('@agent version');
    expect(result!.userInfo.userId).toBe('staff123');
    expect(result!.userInfo.userName).toBe('张三');
    expect(result!.userInfo.source).toBe('dingtalk');
  });

  it('应拒绝无 content 的消息', () => {
    const body = Buffer.from(JSON.stringify({ msgtype: 'image' }));
    expect(dt.parse(body)).toBeNull();
  });
});

describe('FeishuWebhook', () => {
  const appSecret = 'fs_secret';
  let fw: FeishuWebhook;

  beforeEach(() => {
    fw = new FeishuWebhook(appSecret, true, logger);
  });

  it('应识别 URL 验证请求', () => {
    const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'abc123' }));
    const result = fw.isUrlVerification(body);
    expect(result).not.toBeNull();
    expect(result!.challenge).toBe('abc123');
  });

  it('非验证请求应返回 null', () => {
    const body = Buffer.from(JSON.stringify({ event: {} }));
    expect(fw.isUrlVerification(body)).toBeNull();
  });

  it('应校验正确的签名', () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const rawBody = '{"test":1}';
    const stringToSign = `${timestamp}${appSecret}${rawBody}`;
    const signature = createHash('sha1').update(stringToSign).digest('hex');
    expect(fw.verify(timestamp, rawBody, signature)).toBe(true);
  });

  it('应拒绝错误的签名', () => {
    expect(fw.verify(String(Math.floor(Date.now() / 1000)), '{}', 'badsig')).toBe(false);
  });

  it('应解析 im.message.receive_v1 事件', () => {
    const body = Buffer.from(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: {
            sender_id: { open_id: 'ou_123', user_id: 'u1' },
            sender_name: '李四',
          },
          message: {
            message_type: 'text',
            content: JSON.stringify({ text: '/agent help' }),
          },
        },
      }),
    );
    const result = fw.parse(body);
    expect(result).not.toBeNull();
    expect(result!.text).toBe('/agent help');
    expect(result!.userInfo.userId).toBe('ou_123');
    expect(result!.userInfo.userName).toBe('李四');
    expect(result!.userInfo.source).toBe('feishu');
  });

  it('应拒绝非文本消息', () => {
    const body = Buffer.from(
      JSON.stringify({
        event: {
          message: { message_type: 'image', content: '{}' },
        },
      }),
    );
    expect(fw.parse(body)).toBeNull();
  });
});
