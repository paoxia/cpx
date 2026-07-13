import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '../../../src/utils/Logger';

describe('Logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应按级别过滤输出', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = new Logger('warn');
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    // debug 和 info 被过滤，warn 和 error 输出
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('child 应继承级别并带前缀', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = new Logger('info');
    const child = logger.child('Skill');
    child.info('hello');
    expect(spy).toHaveBeenCalledTimes(1);
    const output = spy.mock.calls[0][0] as string;
    expect(output).toContain('[Skill]');
    expect(output).toContain('hello');
  });

  it('setLevel 应动态修改级别', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = new Logger('error');
    logger.info('before');
    logger.setLevel('info');
    logger.info('after');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('after');
  });
});
