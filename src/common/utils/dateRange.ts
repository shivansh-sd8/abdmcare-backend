/**
 * Server-timezone-safe date helpers.
 *
 * The hospital is in India, the seed staff are in IST, the wall clocks of
 * doctors and patients are in IST — so "today" on a dashboard MUST mean
 * "today in IST" regardless of the timezone the Node process happens to
 * be running in. Render / Vercel default to UTC, which makes
 * `new Date(); date.setHours(0,0,0,0)` produce midnight UTC and shift the
 * dashboard's "today" 5:30 hours behind the user's wall clock.
 *
 * All date bucket / stat / dashboard code MUST go through these helpers
 * instead of using `setHours(0, 0, 0, 0)` directly.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS        = 24 * 60 * 60 * 1000;

const dayLabelFmt = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  timeZone: 'Asia/Kolkata',
});
const isoDateFmt = new Intl.DateTimeFormat('en-CA', {
  // en-CA produces YYYY-MM-DD which is convenient for keys.
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: 'Asia/Kolkata',
});

/**
 * Returns the [start, end] UTC `Date` instants for an IST calendar day,
 * where `daysAgo=0` is "today (IST)" and `daysAgo=1` is "yesterday (IST)".
 * `end` is the last millisecond of that IST day (inclusive — convenient
 * for Prisma `lte` filters).
 */
export function istDayRange(daysAgo: number = 0): {
  start: Date;
  end: Date;
  label: string;     // "Mon", "Tue" — useful as a short axis label
  isoDate: string;   // YYYY-MM-DD in IST
} {
  // Snap "now" to IST midnight.
  // We add the IST offset to UTC so floor() lands on an IST-midnight value
  // expressed in UTC ms; then we go `daysAgo` days back; then we subtract
  // the offset to get the corresponding UTC instant Prisma can query on.
  const nowUtcMs   = Date.now();
  const istNowMs   = nowUtcMs + IST_OFFSET_MS;
  const istMidUtc  = Math.floor(istNowMs / DAY_MS) * DAY_MS;
  const istStartUtc = istMidUtc - daysAgo * DAY_MS;
  const istEndUtc   = istStartUtc + DAY_MS - 1;

  const start = new Date(istStartUtc - IST_OFFSET_MS);
  const end   = new Date(istEndUtc - IST_OFFSET_MS);

  return {
    start,
    end,
    label:   dayLabelFmt.format(start),
    isoDate: isoDateFmt.format(start),
  };
}

/**
 * Returns the start-of-IST-day instant `daysAgo` days back. Equivalent to
 * `istDayRange(daysAgo).start` but cheaper when only the start is needed.
 */
export function istDayStart(daysAgo: number = 0): Date {
  return istDayRange(daysAgo).start;
}

/**
 * Returns the [start, now] window for "today" in IST. Useful when an
 * endpoint wants "today's appointments" without including a future tail.
 */
export function istTodayWindow(): { start: Date; end: Date } {
  const today = istDayRange(0);
  return { start: today.start, end: new Date() };
}

/**
 * Returns the start-of-IST-day instant `daysBack` days ago, i.e. the
 * lower bound of a rolling-window query like "last 30 days".
 */
export function istWindowStart(daysBack: number): Date {
  // `daysBack=7` → the start of (today minus 6 days), which gives a 7-day
  // window inclusive of today.
  return istDayStart(Math.max(0, daysBack - 1));
}

/**
 * Hour-of-day in IST for a given UTC instant (0..23). Used by the hourly
 * load chart so a 14:00 IST appointment buckets into "2 PM" no matter what
 * the server's TZ is.
 */
export function istHourOf(date: Date): number {
  const istMs = date.getTime() + IST_OFFSET_MS;
  return new Date(istMs).getUTCHours();
}

/**
 * Returns the [start, end] UTC instants for the IST calendar day that
 * contains the given moment / "YYYY-MM-DD" string.
 *
 * Why this matters: callers often pass a bare date string from the client
 * (e.g. `data.date = "2026-06-11"`). `new Date("2026-06-11")` parses as
 * UTC midnight, which on a UTC server is 05:30 IST — so a naive
 * `setHours(0, 0, 0, 0)` window misses the 00:00–05:30 IST slice of that
 * day. Routing every per-date query through this helper makes the boundary
 * consistent with what a hospital receptionist actually means by "Jun 11".
 */
export function istDayRangeOf(input: Date | string): {
  start: Date;
  end: Date;
  label: string;
  isoDate: string;
} {
  // Parse "YYYY-MM-DD" explicitly as IST midnight rather than letting the
  // Date constructor pick UTC vs local.
  let isoDate: string;
  if (typeof input === 'string') {
    const m = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      isoDate = `${m[1]}-${m[2]}-${m[3]}`;
    } else {
      isoDate = isoDateFmt.format(new Date(input));
    }
  } else {
    isoDate = isoDateFmt.format(input);
  }
  // Build the IST-midnight UTC instant directly via the +05:30 ISO suffix.
  const start = new Date(`${isoDate}T00:00:00.000+05:30`);
  const end   = new Date(start.getTime() + DAY_MS - 1);
  return {
    start,
    end,
    label:   dayLabelFmt.format(start),
    isoDate,
  };
}
