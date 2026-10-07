import { validatePhone } from "@/lib/phone";
import { normalizeCountryInput } from "@/lib/countries";

// PathQuote stores E.164. ACT! stores twenty years of typing: "03 94679176",
// "(317) 271-1207", "0 1621 840 077".
//
// libphonenumber resolves all of those, but only when told which country to
// assume -- the same digits are a different subscriber elsewhere, and without
// a region it simply refuses. The region comes from each contact's own country
// field, which is populated on 97% of records.
//
// Measured over the 12,094 active contacts: 88.8% resolve, 3.4% are junk
// (fewer than five digits, stray carriage returns), and 7.8% have digits that
// do not fit the country stated on the record -- usually because the country
// is wrong, not the number.
//
// Recovery rules beyond this ladder were tried and rejected. Treating a failed
// number as an international one that lost its "+" recovers 102 contacts and
// gets some of them wrong: "060 5286 3604" on a US contact becomes +60..., in
// Malaysia. A plausible wrong number on a signed quote is worse than a blank
// field, so unresolved numbers stay null and the contact is flagged instead.

/** Fewer digits than this cannot be a phone number in any plan. */
const MIN_DIGITS = 5;

/**
 * One ACT! phone string to E.164, or null.
 *
 * `rawCountry` is the contact's own country as ACT! stores it -- free text
 * like "Australia" or "USA", resolved to ISO-2 here.
 */
export function actPhoneToE164(
  raw: string | null | undefined,
  rawCountry: string | null | undefined,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < MIN_DIGITS) return null;

  // 1. Already international: the number carries its own country.
  if (trimmed.startsWith("+")) {
    const parsed = validatePhone(trimmed);
    return parsed.ok ? parsed.e164 : null;
  }

  // 2. National, read against the contact's own country.
  const region = normalizeCountryInput(rawCountry ?? null);
  if (!region) return null;

  const parsed = validatePhone(trimmed, region);
  return parsed.ok ? parsed.e164 : null;

  // 3. There is no step 3. See the note above on why.
}

/**
 * The contact's phone: the business number, falling back to the mobile when
 * there is no business number.
 *
 * Without the fallback 874 active contacts arrive with no number at all, which
 * is why PathQuote's single phone column reads two ACT! fields. It never
 * writes to either.
 */
export function contactPhone(
  businessPhone: string | null | undefined,
  mobilePhone: string | null | undefined,
  rawCountry: string | null | undefined,
): string | null {
  return (
    actPhoneToE164(businessPhone, rawCountry) ?? actPhoneToE164(mobilePhone, rawCountry)
  );
}
