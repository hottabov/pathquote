// Grouping contacts into companies.
//
// 12,088 of 12,094 active contacts carry a company name as free text and only
// 103 of the 9,622 distinct names match a real ACT! Company record, so the
// company a quote is addressed to is derived from this string. 85.8% of those
// names belong to exactly one contact, which means over-merging is the
// expensive mistake: two unrelated firms sharing a name become one client with
// one address.
//
// Country is therefore part of the key. 119 names (470 contacts) appear in
// more than one country, and while some of that is dirt that normalising the
// country already fixes, adient really does have offices in five.

/** Legal-form words that carry no identity. Order matters: the two-word forms
 * must be tried before the one-word forms, or "Pty Ltd" leaves a stray "pty". */
const LEGAL_SUFFIXES = [
  "pty ltd",
  "pty limited",
  "pty",
  "ltd",
  "limited",
  "llc",
  "l l c",
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "gmbh",
  "ag",
  "bv",
  "nv",
  "sa",
  "srl",
  "spa",
  "ab",
  "oy",
  "as",
  "plc",
  "co",
  "company",
  "group",
  "holdings",
  "international",
  "intl",
];

/**
 * Fold a company name to its identity: lowercase, punctuation out, legal form
 * out, whitespace collapsed. Ampersands survive because they are part of real
 * names ("Norco Composites & GRP") rather than decoration.
 *
 * Returns an empty string when nothing identifying is left, which the caller
 * must treat as "no company" rather than as a group everyone falls into.
 */
export function normaliseCompanyName(raw: string): string {
  let s = (raw ?? "").toLowerCase();
  s = s.replace(/[^\p{L}\p{N}&\s-]/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";

  // Strip suffixes from the end, repeatedly: "Acme Holdings Pty Ltd" sheds
  // three. Never strip the last remaining word, so a firm actually called
  // "Group" keeps its name.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s === suffix) break;
      if (s.endsWith(" " + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }

  return s.replace(/\s+/g, " ").trim();
}

/**
 * The identity of a derived company: normalised name and ISO country.
 *
 * `null` country becomes a literal `??` rather than being dropped, so
 * contacts whose country never resolved group together instead of silently
 * merging into whichever country happened to be first.
 *
 * Returns null when the name normalises to nothing — those contacts get no
 * company at all.
 */
export function companyKey(rawName: string, countryCode: string | null): string | null {
  const name = normaliseCompanyName(rawName);
  if (!name) return null;
  return `${name}|${countryCode ?? "??"}`;
}
