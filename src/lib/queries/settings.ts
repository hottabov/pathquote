import { cache } from "react";
import { db } from "@/lib/db";

const QUOTE_VALIDITY_SETTING_KEY = "quote.validityDays";
const SHOW_OPTION_ICONS_SETTING_KEY = "ui.showOptionIcons";
/**
 * The three settings this module serves, read in ONE query per render and
 * memoised on the request: the builder page used to read two of them as two
 * separate `findUnique`s on every render (and on every autosave's re-render).
 * Same `cache` semantics as before -- it lives on the Flight render request,
 * so a server action never sees a pre-write value on the re-render that
 * follows. A missing row simply has no entry, and each getter below applies
 * its own default.
 */
const loadSettings = cache(async function loadSettings(): Promise<Map<string, unknown>> {
  const rows = await db.setting.findMany({
    where: { key: { in: [QUOTE_VALIDITY_SETTING_KEY, SHOW_OPTION_ICONS_SETTING_KEY, SIGNING_LINK_VALIDITY_SETTING_KEY] } },
    select: { key: true, value: true },
  });
  return new Map(rows.map((row) => [row.key, row.value as unknown]));
});

/** Fallback used when no `Setting` row exists for "quote.validityDays" (or
 * its value isn't a finite number) — quotes are valid for a week by
 * default. Exported so the settings page can render this as the field's
 * placeholder/default without duplicating the number. */
export const DEFAULT_QUOTE_VALIDITY_DAYS = 7;

/**
 * Number of days a finalized QUOTE stays valid for, read from the
 * `Setting` table (key "quote.validityDays"). Falls back to
 * `DEFAULT_QUOTE_VALIDITY_DAYS` when no row exists yet or its stored value
 * isn't a finite number (defensive — the only writer, `updateSetting` in
 * src/lib/actions/settings.ts, always validates through
 * `quoteValidityDaysSchema` first).
 *
 * Shared by `finalizeDocument` (src/lib/actions/finalize.ts, which freezes
 * this onto `Document.validityDays` for QUOTE documents) and the main
 * /settings page (which displays/edits it) — pulled out here so both read
 * the same fallback logic instead of duplicating it.
 *
 * Wrapped in React's `cache` because a single document-builder render reads
 * it twice over — once directly for the org-default the validity field shows,
 * once inside `getDocumentForBuilder` for `defaultValidityDays` — and neither
 * caller can see the other's result. The memo lives on the Flight render
 * request, so it dedupes within one page render (`generateMetadata` and the
 * page body included, since Next renders both in the same request) and cannot
 * outlive it: a server action runs outside any render, where `cache` is an
 * inert passthrough, so a settings save is never served its own pre-write
 * value on the re-render that follows.
 */
export const getQuoteValidityDays = cache(async function getQuoteValidityDays(): Promise<number> {
  const rawValue = (await loadSettings()).get(QUOTE_VALIDITY_SETTING_KEY);
  return typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : DEFAULT_QUOTE_VALIDITY_DAYS;
});

/** Default used when no `Setting` row exists for "ui.showOptionIcons" (or
 * its stored value isn't a boolean) — icons are shown by default. */
export const DEFAULT_SHOW_OPTION_ICONS = true;

/**
 * Whether the builder's per-item options editor (`ItemOptionsEditor`) shows
 * each compatible option's small icon, read from the `Setting` table (key
 * "ui.showOptionIcons"). Falls back to `DEFAULT_SHOW_OPTION_ICONS` when no
 * row exists yet or its stored value isn't a boolean (defensive — the only
 * writer, `updateSetting` in src/lib/actions/settings.ts, always validates
 * through `showOptionIconsSchema` first).
 *
 * Read server-side by the document builder page, which passes the result
 * down through `ItemsSection` -> `ItemsList` -> `ItemOptionsEditor`, and by
 * the main /settings page (which displays/edits it).
 *
 * Request-memoized for the same reason `getQuoteValidityDays` above is — see
 * that function's doc comment for why the memo can't outlive one render.
 */
export const getShowOptionIcons = cache(async function getShowOptionIcons(): Promise<boolean> {
  const rawValue = (await loadSettings()).get(SHOW_OPTION_ICONS_SETTING_KEY);
  return typeof rawValue === "boolean" ? rawValue : DEFAULT_SHOW_OPTION_ICONS;
});

const SIGNING_LINK_VALIDITY_SETTING_KEY = "signing.linkValidityDays";

/** Fallback when no `Setting` row exists for "signing.linkValidityDays" (or
 * its value isn't a finite number). Thirty days is long enough for a quote
 * to survive a client's holiday and short enough that a forwarded link stops
 * being a credential. Exported so the settings form can show it as the
 * field's placeholder without duplicating the number. */
export const DEFAULT_SIGNING_LINK_VALIDITY_DAYS = 30;

/**
 * How long a newly-issued client signing link stays usable. Read once per
 * send by `sendQuoteForSignature` (src/lib/actions/signing.ts) and frozen
 * into `SigningRequest.expiresAt` — never read again when resolving an
 * existing link, which is what stops a lowered setting from retroactively
 * killing outstanding links.
 *
 * Wrapped in `cache` to match its sibling `getQuoteValidityDays`, not because
 * the same justification applies: that wrapper earns its keep because
 * `getQuoteValidityDays` is genuinely read twice per document-builder render
 * from two call sites that can't see each other. This function has no such
 * caller today — the settings page reads it once — so the wrapper is
 * harmless rather than load-bearing. Its real future caller,
 * `sendQuoteForSignature` (Task 10), is a server action, where `cache` is an
 * inert passthrough (see `getQuoteValidityDays`'s own comment), so the memo
 * does nothing there either. Kept anyway for symmetry with its sibling, not
 * because a justification was found that actually holds.
 */
export const getSigningLinkValidityDays = cache(async function getSigningLinkValidityDays(): Promise<number> {
  const rawValue = (await loadSettings()).get(SIGNING_LINK_VALIDITY_SETTING_KEY);
  return typeof rawValue === "number" && Number.isFinite(rawValue)
    ? rawValue
    : DEFAULT_SIGNING_LINK_VALIDITY_DAYS;
});
