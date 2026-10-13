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
 * A calendar day as the value a date-only column holds: midnight UTC.
 *
 * Invoice `dueDate` is a date-only `DateTime`; the codebase stores these at
 * midnight UTC (`academic-calendar.ts`, `seeds/paket-presentasi.ts`, and
 * `academicYearBillingWindow`), readers stringify them without a timezone
 * (`toLocaleDateString('id-ID')`, `toISOString().slice(0, 10)`), and the
 * academic-year and monthly filters bound them with UTC first-of-month. A
 * date-only column can hold one form; returning midnight UTC keeps every one of
 * those readers and filters correct, whereas a WIB-midnight instant (17:00Z the
 * day before) reads as the previous day and falls out of its own month.
 *
 * `month` is zero-based (0-11); `Date.UTC` rolls an over-large `day` into the
 * next month, as `new Date(year, month, day)` did.
 */
export function wibDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/** A calendar month as the date-only bounds its column uses: `[start, end)` at
 * midnight UTC — the form `wibDate` writes for a date-only column. */
export function utcMonthRange(year: number, month: number): { start: Date; end: Date } {
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = (month + 1) % 12;
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(nextYear, nextMonth, 1)),
  };
}

/**
 * The date-only value (midnight UTC) of the WIB calendar day an instant falls
 * on. Applied at the manual create/update paths so a `dueDate` this module
 * writes can be read as a date alone — the generators already produce that form
 * via `wibDate`. A caller that means "1 August" as 00:00 WIB sends
 * `2026-07-31T17:00Z`, which on a UTC server reads as 31 July; normalizing to the
 * WIB day (2026-08-01T00:00Z) keeps it inside August's `utcMonthRange`, so the
 * bulk generator's guard finds it and the reminder reaches it.
 */
export function wibDayDate(moment: Date): Date {
  return new Date(`${wibDayOf(moment)}T00:00:00.000Z`);
}

/** A `@db.Date` value as a date input shows it. */
export function dayOf(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
