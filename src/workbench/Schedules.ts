import { z } from 'zod';

export const scheduleSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  projectId: z.string().min(1).max(80),
  templateId: z.string().min(1).max(80),
  prompt: z.string().trim().min(1).max(20000),
  cadence: z.enum(['interval', 'daily']).default('interval'),
  intervalMinutes: z.number().int().min(5).max(525600).default(1440),
  dailyTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('09:00'),
  timeZone: z
    .string()
    .max(100)
    .default('Asia/Shanghai')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
      } catch {
        return false;
      }
    }, '时区无效'),
  publication: z.enum(['review', 'pull_request', 'merge']).default('review'),
  newsDirectory: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
    .max(200)
    .default('news'),
  newsMaxItems: z.number().int().min(1).max(50).default(10),
  enabled: z.boolean().default(false),
});

export type Schedule = z.infer<typeof scheduleSchema> & {
  ownerId: string;
  nextAt: number;
  lastAt?: number;
  lastTaskId?: string;
  error?: string;
};

function clock(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function parts(format: Intl.DateTimeFormat, at: number): Record<string, string> {
  return Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
}

export function scheduleDate(timeZone: string, at: number): string {
  const p = parts(clock(timeZone), at);
  return `${p.year}-${p.month}-${p.day}`;
}

/** One occurrence per local date. Missing DST times are skipped; repeated times use the first. */
export function nextScheduleAt(schedule: z.infer<typeof scheduleSchema>, now: number): number {
  if (schedule.cadence !== 'daily') return now + schedule.intervalMinutes * 60000;
  const format = clock(schedule.timeZone);
  const p = parts(format, now);
  const [hour, minute] = schedule.dailyTime.split(':').map(Number);
  const today = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, minute);
  for (let day = 0; day < 4; day++) {
    const wall = today + day * 86400000;
    const offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = wall + hours * 3600000;
      const s = parts(format, sample);
      offsets.add(Date.UTC(+s.year, +s.month - 1, +s.day, +s.hour, +s.minute) - sample);
    }
    const expected = new Date(wall).toISOString().slice(0, 16);
    const candidates = [...offsets]
      .map((offset) => wall - offset)
      .filter((at) => {
        const s = parts(format, at);
        return `${s.year}-${s.month}-${s.day}T${s.hour}:${s.minute}` === expected;
      });
    const first = Math.min(...candidates);
    if (Number.isFinite(first) && first > now) return first;
  }
  throw new Error('无法计算下次执行时间');
}
