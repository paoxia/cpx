'use strict';

/**
 * 测试用 mock Skill
 */
module.exports = {
  async execute(ctx) {
    const { args } = ctx;
    if (args.echo) {
      return {
        success: true,
        message: `echo: ${args.echo}`,
        data: { echoed: args.echo },
      };
    }
    if (args.shouldFail) {
      return {
        success: false,
        message: 'intentional failure',
      };
    }
    return {
      success: true,
      message: 'mock skill executed',
      data: { args },
    };
  },
};
