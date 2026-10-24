import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NewsRequest, validateNews } from '../../../src/agents/News';

describe('news source validation and deterministic Markdown', () => {
  let root: string;
  const news: NewsRequest = {
    directory: 'news',
    date: '2026-10-24',
    since: Date.parse('2026-10-23T01:00:00Z'),
    until: Date.parse('2026-10-24T01:00:00Z'),
    timeZone: 'Asia/Shanghai',
    maxItems: 3,
  };
  const item = {
    title: 'Official announcement',
    url: 'https://example.com/news/1',
    publishedAt: '2026-10-23T12:00:00Z',
    summary: '经过核验的新闻摘要。',
  };
  const manifest = (items = [item], date = news.date) =>
    writeFileSync(join(root, 'news', `${date}.sources.json`), JSON.stringify({ items }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cpx-news-'));
    mkdirSync(join(root, 'news'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('requires actual search evidence and renders source-linked Markdown', () => {
    manifest();
    expect(() => validateNews(root, news, 0)).toThrow('实时搜索记录');
    validateNews(root, news, 1);
    const markdown = readFileSync(join(root, 'news', `${news.date}.md`), 'utf8');
    expect(markdown).toContain('https://example.com/news/1');
    expect(markdown).toContain(item.publishedAt);
    expect(markdown).toContain(item.summary);
    expect(() => validateNews(root, news, 1, false)).not.toThrow();
    writeFileSync(join(root, 'news', `${news.date}.md`), 'altered');
    expect(() => validateNews(root, news, 1, false)).toThrow('不一致');
  });

  it('rejects stale, future, invalid and duplicate sources', () => {
    for (const publishedAt of ['2026-10-22T12:00:00Z', '2026-10-25T12:00:00Z']) {
      manifest([{ ...item, publishedAt }]);
      expect(() => validateNews(root, news, 1)).toThrow('采集范围');
    }
    manifest([item, { ...item, title: 'different', url: `${item.url}?utm_source=x#tracking` }]);
    expect(() => validateNews(root, news, 1)).toThrow('重复');
    manifest([item], '2026-10-23');
    manifest([{ ...item, url: `${item.url}?utm_source=x#tracking` }]);
    expect(() => validateNews(root, news, 1)).toThrow('重复');
  });

  it('allows a verified empty report and refuses symlink output paths', () => {
    manifest([]);
    validateNews(root, news, 1);
    expect(readFileSync(join(root, 'news', `${news.date}.md`), 'utf8')).toContain('未发现');
    rmSync(join(root, 'news', `${news.date}.md`));
    writeFileSync(join(root, 'outside.md'), 'keep');
    symlinkSync(join(root, 'outside.md'), join(root, 'news', `${news.date}.md`));
    expect(() => validateNews(root, news, 1)).toThrow('符号链接');
    expect(readFileSync(join(root, 'outside.md'), 'utf8')).toBe('keep');
  });
});
