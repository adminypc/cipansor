import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { wibMonthYear, wibMonthRange, wibDate } from './wib-day';

// The WIB helpers must derive the calendar from the instant alone, never from
// the host clock. Production runs the API container in UTC; a developer's
// machine may sit east of WIB. Each case here is checked against the confirmed
// UTC+7 arithmetic, and the timezone cases are pinned so a server-local
// construction cannot creep back in.
const prevTz = process.env.TZ;

describe('wibMonthYear', () => {
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it('reads the month WIB is in, not the month UTC is in', () => {
    // 2026-07-31 21:00Z is 2026-08-01 04:00 WIB (the auto-billing cron instant).
    expect(wibMonthYear(new Date('2026-07-31T21:00:00Z'))).toEqual({ year: 2026, month: 7 });
    // 2025-12-31 19:00Z is 2026-01-01 02:00 WIB — the year rolls too.
    expect(wibMonthYear(new Date('2025-12-31T19:00:00Z'))).toEqual({ year: 2026, month: 0 });
  });
});

describe('wibMonthRange', () => {
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it('builds the bounds from an explicit +07:00 offset', () => {
    // 00:00 WIB on 1 August is 2026-07-31T17:00Z; 00:00 WIB on 1 September is
    // 2026-08-31T17:00Z. A local `new Date(2026, 7, 1)` on a UTC server would
    // resolve to 00:00Z, seven hours late.
    const { start, end } = wibMonthRange(2026, 7);
    expect(start.toISOString()).toBe('2026-07-31T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-31T17:00:00.000Z');
  });

  it('rolls over from December to January of the next year', () => {
    const { start, end } = wibMonthRange(2026, 11);
    expect(start.toISOString()).toBe('2026-11-30T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-12-31T17:00:00.000Z');
  });
});

describe('wibDate', () => {
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  it('returns 00:00 WIB of the given day', () => {
    expect(wibDate(2026, 7, 10).toISOString()).toBe('2026-08-09T17:00:00.000Z');
  });

  it('is the same instant on any server timezone', () => {
    const utc = wibDate(2026, 7, 1);
    process.env.TZ = 'Asia/Makassar'; // UTC+8, east of WIB
    const makassar = wibDate(2026, 7, 1);
    process.env.TZ = 'America/New_York';
    const newYork = wibDate(2026, 7, 1);
    process.env.TZ = 'UTC';

    // 2026-07-31T17:00Z, i.e. 00:00 WIB on 1 August — inside that WIB month
    // ([2026-07-31T17:00Z, 2026-08-31T17:00Z)). A local `new Date(2026, 7, 1)`
    // on UTC+8 gives 2026-07-31T16:00Z, one hour before the month starts.
    expect(utc.toISOString()).toBe('2026-07-31T17:00:00.000Z');
    expect(makassar.getTime()).toBe(utc.getTime());
    expect(newYork.getTime()).toBe(utc.getTime());
  });

  it('rolls an over-large day into the next month, as the local constructor did', () => {
    expect(wibDate(2026, 7, 32).toISOString()).toBe('2026-08-31T17:00:00.000Z');
  });
});
