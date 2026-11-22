import { describe, expect, it, vi } from 'vitest';
import {
  isMessagingPlatform,
  MessagingIntegrationManager,
} from '../../../src/integrations/MessagingIntegrationManager';
import { Logger } from '../../../src/utils/Logger';

const sdk = vi.hoisted(() => ({
  dingCallback: vi.fn(),
  feishuCallback: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock('dingtalk-stream', () => ({
  DWClient: class {
    registerCallbackListener = sdk.dingCallback;
    socketCallBackResponse = sdk.acknowledge;
    async getAccessToken() { return 'fixture-token'; }
    async connect() {}
    disconnect() {}
  },
  TOPIC_ROBOT: '/fixture/dingtalk',
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  createLarkChannel: () => ({
    on: sdk.feishuCallback,
    async connect() {},
    async disconnect() {},
  }),
  LoggerLevel: { warn: 'warn' },
}));

describe('MessagingIntegrationManager', () => {
  it('未启用时不建立连接，并且公开配置不包含凭据明文', async () => {
    const manager = new MessagingIntegrationManager(
      { enabled: false, clientId: 'ding-id', clientSecret: 'ding-secret' },
      { enabled: false, appId: 'feishu-id', appSecret: 'feishu-secret' },
      new Logger('error'),
      async () => ({ success: true, message: 'ok' }),
    );

    await manager.start();
    const configuration = manager.getPublicConfiguration();
    expect(configuration.dingtalk).toMatchObject({
      state: 'disabled',
      configured: true,
      hasClientId: true,
      hasClientSecret: true,
    });
    expect(configuration.feishu).toMatchObject({
      state: 'disabled',
      configured: true,
      hasAppId: true,
      hasAppSecret: true,
    });
    expect(JSON.stringify(configuration)).not.toContain('ding-secret');
    expect(JSON.stringify(configuration)).not.toContain('feishu-secret');
    await manager.stop();
  });

  it('启用但缺少凭据时返回可展示错误', async () => {
    const manager = new MessagingIntegrationManager(
      { enabled: true },
      { enabled: true },
      new Logger('error'),
      async () => ({ success: true, message: 'ok' }),
    );

    await manager.start();
    expect(manager.getPublicConfiguration().dingtalk).toMatchObject({
      state: 'error',
      configured: false,
      message: expect.stringContaining('Client ID'),
    });
    expect(manager.getPublicConfiguration().feishu).toMatchObject({
      state: 'error',
      configured: false,
      message: expect.stringContaining('App ID'),
    });
  });

  it('只接受受支持的消息平台名', () => {
    expect(isMessagingPlatform('dingtalk')).toBe(true);
    expect(isMessagingPlatform('feishu')).toBe(true);
    expect(isMessagingPlatform('webhook')).toBe(false);
  });

  it('将真实来源标识传给消息管道，并忽略重复投递', async () => {
    const process = vi.fn(async () => ({ commandId: 'fixture', success: true, message: 'ok' }));
    const manager = new MessagingIntegrationManager(
      { enabled: true, clientId: 'ding-id', clientSecret: 'ding-secret' },
      { enabled: true, appId: 'feishu-id', appSecret: 'feishu-secret' },
      new Logger('error'),
      process,
    );
    await manager.start();
    try {
      const ding = sdk.dingCallback.mock.calls[0][1];
      const dingEvent = {
        headers: { messageId: 'event-1' },
        data: JSON.stringify({
          msgId: 'ding-message', msgtype: 'text', text: { content: '钉钉消息' },
          conversationId: 'ding-chat', senderStaffId: 'staff-1', senderId: 'account-1',
        }),
      };
      await ding(dingEvent);
      await ding({ ...dingEvent, headers: { messageId: 'event-2' } });
      const feishu = sdk.feishuCallback.mock.calls.find(([name]) => name === 'message')?.[1];
      const feishuEvent = { messageId: 'feishu-message', chatId: 'oc-chat', senderId: 'ou-1', content: '飞书消息' };
      await feishu(feishuEvent);
      await feishu(feishuEvent);
      expect(process.mock.calls).toEqual([
        ['钉钉消息', expect.objectContaining({ source: 'dingtalk', userId: 'staff-1', replyRouteId: 'ding-chat:staff-1' })],
        ['飞书消息', expect.objectContaining({ source: 'feishu', userId: 'ou-1', replyRouteId: 'oc-chat:ou-1' })],
      ]);
      expect(sdk.acknowledge).toHaveBeenCalledWith('event-2', { success: true });
    } finally {
      await manager.stop();
    }
  });
});
