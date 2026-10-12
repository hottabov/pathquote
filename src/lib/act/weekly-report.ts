// The weekly activity report each sales manager gets from Act! on Monday
// morning: calls completed, e-mails sent, meetings held and new prospects, for
// the seven days before.
//
// Pure, like the rest of this directory: no network, no env, no transport.
// scripts/act-weekly-report.ts does the reading and the sending; everything
// that decides a number or a word in the email lives here, where it can be
// tested without the Act! box (which only answers the VPS).

import type { ActContact, ActHistory, ActUser } from "@/lib/act/types";

/** The office is in Melbourne, so "last week" is Melbourne's last week. */
export const REPORT_TIME_ZONE = "Australia/Melbourne";

/**
 * The rows of the report, in the order they print, keyed by Act! history type
 * id. The ids are stable Act! stock types, read off the box into
 * RAW/ACT/meta/history_types.json (docs/act-integration-reference.md
 * section 7); the labels are the type names as the managers see them in Act!.
 *
 * Only these exact types count. "Call Attempted", "Call Left Message",
 * "Meeting Not Held", "E-mail Not Sent" and the Act! Email Marketing types
 * (Email Sends / Open / Click) are deliberately left out: the report is what
 * the manager did, not what was tried or what a campaign tool recorded.
 */
export const ACTIVITY_ROWS = [
  { historyTypeId: 1, label: "Call Completed" },
  { historyTypeId: 16, label: "E-mail Sent" },
  { historyTypeId: 6, label: "Meeting Held" },
] as const;

export const PROSPECTS_LABEL = "Prospects generated";

/** A half-open interval of instants: `from` included, `to` excluded. */
export type ReportWindow = {
  from: Date;
  to: Date;
  /** "05.10-11.10": first and last calendar day, inclusive, as the email prints it. */
  label: string;
};

export type CalendarDate = { year: number; month: number; day: number };

// ---------------------------------------------------------------------------
// The window

/** Offset of `zone` from UTC at `instant`, in milliseconds (AEDT is +11h). */
function zoneOffsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - (instant - (instant % 1000));
}

/**
 * The instant a calendar day starts in `zone`.
 *
 * Two passes, because the offset to use is the one in force at the answer,
 * not at the first guess -- they differ on the two daylight-saving Sundays.
 * Melbourne changes clocks at 02:00/03:00, never at midnight, so midnight
 * always exists and is never doubled.
 */
export function startOfDay(date: CalendarDate, zone: string = REPORT_TIME_ZONE): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day);
  let instant = naive - zoneOffsetMs(naive, zone);
  instant = naive - zoneOffsetMs(instant, zone);
  return new Date(instant);
}

/** The calendar day `instant` falls on in `zone`. */
export function calendarDateIn(instant: Date, zone: string = REPORT_TIME_ZONE): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Calendar arithmetic, done in UTC so no zone can shift the day. */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dayMonth(date: CalendarDate): string {
  return `${pad(date.day)}.${pad(date.month)}`;
}

/** `YYYY-MM-DD`, strictly, and a day that exists. Null otherwise. */
export function parseCalendarDate(raw: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const roundTrip = addDays(date, 0);
  if (roundTrip.year !== date.year || roundTrip.month !== date.month || roundTrip.day !== date.day) {
    return null;
  }
  return date;
}

/**
 * First to last calendar day, both inclusive, as Melbourne days.
 *
 * Inclusive because that is how a person writes a period ("04.10 - 11.10")
 * and how the email prints it; the half-open instant range is derived here,
 * once, so nothing downstream has to remember to add a day.
 */
export function windowForDays(first: CalendarDate, last: CalendarDate, zone: string = REPORT_TIME_ZONE): ReportWindow {
  return {
    from: startOfDay(first, zone),
    to: startOfDay(addDays(last, 1), zone),
    label: `${dayMonth(first)}-${dayMonth(last)}`,
  };
}

/**
 * The scheduled window: the last complete Monday-to-Sunday week before `now`.
 *
 * Run on a Monday it is the seven days that ended at midnight. Run on any other
 * day -- a timer that fired late after the VPS was down -- it is still that same
 * week, never a week that has not finished.
 */
export function previousWeek(now: Date, zone: string = REPORT_TIME_ZONE): ReportWindow {
  const today = calendarDateIn(now, zone);
  // 0 = Monday ... 6 = Sunday.
  const weekday = (new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() + 6) % 7;
  const thisMonday = addDays(today, -weekday);
  return windowForDays(addDays(thisMonday, -7), addDays(thisMonday, -1), zone);
}

// ---------------------------------------------------------------------------
// Counting

export type ManagerCounts = {
  /** Keyed by history type id, one entry per ACTIVITY_ROWS row. */
  activities: Record<number, number>;
  prospects: number;
};

function inWindow(raw: string | null | undefined, window: ReportWindow): boolean {
  if (!raw) return false;
  const instant = Date.parse(raw);
  if (Number.isNaN(instant)) return false;
  return instant >= window.from.getTime() && instant < window.to.getTime();
}

/**
 * When a history record happened: its `startTime`, which is the Date column in
 * Act!'s History tab, falling back to `created` for a record that has none.
 */
export function historyMoment(history: ActHistory): string | null {
  return history.startTime || history.created || null;
}

/**
 * Count one manager's week.
 *
 * Attribution is Record Manager (`recordManagerID`, the uuid -- the display
 * name can be edited, the id cannot). That is who Act! shows as owning the
 * history entry, and it survives the entry arriving later through a laptop's
 * sync, where `createUserID` and `created` would not tell the same story.
 *
 * Both inputs may hold records outside the window or belonging to others: the
 * reader fetches generously and this decides. Records are de-duplicated by id
 * because `$skip` paging over equal sort keys can return one twice (section 10
 * of the reference).
 */
export function countForManager(
  managerId: string,
  histories: readonly ActHistory[],
  contacts: readonly ActContact[],
  window: ReportWindow,
): ManagerCounts {
  const activities: Record<number, number> = {};
  for (const row of ACTIVITY_ROWS) activities[row.historyTypeId] = 0;

  const seenHistory = new Set<string>();
  for (const history of histories) {
    if (seenHistory.has(history.id)) continue;
    seenHistory.add(history.id);
    if (history.recordManagerID !== managerId) continue;
    if (!(history.historyTypeID in activities)) continue;
    if (!inWindow(historyMoment(history), window)) continue;
    activities[history.historyTypeID] += 1;
  }

  // A prospect generated this week is a contact this manager owns, created in
  // the window, whose ID/Status is Prospect now. "Now" because Act! keeps no
  // history of the status: one created and promoted to Customer within the week
  // is not counted, which errs on the side of the smaller number.
  const seenContact = new Set<string>();
  let prospects = 0;
  for (const contact of contacts) {
    if (seenContact.has(contact.id)) continue;
    seenContact.add(contact.id);
    if (contact.recordManagerID !== managerId) continue;
    if (contact.idStatus !== "Prospect") continue;
    if (contact.contactType && contact.contactType !== "Contact") continue;
    if (!inWindow(contact.created, window)) continue;
    prospects += 1;
  }

  return { activities, prospects };
}

/**
 * Every history type this manager has in the window, with counts -- the ones the
 * report shows and the ones it leaves out. Printed by --dry-run so a number in
 * the email can be checked against what Act! actually holds.
 */
export function historyTypeBreakdown(
  managerId: string,
  histories: readonly ActHistory[],
  window: ReportWindow,
): Array<{ id: number; name: string; count: number }> {
  const byType = new Map<number, { id: number; name: string; count: number }>();
  const seen = new Set<string>();
  for (const history of histories) {
    if (seen.has(history.id)) continue;
    seen.add(history.id);
    if (history.recordManagerID !== managerId) continue;
    if (!inWindow(historyMoment(history), window)) continue;
    const entry = byType.get(history.historyTypeID) ?? {
      id: history.historyTypeID,
      name: history.historyType?.name ?? `type ${history.historyTypeID}`,
      count: 0,
    };
    entry.count += 1;
    byType.set(history.historyTypeID, entry);
  }
  return [...byType.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Recipients

export type ManagerConfig = {
  /** The Act! display name, exactly as in Manage Users. */
  actUser: string;
  /** Overrides the Act! user's own email when set. */
  to?: string;
  cc: readonly string[];
};

export type ResolvedManager = {
  actUserId: string;
  displayName: string;
  firstName: string;
  to: string;
  cc: string[];
};

export type ResolveResult = { ok: true; manager: ResolvedManager } | { ok: false; error: string };

/**
 * Join one configured manager to their Act! user. Exact display-name match,
 * nothing looser -- the same rule act:map-users uses, and for the same reason:
 * a near match would send one person another's numbers.
 */
export function resolveManager(config: ManagerConfig, users: readonly ActUser[]): ResolveResult {
  const matches = users.filter((user) => user.displayName === config.actUser);
  if (matches.length === 0) {
    return { ok: false, error: `no Act! user has the display name ${JSON.stringify(config.actUser)}` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `${matches.length} Act! users share the display name ${JSON.stringify(config.actUser)}` };
  }
  const user = matches[0];
  const to = (config.to ?? user.email ?? "").trim();
  if (!to) {
    return { ok: false, error: `${config.actUser} has no email in Act! and none is configured` };
  }
  const firstName = (user.firstName ?? "").trim() || config.actUser.split(" ")[0];
  return {
    ok: true,
    manager: {
      actUserId: user.id,
      displayName: config.actUser,
      firstName,
      to,
      cc: config.cc.map((address) => address.trim()).filter((address) => address && address !== to),
    },
  };
}

// ---------------------------------------------------------------------------
// The email

export type WeeklyReportEmail = { subject: string; text: string; html: string };

export const REPORT_SUBJECT = "Weekly activity report";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function reportRows(counts: ManagerCounts): Array<{ label: string; value: number }> {
  return [
    ...ACTIVITY_ROWS.map((row) => ({ label: row.label, value: counts.activities[row.historyTypeId] ?? 0 })),
    { label: PROSPECTS_LABEL, value: counts.prospects },
  ];
}

const INK = "#334155";
const RULE = "#cbd5e1";
const HEAD_BG = "#243478";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * The email, worded as the marketing team has been sending it by hand.
 *
 * Plain HTML with inline styles and a real <table>: Outlook renders with Word's
 * engine, which ignores <style> blocks, and a table is what survives being
 * forwarded or pasted into a spreadsheet.
 */
export function buildWeeklyReportEmail(input: {
  firstName: string;
  window: ReportWindow;
  counts: ManagerCounts;
}): WeeklyReportEmail {
  const rows = reportRows(input.counts);
  const name = input.firstName;

  const text = [
    `Hi ${name}!`,
    "",
    "I hope you are very well.",
    "",
    `Here are your weekly activities (${input.window.label}):`,
    "",
    ...rows.map((row) => `${row.label}: ${row.value}`),
  ].join("\n");

  const cell = `padding:8px 14px;border:1px solid ${RULE};font-size:14px;line-height:20px;`;
  const tableRows = rows
    .map(
      (row) =>
        `<tr><td style="${cell}">${escapeHtml(row.label)}</td><td style="${cell}text-align:right;font-weight:600;">${row.value}</td></tr>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="color-scheme" content="light" /></head>
  <body style="margin:0;padding:24px;background:#ffffff;color:${INK};font-family:${FONT};font-size:14px;line-height:22px;">
    <p style="margin:0 0 16px;">Hi ${escapeHtml(name)}!</p>
    <p style="margin:0 0 16px;">I hope you are very well.</p>
    <p style="margin:0 0 12px;">Here are your weekly activities (${escapeHtml(input.window.label)}):</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:280px;">
      <tr>
        <th align="left" bgcolor="${HEAD_BG}" style="${cell}background:${HEAD_BG};color:#ffffff;font-weight:600;">Activity</th>
        <th align="right" bgcolor="${HEAD_BG}" style="${cell}background:${HEAD_BG};color:#ffffff;font-weight:600;">Count</th>
      </tr>
${tableRows}
    </table>
  </body>
</html>
`;

  return { subject: REPORT_SUBJECT, text, html };
}

/**
 * "Pathfinder Marketing <noreply@q.pathfindercut.com>": the address from
 * EMAIL_FROM (the Resend-verified sending subdomain, the only domain Resend
 * will send from -- docs/email-sending-setup.md) under a name the managers
 * recognise instead of "PathQuote".
 */
export function reportFromAddress(emailFrom: string, displayName: string): string {
  const address = (/<([^>]+)>/.exec(emailFrom)?.[1] ?? emailFrom).trim();
  return `${displayName} <${address}>`;
}
