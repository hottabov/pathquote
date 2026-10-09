// Money formatting shared by every catalog/browse/editor view. Prisma's
// Decimal fields (Price.amount) come through as Decimal-like objects (they
// stringify losslessly via toString()) rather than plain numbers, so this
// accepts anything with a numeric string representation.
export type Moneyish = number | string | { toString(): string };

/**
 * Format an amount as currency for display. Whole-number amounts render
 * without decimals (e.g. "A$175,000"); anything with a fractional part
 * keeps exactly 2 decimal places. Accepts a Prisma Decimal (or any
 * Decimal-like object) via its `toString()`.
 *
 * `symbol` overrides what Intl would put in front of the number — the region's
 * own `currencySymbol`, snapshotted onto each document (see
 * Region.currencySymbol in prisma/schema.prisma for why an admin ever wants
 * this). It replaces only the currency part; grouping, decimals and the sign's
 * position are still Intl's, so "-USD 1,234.50" becomes "-$1,234.50" rather
 * than something hand-spaced. Null/omitted keeps the derived symbol, which is
 * what every amount rendered before the column existed.
 */
export function formatMoney(
  amount: Moneyish,
  currency: string,
  symbol?: string | null,
  locale = "en-AU"
): string {
  const value = typeof amount === "number" ? amount : Number(amount.toString());
  const isWhole = Number.isInteger(value);

  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  }).formatToParts(value);

  return parts
    .map((part) => (part.type === "currency" && symbol ? symbol : part.value))
    .join("");
}

/**
 * The currency's bare symbol (e.g. "$", "A$", "£"). The region's own
 * `symbol` wins when it has one; otherwise it is derived from
 * `Intl.NumberFormat` rather than a hardcoded currency->symbol map, so a
 * distributor/region added later with an unusual currency code still gets a
 * sensible symbol for free. Used by the discount field's mode toggle (see
 * item-discount-field.tsx/document-discount-field.tsx) to label the "cash
 * amount" option next to "%". Falls back to the currency code itself if the
 * formatter's parts (for some exotic code) don't include one.
 *
 * Intl throws a RangeError on a malformed code rather than returning
 * anything, and one caller is a live text input the admin is still typing
 * into (the region form's placeholder), so an unparseable code degrades to
 * the code itself instead of taking the screen down.
 */
export function currencySymbol(currency: string, symbol?: string | null, locale = "en-AU"): string {
  if (symbol) return symbol;
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0);
  } catch {
    return currency;
  }
  return parts.find((part) => part.type === "currency")?.value ?? currency;
}

/**
 * True when a decimal-string money amount (e.g. `DocSheetLine.unitPrice` /
 * `.lineTotal`) is negative — a trade-in extra line (see `customLineSchema`
 * in src/lib/validation/documents.ts) is the only way this ever happens.
 * Used by the document/quotation sheets to give a negative line distinct
 * "cannot be misread as a charge" styling — `formatMoney` already renders
 * the leading `-` from `Intl.NumberFormat`, this just tells the caller
 * whether to also apply the muted treatment. A plain string sign check
 * (not `Number(value) < 0`) since the value is already a validated decimal
 * string, no float parsing needed.
 */
export function isNegativeAmount(value: string): boolean {
  return value.trim().startsWith("-");
}

/**
 * Formats a date as `DD/MM/YYYY` — the en-AU convention used throughout
 * document-facing dates (issue date, quote validity). Zero-padded by hand
 * rather than via `Intl.DateTimeFormat("en-AU")` so the exact digit order
 * and separator are guaranteed everywhere this renders — including inside
 * Gotenberg's headless Chromium, whose bundled ICU data this app doesn't
 * control — rather than depending on the host's CLDR data.
 */
export function formatDateAU(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Coarse "3 days ago" / "12 Jan 2026" relative display for list rows
 * (dashboard recent-documents, documents list) — not meant for anything
 * that needs precision down to the hour.
 */
export function relativeDate(date: Date): string {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * "2 hours ago" / "27 hours ago" / "3 days ago" — the same idea as
 * `relativeDate` above, but down to the minute and hour.
 *
 * Added for the ACT! sync section (Settings -> ACT! sync), which answers "is
 * this stale?" about a job that runs once a night. `relativeDate` cannot answer
 * it: a sync that ran at 03:00 and one that ran at 23:00 are both "Today", and
 * a reader looking at a stale page wants to know which.
 *
 * Hours run to 48 rather than rolling into days at 24, because the useful
 * reading of a nightly job is "27 hours ago" — it missed a night — where "1 day
 * ago" hides exactly that. Past two days it is days, where the hour stops
 * mattering.
 *
 * `now` is a parameter, not `new Date()` inside: that is what lets this be
 * tested at every boundary without fake timers, which this repo's test suite
 * does not have (see vitest.config.ts on `isolate: false`). A clock that is
 * behind the timestamp — a server and a database disagreeing by a second —
 * reads as "just now" rather than as a negative number of minutes.
 *
 * No date library, by instruction. `Intl.RelativeTimeFormat` would do the
 * wording, but it has to be told the unit and the number anyway, which is all
 * the arithmetic below, and it renders "in 2 hours" for the clock-skew case
 * this deliberately flattens.
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;

  const days = Math.round(hours / 24);
  return `${days} days ago`;
}
