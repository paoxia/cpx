import { describe, expect, it } from 'vitest';
import {
  isMessagingPlatform,
  MessagingIntegrationManager,
} from '../../../src/integrations/MessagingIntegrationManager';
import { Logger } from '../../../src/utils/Logger';

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
});
