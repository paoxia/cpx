import { describe, expect, it } from 'vitest';
import { nextScheduleAt, scheduleDate, scheduleSchema } from '../../../src/workbench/Schedules';

const daily = (timeZone = 'Asia/Shanghai', dailyTime = '09:00') =>
  scheduleSchema.parse({
    id: 'daily',
    projectId: 'incubator',
    templateId: 'news',
    prompt: 'AI news',
    cadence: 'daily',
    dailyTime,
    timeZone,
  });
const next = (zone: string, time: string, now: string) =>
  new Date(nextScheduleAt(daily(zone, time), Date.parse(now))).toISOString();

describe('timezone-aware daily schedules', () => {
  it('uses local wall time, strictly after now, across dates and years', () => {
    expect(next('Asia/Shanghai', '09:00', '2026-10-24T00:59:59Z')).toBe('2026-10-24T01:00:00.000Z');
    expect(next('Asia/Shanghai', '09:00', '2026-10-24T01:00:00Z')).toBe('2026-10-25T01:00:00.000Z');
    expect(next('Asia/Shanghai', '00:00', '2026-12-31T16:00:00Z')).toBe('2027-01-01T16:00:00.000Z');
    expect(scheduleDate('Asia/Shanghai', Date.parse('2026-10-24T17:00:00Z'))).toBe('2026-10-25');
  });

  it('handles non-hour offsets and the largest positive timezone', () => {
    expect(next('Asia/Kathmandu', '09:00', '2026-10-24T00:00:00Z')).toBe(
      '2026-10-24T03:15:00.000Z',
    );
    expect(next('Pacific/Kiritimati', '09:00', '2026-10-24T00:00:00Z')).toBe(
      '2026-10-24T19:00:00.000Z',
    );
  });

  it('skips nonexistent spring times and runs only the first repeated fall time', () => {
    expect(next('America/New_York', '02:30', '2026-03-08T05:00:00Z')).toBe(
      '2026-03-09T06:30:00.000Z',
    );
    expect(next('America/New_York', '01:30', '2026-11-01T04:00:00Z')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(next('America/New_York', '01:30', '2026-11-01T05:30:00Z')).toBe(
      '2026-11-02T06:30:00.000Z',
    );
    expect(next('America/New_York', '01:30', '2026-11-01T06:00:00Z')).toBe(
      '2026-11-02T06:30:00.000Z',
    );
  });

  it('retains legacy interval defaults and rejects invalid inputs', () => {
    const legacy = scheduleSchema.parse({
      id: 'old',
      projectId: 'p',
      templateId: 'maintenance',
      prompt: 'check',
      intervalMinutes: 5,
    });
    expect(nextScheduleAt(legacy, 1000)).toBe(301000);
    expect(legacy.publication).toBe('review');
    for (const input of [
      { timeZone: 'bad-zone' },
      { dailyTime: '24:00' },
      { intervalMinutes: 4 },
      { newsDirectory: '../config' },
    ])
      expect(scheduleSchema.safeParse({ ...daily(), ...input }).success).toBe(false);
  });
});
