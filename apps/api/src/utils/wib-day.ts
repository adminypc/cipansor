/**
 * Calendar days on the pesantren's clock: Western Indonesia Time, UTC+7, with
 * no daylight saving. A registration window that "closes on 20 December"
 * closes at the end of that day in Tasikmalaya, not seven hours later at
 * midnight UTC, wherever the server runs.
 */
export function wibDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000+07:00`);
}

export function wibDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999+07:00`);
}

/**
 * A date input's day as a `@db.Date` value (midnight UTC, which is how Prisma
 * reads and writes a DATE column). `undefined` stays undefined, so a PATCH
 * leaves the column alone; an empty value clears it.
 */
export function calendarDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

/** The WIB calendar day a moment falls on, as a date input shows it. */
export function wibDayOf(moment: Date): string {
  return new Date(moment.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The WIB calendar month a moment falls on, as `{ year, month }` with `month`
 * zero-based (0-11) like `Date.getMonth()`.
 *
 * The monthly billing job fires at 04:00 WIB on the 1st, which is still the
 * previous month — and, in January, the previous year — on a UTC server. WIB
 * is a fixed UTC+7 with no daylight saving, so shifting the instant and reading
 * the UTC fields derives the WIB month from any server clock.
 */
export function wibMonthYear(moment: Date): { year: number; month: number } {
  const shifted = new Date(moment.getTime() + 7 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
}

/**
 * A WIB calendar month as two instants: `[start, end)`, with `start` equal to
 * the first day of the month at 00:00 WIB and `end` the first day of the next
 * month at 00:00 WIB.
 *
 * `month` is zero-based (0-11) like `Date.getMonth()`. Both bounds are built
 * with an explicit `+07:00` offset, not with `new Date(year, month, …)`, whose
 * fields are read in the server's timezone. On a UTC server the local form
 * would start "August" at August 1 07:00 WIB and end it seven hours into
 * September, so a timestamp near either midnight falls into the wrong month.
 */
export function wibMonthRange(year: number, month: number): { start: Date; end: Date } {
  const pad = (value: number) => String(value).padStart(2, '0');
  const start = new Date(`${year}-${pad(month + 1)}-01T00:00:00.000+07:00`);
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = (month + 1) % 12;
  const end = new Date(`${nextYear}-${pad(nextMonth + 1)}-01T00:00:00.000+07:00`);
  return { start, end };
}

/**
 * A WIB calendar day as an instant: `day` at 00:00 WIB (UTC+7), with `month`
 * zero-based (0-11). Built by rolling the day in UTC and subtracting the fixed
 * offset, so it is the same instant on any server clock — a
 * `new Date(year, month, day)` reads the server's timezone and, east of WIB
 * (e.g. UTC+8), lands the first of the month in the previous WIB month.
 * `Date.UTC` also rolls an over-large `day` into the next month, as the local
 * constructor did.
 */
export function wibDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day) - 7 * 60 * 60 * 1000);
}

/** A `@db.Date` value as a date input shows it. */
export function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
