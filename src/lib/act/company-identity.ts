// Decides which PathQuote company an incoming ACT! contact belongs to.
//
// This is its own module, and pure, because the decision is the part of the
// sync that went wrong and the part that cannot be checked by eye. It was first
// written inline in sync.ts, untested, as "look up by id, or else by key, then
// create" -- and that is not a safe reading of two unique columns.
//
// Company has two identities and both are @unique: actCompanyId (a real ACT!
// Company record, ~2.5% of contacts) and actCompanyKey (normalised name + ISO
// country, derived from free text for everyone else). A company can hold both.
// Looking up by only one of them and then creating let a contact linked to ACT!
// company A1 whose text said "Acme" miss on id, fall through to create, and
// collide with the "acme|AU" key an earlier unlinked contact had already
// stored. That raised Prisma P2002. It was a real run-ending failure, not a
// tidy-up: the error was uncaught, and since the cursor only moved after the
// last page every retry restarted from zero and died on the same record.
//
// The same shortcut had a second, quieter cost. A name that normalises to
// nothing carries no identity, and creating a company for it made a new,
// unreachable row on every run.
//
// INVARIANT: a `create` decision never has both identifiers null. A row with
// neither can never be found by any later lookup, so every later contact with
// the same name would create yet another one -- one client silently fragmented
// across hundreds of rows. When nothing identifies the company the answer is
// `skip`, never a create.
//
// This file does no I/O and imports nothing. The caller performs the two
// lookups (byId, byKey) and acts on the decision.

/** The subset of a PathQuote company row the decision needs. */
export type CompanyIdentity = {
  id: string;
  actCompanyId: string | null;
  actCompanyKey: string | null;
};

/** What the incoming contact says about its company. */
export type IncomingIdentity = {
  actCompanyId: string | null;
  actCompanyKey: string | null;
};

export type CompanyDecision =
  /** Attach to this existing company. */
  | { kind: "use"; id: string }
  /** Attach to this company and record the ACT! company id it was missing. */
  | { kind: "adopt"; id: string; actCompanyId: string }
  /** Create a company holding exactly these identifiers, which are not
   * necessarily the incoming ones: a key collision deliberately nulls the key. */
  | { kind: "create"; actCompanyId: string | null; actCompanyKey: string | null }
  /** Nothing identifies this company, so there is nothing to attach to. */
  | { kind: "skip" };

/** An empty string identifies nothing; treat it the same as null. */
function present(value: string | null): string | null {
  return value ? value : null;
}

/**
 * @param byId  the company whose actCompanyId equals the incoming one, if any
 * @param byKey the company whose actCompanyKey equals the incoming one, if any
 */
export function chooseCompany(
  incoming: IncomingIdentity,
  byId: CompanyIdentity | null,
  byKey: CompanyIdentity | null,
): CompanyDecision {
  const actCompanyId = present(incoming.actCompanyId);
  const actCompanyKey = present(incoming.actCompanyKey);

  // 1. An ACT! company id is the strongest identity there is.
  if (byId) return { kind: "use", id: byId.id };

  // 2. Nothing identifies this company.
  if (!actCompanyId && !actCompanyKey) return { kind: "skip" };

  // 3. The derived key already belongs to a row.
  if (byKey) {
    if (!byKey.actCompanyId) {
      // The row was derived from free text. If a real ACT! company has now
      // turned up for it, record that; otherwise it is simply the same firm.
      return actCompanyId
        ? { kind: "adopt", id: byKey.id, actCompanyId }
        : { kind: "use", id: byKey.id };
    }
    // The row is already linked to an ACT! company, and it is not this one
    // (byId would have matched). An unlinked contact's free text groups onto
    // the company that owns the key: that is the purpose of the derived key.
    if (!actCompanyId) return { kind: "use", id: byKey.id };
    // Two different ACT! companies whose names normalise to the same key. The
    // key cannot be shared; the ACT! company id is identity enough.
    return { kind: "create", actCompanyId, actCompanyKey: null };
  }

  // 4. Genuinely new.
  return { kind: "create", actCompanyId, actCompanyKey };
}
