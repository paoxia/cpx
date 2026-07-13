#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { AgentSystem } from './core/AgentSystem';

const VERSION = '1.0.0';

const program = new Command();

program
  .name('agent-cli')
  .description('智能代理系统：支持钉钉/飞书远程控制、Skill 插件扩展、MCP 连接')
  .version(VERSION);

program
  .command('version')
  .description('显示版本信息')
  .action(() => {
    console.log(`Agent System v${VERSION}`);
  });

program
  .command('init')
  .description('初始化配置文件（config.yaml 和 permissions.yaml）')
  .option('-d, --dir <dir>', '配置目录', './config')
  .action((opts: { dir: string }) => {
    const configDir = resolve(opts.dir);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const examples = [
      { src: 'config/config.example.yaml', dest: join(configDir, 'config.yaml') },
      { src: 'config/permissions.example.yaml', dest: join(configDir, 'permissions.yaml') },
    ];

    for (const { src, dest } of examples) {
      const srcPath = existsSync(src) ? src : join(__dirname, '..', 'config', src.split('/').pop()!);
      if (existsSync(dest)) {
        console.log(`已存在，跳过: ${dest}`);
        continue;
      }
      if (!existsSync(srcPath)) {
        console.error(`找不到示例文件: ${srcPath}`);
        continue;
      }
      copyFileSync(srcPath, dest);
      console.log(`已创建: ${dest}`);
    }

    console.log('\n配置初始化完成。请编辑 config.yaml 填写钉钉/飞书/GitHub 配置。');
  });

program
  .command('start')
  .description('启动 Agent 系统')
  .option('-d, --dir <dir>', '配置目录', './config')
  .action(async (opts: { dir: string }) => {
    const configDir = resolve(opts.dir);
    if (!existsSync(configDir)) {
      console.error(`配置目录不存在: ${configDir}`);
      console.error('请先运行: agent-cli init');
      process.exit(1);
    }

    const system = new AgentSystem(configDir);

    // 优雅停机
    const shutdown = async (signal: string) => {
      console.log(`\n收到 ${signal}，正在停止...`);
      try {
        await system.stop();
        process.exit(0);
      } catch (err) {
        console.error('停止失败:', err);
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    try {
      await system.start();
      console.log('Agent System 已启动，按 Ctrl+C 停止');
    } catch (err) {
      console.error('启动失败:', err);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('停止运行中的 Agent 系统（需配合进程管理工具）')
  .action(() => {
    console.log('stop 命令通过发送 SIGTERM 信号停止运行中的 Agent。');
    console.log('示例: pkill -TERM -f "agent-cli start"');
  });

program.parse();
