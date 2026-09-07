import { cache } from "react";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DEFAULT_COMMISSION_TIERS, validateCommissionTiers, type CommissionTier } from "@/lib/pricing";

/** Lets a caller already inside a `db.$transaction(async (tx) => ...)` read a
 * setting through its own `tx` rather than the `db` singleton, which would see
 * a different snapshot and check out a second pool connection while the
 * transaction holds one. Structurally satisfied by both. Only
 * `getCommissionTiers` takes it so far, because only the recalc
 * (src/lib/documents/recalc.ts) reads a setting from inside a transaction. */
type SettingReader = { setting: Prisma.TransactionClient["setting"] };

const QUOTE_VALIDITY_SETTING_KEY = "quote.validityDays";

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
  const setting = await db.setting.findUnique({ where: { key: QUOTE_VALIDITY_SETTING_KEY } });
  const rawValue = setting?.value;
  return typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : DEFAULT_QUOTE_VALIDITY_DAYS;
});

const SHOW_OPTION_ICONS_SETTING_KEY = "ui.showOptionIcons";

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
  const setting = await db.setting.findUnique({ where: { key: SHOW_OPTION_ICONS_SETTING_KEY } });
  const rawValue = setting?.value;
  return typeof rawValue === "boolean" ? rawValue : DEFAULT_SHOW_OPTION_ICONS;
});

const COMMISSION_TIERS_SETTING_KEY = "commission.tiers";

/** Structural check only (shape, not the cross-row gap/overlap rules — see
 * `validateCommissionTiers` in src/lib/pricing.ts for those) that a
 * `Setting.value` read back from the database is actually a
 * `CommissionTier[]` before this module trusts it as one. Defensive: the
 * only writer already validates through `commissionTiersSchema`
 * (src/lib/validation/settings.ts), but a `Setting` row is a bare Json
 * column with nothing enforcing that at rest. */
function isCommissionTierArray(value: unknown): value is CommissionTier[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (typeof row !== "object" || row === null) return false;
      const r = row as Record<string, unknown>;
      return typeof r.minPct === "number" && (r.maxPct === null || typeof r.maxPct === "number") && typeof r.ratePct === "number";
    })
  );
}

/**
 * The admin-editable commission-rate table (`Setting` key
 * "commission.tiers"), read by `getDocumentForBuilder`'s commission
 * calculation (src/lib/queries/documents.ts) and by the Settings →
 * Preferences editor (`CommissionTiersForm`).
 *
 * Ships pre-filled: when no `Setting` row exists yet, this returns
 * `DEFAULT_COMMISSION_TIERS` (src/lib/pricing.ts), not an empty table — an
 * admin has to explicitly clear it (save an empty table) to reach "no
 * commission tiers configured". That empty-array state IS preserved and
 * returned here as `[]` (see `validateCommissionTiers`'s doc comment for
 * why saving one is allowed) — it's the only way `computeTotals` ends up
 * with `commission: null`, and that distinction — "cleared on purpose" vs.
 * "nothing saved yet" vs. "a real table" — is the whole point of not just
 * defaulting an unset row to `[]`.
 *
 * A row that's present but doesn't parse as a structurally sound, valid
 * `CommissionTier[]` (shouldn't happen — the only writer, `updateSetting`,
 * always validates through `commissionTiersSchema` first — but a `Setting`
 * row is a bare Json column with no constraint enforcing that at rest)
 * falls back to `DEFAULT_COMMISSION_TIERS` too, the same "invalid stored
 * value -> default" rule `getShowOptionIcons` above already follows —
 * never a table that could silently pay the wrong rate.
 */
export async function getCommissionTiers(client?: SettingReader): Promise<CommissionTier[]> {
  return client ? readCommissionTiers(client) : readDefaultCommissionTiers();
}

async function readCommissionTiers(client: SettingReader): Promise<CommissionTier[]> {
  const setting = await client.setting.findUnique({ where: { key: COMMISSION_TIERS_SETTING_KEY } });
  if (setting === null) return DEFAULT_COMMISSION_TIERS;

  const rawValue = setting.value;
  if (!isCommissionTierArray(rawValue)) return DEFAULT_COMMISSION_TIERS;
  if (validateCommissionTiers(rawValue) !== null) return DEFAULT_COMMISSION_TIERS;
  return rawValue;
}

/** Only the `db`-singleton read is request-memoized, and deliberately so:
 * a caller that hands in its own `client` is inside a transaction (see
 * `SettingReader` above), and a transaction's reads must stay that
 * transaction's, never answered from — or shared with — a memo the rest of
 * the request can reach. React's `cache` would in fact key a transaction
 * client apart from `db` (arguments are matched by identity, and Prisma
 * hands out a fresh `tx` per transaction), so wrapping the exported function
 * whole would not actually cross the two; splitting the memo off the
 * parameter says that in the code rather than resting it on that detail,
 * and keeps a caller's explicitly-passed `db` from quietly sharing the
 * singleton's memo either way. */
const readDefaultCommissionTiers = cache(async function readDefaultCommissionTiers(): Promise<
  CommissionTier[]
> {
  return readCommissionTiers(db);
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
 * `cache`d for the same reason `getQuoteValidityDays` is: the settings page
 * reads it while rendering a field that also needs the current value.
 */
export const getSigningLinkValidityDays = cache(async function getSigningLinkValidityDays(): Promise<number> {
  const setting = await db.setting.findUnique({ where: { key: SIGNING_LINK_VALIDITY_SETTING_KEY } });
  const rawValue = setting?.value;
  return typeof rawValue === "number" && Number.isFinite(rawValue)
    ? rawValue
    : DEFAULT_SIGNING_LINK_VALIDITY_DAYS;
});
