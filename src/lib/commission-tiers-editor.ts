// The pure half of the per-user commission editor (CommissionTiersForm,
// src/components/users/commission-tiers-form.tsx): what the admin types, and
// how it becomes the `CommissionTier[]` that `User.commissionTiers` stores.
// No React and no database here, so every rule below is unit-tested.
//
// The admin types where each row STARTS ("discount from") and the rate it
// earns. Where a row ends is never typed: it runs up to one hundredth of a
// percent before the next row starts, and the last row runs "and above". The
// first row always starts at 0%. Together those make a gap or an overlap
// impossible to type -- every discount from 0% upward lands in exactly one
// row, so a quote at list price can never fall through to "no commission".
// `validateCommissionTiers` (src/lib/pricing.ts) still checks the saved
// table server-side.
//
// Typing starts rather than ends is deliberate: it is how the owner's own
// table reads ("5.01% to 10% earns 4.5%", "15.01% and above earns 4%"), so
// every number in it is one the admin types as written.
import { type CommissionTier } from "@/lib/pricing";

/** One row as the form holds it: two text fields, exactly as typed. */
export type TierRowInput = { fromPct: string; ratePct: string };

/** The table as editable rows. An empty table is no rows. */
export function rowsFromTiers(tiers: readonly CommissionTier[]): TierRowInput[] {
  return tiers.map((tier) => ({ fromPct: String(tier.minPct), ratePct: String(tier.ratePct) }));
}

/** The one-row table for a manager paid the same rate whatever the discount. */
export function flatRateRows(ratePct = ""): TierRowInput[] {
  return [{ fromPct: "0", ratePct }];
}

const toHundredths = (pct: number) => Math.round(pct * 100);
const fromHundredths = (hundredths: number) => hundredths / 100;

/** A typed percentage as hundredths of a percent, or null when it is not a
 * number from 0 to 100 with at most two decimals. */
function parsePct(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  const hundredths = toHundredths(value);
  if (Math.abs(hundredths - value * 100) > 1e-6) return null;
  return hundredths;
}

/** Each row's start, in hundredths, as far as it can be read -- the first row
 * is always 0, whatever its field holds; null for a start that is not a
 * valid percentage yet. */
function startsOf(rows: readonly TierRowInput[]): (number | null)[] {
  return rows.map((row, index) => (index === 0 ? 0 : parsePct(row.fromPct)));
}

/**
 * Where row `index` ends, for display beside it: "and above" for the last
 * row, otherwise one hundredth below the next row's start ("4.99%"). `null`
 * while the next row's start is not a usable number yet -- the form shows a
 * placeholder rather than a wrong range.
 */
export function rowEndLabel(rows: readonly TierRowInput[], index: number): string | null {
  if (index === rows.length - 1) return "and above";
  const nextStart = startsOf(rows)[index + 1];
  const start = startsOf(rows)[index];
  if (nextStart === null || start === null || nextStart <= start) return null;
  return `${fromHundredths(nextStart - 1)}%`;
}

/**
 * The typed rows as the table to save, or the first thing wrong with them,
 * worded for the admin. No rows is a valid table: no commission.
 */
export function tiersFromRows(rows: readonly TierRowInput[]): { tiers: CommissionTier[] } | { error: string } {
  const starts = startsOf(rows);

  for (let i = 0; i < rows.length; i++) {
    const n = i + 1;
    if (i > 0) {
      const start = starts[i];
      if (start === null) {
        return { error: `Row ${n}: enter where it starts — a discount from 0.01% to 100%, up to two decimals.` };
      }
      const prev = starts[i - 1] as number;
      if (start <= prev) {
        return {
          error: `Row ${n} must start above row ${i} (${fromHundredths(prev)}%). Rows go from the smallest discount to the largest.`,
        };
      }
    }
    if (parsePct(rows[i].ratePct) === null) {
      return { error: `Row ${n}: enter the commission rate — 0% to 100%, up to two decimals.` };
    }
  }

  const tiers = rows.map((row, i): CommissionTier => {
    const start = starts[i] as number;
    const nextStart = i + 1 < rows.length ? (starts[i + 1] as number) : null;
    return {
      minPct: fromHundredths(start),
      maxPct: nextStart === null ? null : fromHundredths(nextStart - 1),
      ratePct: fromHundredths(parsePct(row.ratePct) as number),
    };
  });
  return { tiers };
}
