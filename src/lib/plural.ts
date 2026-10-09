// Counts in words, for any string a person reads.
//
// One home because there were three identical copies of this -- in
// catalog-visibility-summary.ts, contacts-visibility.ts and act/run-record.ts
// -- and retyping the body is how they drift: the third copy arrived with a
// different locale in it, so one count would have printed differently from the
// other two for no reason anyone chose. Two copies existed because nobody had
// needed a third, not because three were wanted.
//
// "en-US" rather than the app's usual "en-AU" because that is what the first
// two copies had, and the grouping is identical in both (1,234) -- it is the
// separator that matters here, not the locale, so moving the copies to this
// module changes nothing anyone can see.
//
// The grouping earns its place at this scale: the first full ACT! import is
// ~17,500 contacts (17,529 measured in production on 2026-10-08), and "17,529
// updated" is read at a glance where "17529 updated" has to be counted.
//
// Imports nothing and touches no database, so it is usable from the
// no-database test suite.

/** A count with thousands separators: `7`, `17,529`. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** A count and its noun: `1 contact`, `17,529 contacts`. */
export function plural(value: number, one: string, many: string): string {
  return `${formatCount(value)} ${value === 1 ? one : many}`;
}
