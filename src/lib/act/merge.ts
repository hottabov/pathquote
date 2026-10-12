// The one place that decides whether a sync may change an existing value.
//
// It may not. A sync fills blanks and nothing else: what a salesperson typed
// into PathQuote is never silently replaced by what ACT! happens to hold. The
// full ACT! payload is kept in the ActSnapshot table, so a divergence can be
// shown to a person without either version being destroyed.
//
// Kept as one tiny function rather than inlined at each call site so that
// "can a sync overwrite this?" has exactly one answer, and changing it is a
// decision rather than an oversight in one branch.
//
// Beside it, changedInAct: the other question the read asks of a contact it
// already holds -- not what it may write, but whether anything happened in
// ACT! to report.

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * The subset of `incoming` that may be written over `existing`: fields listed
 * in `fields` that are blank on the existing record and non-blank on the
 * incoming one.
 *
 * Returns a patch, not a merged record, so a caller can tell "nothing changed"
 * from "changed back to the same value" and skip the write entirely.
 */
export function fillOnlyEmpty<T extends Record<string, unknown>>(
  existing: Partial<T>,
  incoming: Partial<T>,
  fields: readonly (keyof T)[],
): Partial<T> {
  const patch: Partial<T> = {};
  for (const field of fields) {
    if (!isBlank(existing[field])) continue;
    if (isBlank(incoming[field])) continue;
    patch[field] = incoming[field];
  }
  return patch;
}

/**
 * Whether a contact PathQuote already holds has been edited in ACT! since
 * PathQuote last stored it: its incoming `edited` differs from the stored
 * actSourceEditedAt. What the inbound read counts as "updated"
 * (syncContacts in src/lib/act/sync.ts).
 *
 * The same `edited` is one of two things, neither of them an edit:
 *
 *   - PathQuote's own write coming back. The drain stores the `edited` ACT!
 *     answers a contact create or promotion with (storeContactCreated and
 *     promoteContact in src/lib/act/drain.ts), and the write moved ACT!'s
 *     `edited` past the cursor, so the next read fetches the contact and
 *     finds the value it already has.
 *   - The boundary record. The cursor is the newest `edited` stored and the
 *     filter is `edited ge` (the header of sync.ts says why not `gt`), so
 *     every run reads the previous run's newest record again, unchanged.
 *
 * It cannot hide a real edit. A save in ACT! moves `edited` -- that is what
 * makes it the cursor -- so an edited record arrives with a value it did not
 * have when it was stored; and an edit that left `edited` where it was would
 * not be fetched by the cursor in the first place, so there would be nothing
 * here to count.
 *
 * Nothing stored (null: a contact whose `edited` PathQuote never learned,
 * such as one the drain created from an id with no record behind it) counts
 * as changed, and so does an `edited` that is not a date: when in doubt, say
 * something happened. Compared as milliseconds, which is what both sides
 * hold -- a JS Date, and a timestamp(3) column.
 */
export function changedInAct(storedEditedAt: Date | null, incomingEditedAt: Date): boolean {
  if (storedEditedAt === null) return true;
  const incoming = incomingEditedAt.getTime();
  if (Number.isNaN(incoming)) return true;
  return storedEditedAt.getTime() !== incoming;
}
