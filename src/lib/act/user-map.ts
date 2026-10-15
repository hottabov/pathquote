// Decide which ACT! user, if any, each PathQuote user is.
//
// This module is the decision half of `npm run act:map-users`;
// scripts/map-act-users.ts is the I/O around it. It and the hand link below
// are the only things that populate User.actUserId, and without it every
// record PathQuote creates in ACT! is owned by the integration account (the
// ACT_USER login) -- twelve managers' quotes showing up as one person's
// pipeline.
//
// Users can also be linked BY HAND, in Settings -> Users -> <user> -> ACT!
// (src/lib/act/user-link.ts), which is how distributors are linked: their ACT!
// users have no email and are Inactive, so this email join cannot reach them.
// This script never overwrites a stored link: it writes each column only
// where it is still null. A hand link to an ACT! user whose email is not the
// person's -- a distributor's, with none -- is reported under DRIFT and left
// alone, and its Acc Mgr is never filled in from here. A hand link to the
// ACT! user with the person's own email is `already mapped`, and `--apply`
// then fills an empty Acc Mgr with that user's exact Rep item, as for any
// mapped row.
//
// Pure and tested for the same reason preflight.ts is: the risk in the script
// is writing the wrong value onto the wrong person, in either column, and that
// decision can be checked without a database or a network.
//
// The join key is email, case-insensitively and trimmed, and there is no
// fallback to a name. A name match would silently pick a person where an email
// match either holds or does not, and person-names in this database are not
// typed consistently enough to carry it: the Account Mgr column of the
// 17,373-contact export holds `john hollo`, `john Hollo`, `John kyprianou`,
// `john kyprianou`, `chris Gilmartin` and `mike Collins` beside their
// properly-cased spellings, and `Kevin Du Plessis` where the Act! user is
// `Kevin du Plessis`. An Act! user with no email is therefore matched to
// nobody, which is reported rather than worked around.
//
// User.actAccountMgr is decided here too, on a different key and under a
// stricter rule: an Act! user's display name must equal an item of the `Rep`
// picklist exactly, or nothing is written for that person. See
// matchAccountMgr.

/** The subset of an Act! /api/users row the decision needs. */
export type ActUserRow = {
  /** The uuid. This is what goes in User.actUserId: it is the stable half of
   * Record Manager, the display name is not. */
  id: string;
  displayName: string | null;
  /** Null for 3 of the 20 users read on 2026-10-02. Those cannot be joined. */
  email: string | null;
  /** `Active` or `Inactive` in the live data -- 11 of 20 were Inactive. */
  status: string | null;
  /** `Standard`, `Browse` or `Administrator`. Reported, never matched on. */
  role: string | null;
};

/** The subset of a PathQuote User row the decision needs. */
export type PathQuoteUserRow = {
  id: string;
  /** `User.email` is @unique, and userEmailSchema lowercases on the way in. */
  email: string;
  name: string | null;
  role: string;
  /** PathQuote's own flag: false means the person cannot sign in. */
  active: boolean;
  /** What is stored now. Non-null means a previous run, or a person, mapped it. */
  actUserId: string | null;
  /** The stored Account Mgr value. Non-null is never overwritten here. */
  actAccountMgr: string | null;
};

/**
 * One item of the Act! `Rep` picklist, which is the vocabulary Account Mgr is
 * limited to. `value` is the string the field will accept.
 */
export type RepPicklistItem = {
  id: string;
  value: string | null;
  /** Free text beside the item in Act!. Empty on every item read so far, but
   *  it is the only place a distributor item could say it is one, so it is
   *  carried through to the report. */
  description: string | null;
};

/**
 * Which `Rep` item, if any, is this Act! user's Account Mgr value.
 *
 * `exact`  the display name equals an item's value, byte for byte. The only
 *          case that is written, and what is written is the item's `value`,
 *          never the display name -- they are equal here, and taking it from
 *          the picklist is what keeps that true if this ever loosens.
 * `near`   an item matches once case and surrounding whitespace are ignored,
 *          and nothing matches exactly. Reported loudly, written never. This is
 *          the Kevin du Plessis shape: the Act! user is `Kevin du Plessis` and
 *          the hand-typed Account Mgr value on 77 contacts is
 *          `Kevin Du Plessis`.
 * `none`   no item resembles this display name. This is the list an
 *          administrator has to add to.
 */
export type AccountMgrMatch =
  | { kind: "exact"; value: string; item: RepPicklistItem }
  | { kind: "near"; items: RepPicklistItem[] }
  | { kind: "none" };

/** A PathQuote user paired with the Act! user it resolved to, and with what
 *  that Act! user's Account Mgr value would be. */
export type MatchedEntry = {
  user: PathQuoteUserRow;
  actUser: ActUserRow;
  accountMgr: AccountMgrMatch;
};

/**
 * Two readings of "ambiguous", both of which mean no write.
 *
 * `two-act-users`: two Act! users share one email address. Which of them owns
 * this person's records is not derivable from the data, and guessing attaches a
 * pipeline to the wrong account.
 *
 * `two-pathquote-users`: two PathQuote rows fold to the same email. The schema
 * makes the exact duplicate impossible -- `User.email` is `@unique` (see
 * prisma/schema.prisma, `model User`) -- so this can only arise from case:
 * Postgres compares the unique index byte-for-byte, so `A@x.com` and `a@x.com`
 * are two legal rows that this module's case-insensitive key folds into one.
 * `User.actUserId` is `@unique` as well, so only one of them could hold the id
 * and the second write would fail on the constraint. Which one deserves it is a
 * person's call.
 */
export type AmbiguousEntry =
  | { user: PathQuoteUserRow; reason: "two-act-users"; candidates: ActUserRow[] }
  | {
      user: PathQuoteUserRow;
      reason: "two-pathquote-users";
      actUser: ActUserRow;
      /** The other PathQuote rows folding to the same email, this one excluded. */
      rivals: PathQuoteUserRow[];
    };

/**
 * A stored mapping that no longer describes reality. None is repaired
 * automatically: an Act! user id that changed hands means records are already
 * attributed to the wrong person, and that is a conversation, not a migration.
 */
export type DriftEntry =
  /** The stored id is not in the Act! user list at all -- deleted, or a
   *  different database. */
  | { user: PathQuoteUserRow; reason: "stored-id-missing"; storedActUserId: string }
  /** The stored id exists but its email is not this person's any more. */
  | {
      user: PathQuoteUserRow;
      reason: "stored-id-other-email";
      storedActUser: ActUserRow;
      /** Every Act! user this person's email points at now: none, one, or --
       *  if Act! has a duplicate -- more than one. */
      matchedByEmail: ActUserRow[];
    }
  /** This person's email matches an Act! user whose id is already stored on a
   *  different PathQuote row. `User.actUserId` is @unique, so the write would
   *  fail on the constraint; it is held back and named instead. */
  | {
      user: PathQuoteUserRow;
      reason: "target-held-by-another-user";
      actUser: ActUserRow;
      heldBy: PathQuoteUserRow;
    };

/** Why an Act! user joined to nobody. Informational: nothing is written for
 *  these, and PathQuote has fewer users than Act! does by design. */
export type UnusedActUser = {
  actUser: ActUserRow;
  reason: "no-email" | "no-pathquote-user";
};

/** One line per PathQuote user, which is what makes the report readable. */
export type Outcome =
  | "already-mapped"
  | "match"
  | "inactive-match"
  | "ambiguous"
  | "unmatched"
  | "drift";

export type OutcomeLine = {
  user: PathQuoteUserRow;
  outcome: Outcome;
  /** A short factual detail: the Act! user, or what went wrong. */
  detail: string;
};

/**
 * A confirmed Act! user with no Account Mgr value to write. Nothing is written
 * for these; the list is what an administrator has to act on, either by adding
 * the item to the `Rep` picklist or by correcting the one that nearly matches.
 */
export type AccountMgrGap = {
  user: PathQuoteUserRow;
  actUser: ActUserRow;
  /** Why there is nothing to write. An exact match is not a gap. */
  match: Extract<AccountMgrMatch, { kind: "near" } | { kind: "none" }>;
  /** The row's own outcome, so the report can say whether the row is being
   *  mapped at all -- a gap on a held-back inactive match is less urgent than
   *  one on a manager being mapped today. */
  outcome: Outcome;
};

/** A row that already holds an Account Mgr value other than the item its Act!
 *  user resolves to. Reported, never overwritten: somebody typed that value,
 *  and replacing it moves clients between managers. */
export type AccountMgrConflict = {
  user: PathQuoteUserRow;
  actUser: ActUserRow;
  stored: string;
  /** The exact picklist item this Act! user matches. */
  value: string;
};

export type UserMapPlan = {
  /** Every PathQuote user read. Always equals `outcomes.length`, and the sum of
   *  the six category lengths below. */
  pathQuoteUsers: number;
  /** Every Act! user read, inactive ones and the integration account included. */
  actUsers: number;
  /** Stored id still resolves to this person. No write; this is what makes a
   *  second run a no-op. */
  alreadyMapped: MatchedEntry[];
  /** The only group `--apply` writes. */
  matched: MatchedEntry[];
  /** Matched, but the Act! user is not Active. Held back by default: a record
   *  owned by a disabled user is a support call. */
  inactiveMatched: MatchedEntry[];
  ambiguous: AmbiguousEntry[];
  /** Email matches no Act! user. Reported, never written. */
  unmatched: PathQuoteUserRow[];
  drift: DriftEntry[];
  unusedActUsers: UnusedActUser[];
  /** Every PathQuote user, email order, one entry each. */
  outcomes: OutcomeLine[];
  /** How many `Rep` picklist items this plan was given. Reported so a run that
   *  resolved nothing says whether the picklist was empty or simply never
   *  read. */
  repPicklistItems: number;
  /** Confirmed Act! users with no exact picklist item, email order. */
  accountMgrGaps: AccountMgrGap[];
  accountMgrConflicts: AccountMgrConflict[];
  /** Picklist items that are no Act! user's display name -- the distributors
   *  somebody added by hand, and anything stale. Context only. */
  unusedRepItems: RepPicklistItem[];
};

/** The join key. An address that trims to nothing is no key at all. */
function emailKey(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Trimmed and lower-cased, for comparing a display name against a picklist
 *  item when the question is "is this nearly the same string". Never used to
 *  decide a write. */
function looseKey(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Which `Rep` picklist item is this Act! user's Account Mgr value.
 *
 * STRICT WRITE, LOUD REPORT, and the asymmetry is the whole design.
 *
 * Account Mgr is `customFields/rep`, a Character(50) field whose picklist has
 * `isLimitToList: true` (RAW/ACT/meta/fields_contact.json, read off the
 * production box), so the only strings Act! will accept in it are the
 * picklist's item values. PathQuote decides client visibility on the same
 * column (prisma/schema.prisma, `Contact.actAccountMgr`). A wrong value here
 * therefore does not fail loudly, it hands one manager another manager's
 * clients -- which is strictly worse than a null, because a null is visibly
 * missing and a plausible wrong name is not.
 *
 * So only an exact match is written. A case-insensitive or trimmed match is
 * reported and never written, for a reason this data demonstrates rather than
 * a reason of principle: the Act! user is `Kevin du Plessis`, the Account Mgr
 * value somebody typed onto 77 contacts is `Kevin Du Plessis`, and those two
 * spellings are not interchangeable in a field limited to a list -- one of them
 * is an item and the other is not. Normalising would make this function answer
 * "yes, write it" for a string the picklist may not contain, and `isLimitToList`
 * means Act! would reject the write at the far end, or worse, the item does
 * exist under the other spelling and belongs to a different convention than
 * ours. Reporting the near-match instead puts the two spellings side by side so
 * a person can fix the picklist or the user, which takes one edit in Act! and
 * then this function says yes on its own.
 *
 * What gets written is the item's `value`, not the display name. They are equal
 * in the `exact` branch, so today it makes no difference; it is taken from the
 * picklist because the picklist is the authority on what the field accepts, and
 * that stays correct if this ever has to grow a looser rule.
 */
export function matchAccountMgr(
  displayName: string | null,
  items: readonly RepPicklistItem[],
): AccountMgrMatch {
  if (!displayName) return { kind: "none" };

  for (const item of items) {
    if (item.value !== null && item.value === displayName) {
      return { kind: "exact", value: item.value, item };
    }
  }

  const key = looseKey(displayName);
  if (key === null) return { kind: "none" };
  const near = items.filter((item) => looseKey(item.value) === key);
  return near.length > 0 ? { kind: "near", items: near } : { kind: "none" };
}

/**
 * Whether an Act! user is one we are willing to attribute a record to.
 *
 * Only an explicit status that is not `Active` holds a match back. A missing or
 * empty status is treated as active and said so on the report line, which is
 * the deliberate direction: if an Act! upgrade renamed or dropped the field,
 * the strict reading would hold back all twenty users and the mapping would
 * stop working entirely, whereas the lenient reading maps them and leaves the
 * words "status not reported" on every line for whoever reads it.
 */
function isActive(status: string | null): boolean {
  const value = status?.trim();
  if (!value) return true;
  return value.toLowerCase() === "active";
}

function describeActUser(actUser: ActUserRow): string {
  const name = actUser.displayName?.trim() || "(no display name)";
  const email = actUser.email?.trim() || "(no email)";
  const status = actUser.status?.trim() || "status not reported";
  const role = actUser.role?.trim() || "role not reported";
  return `${name} <${email}>  ${status}, ${role}  ${actUser.id}`;
}

function describePathQuoteUser(user: PathQuoteUserRow): string {
  const name = user.name?.trim() || "(no name)";
  const inactive = user.active ? "" : "  INACTIVE in PathQuote";
  return `${user.email}  ${name}  ${user.role}${inactive}`;
}

function byEmail(a: { email: string }, b: { email: string }): number {
  return a.email.localeCompare(b.email);
}

function byActUser(a: ActUserRow, b: ActUserRow): number {
  return (a.displayName ?? "").localeCompare(b.displayName ?? "") || a.id.localeCompare(b.id);
}

/**
 * Sort every PathQuote user into exactly one group.
 *
 * Reading order per user, because the order is the specification:
 *
 *  1. A stored actUserId is checked first, so a run is idempotent. If the
 *     stored id is in the Act! list and its email still folds to this person's,
 *     the row is `alreadyMapped` and nothing is written. If it is not in the
 *     list, or belongs to a different email now, it is `drift` -- never
 *     silently re-pointed.
 *  2. Otherwise match on the folded email. No match at all is `unmatched`.
 *  3. Two Act! users on that email, or two PathQuote rows folding to it, is
 *     `ambiguous`.
 *  4. A match whose id is already stored on another PathQuote row is `drift`,
 *     because User.actUserId is @unique and the write could not succeed.
 *  5. A match to an Act! user that is not Active is `inactiveMatched`.
 *  6. Anything left is `matched`, the one group that gets written.
 *
 * Act! users with no email are never matched to anyone. They cannot be, and
 * there is no weaker key here to fall back to -- see the file header for why
 * display names are not one.
 *
 * `repPicklist` is the `Rep` picklist's items, read from the API by the caller.
 * It decides Account Mgr and nothing else: it cannot make a row match, unmatch,
 * or change group. Defaulting to empty means "no item is known", which makes
 * every Account Mgr value unwritable -- the safe direction, and the report says
 * how many items it had so an empty one is not mistaken for a resolved one.
 */
export function planUserMap(
  actUsers: readonly ActUserRow[],
  pathQuoteUsers: readonly PathQuoteUserRow[],
  repPicklist: readonly RepPicklistItem[] = [],
): UserMapPlan {
  const actById = new Map<string, ActUserRow>();
  for (const actUser of actUsers) actById.set(actUser.id, actUser);

  // Every Act! user on each email key, so two users sharing one address are
  // visible as two rather than one overwriting the other.
  const actByEmail = new Map<string, ActUserRow[]>();
  for (const actUser of actUsers) {
    const key = emailKey(actUser.email);
    if (!key) continue;
    const group = actByEmail.get(key);
    if (group) group.push(actUser);
    else actByEmail.set(key, [actUser]);
  }

  // The same for PathQuote, to catch the case-fold collision the unique index
  // on User.email does not prevent.
  const pqByEmail = new Map<string, PathQuoteUserRow[]>();
  for (const user of pathQuoteUsers) {
    const key = emailKey(user.email);
    if (!key) continue;
    const group = pqByEmail.get(key);
    if (group) group.push(user);
    else pqByEmail.set(key, [user]);
  }

  // Which Act! ids are already spoken for, and by whom. Read from the stored
  // column, not from this run's decisions: a row this run would write is in
  // `matched` precisely because its id was free.
  const storedBy = new Map<string, PathQuoteUserRow>();
  for (const user of pathQuoteUsers) {
    if (user.actUserId && !storedBy.has(user.actUserId)) storedBy.set(user.actUserId, user);
  }

  const alreadyMapped: MatchedEntry[] = [];
  const matched: MatchedEntry[] = [];
  const inactiveMatched: MatchedEntry[] = [];
  const ambiguous: AmbiguousEntry[] = [];
  const unmatched: PathQuoteUserRow[] = [];
  const drift: DriftEntry[] = [];
  const outcomes: OutcomeLine[] = [];

  const sortedUsers = [...pathQuoteUsers].sort(byEmail);

  for (const user of sortedUsers) {
    const key = emailKey(user.email);
    const candidates = key ? (actByEmail.get(key) ?? []) : [];

    if (user.actUserId) {
      const stored = actById.get(user.actUserId);
      if (!stored) {
        drift.push({ user, reason: "stored-id-missing", storedActUserId: user.actUserId });
        outcomes.push({
          user,
          outcome: "drift",
          detail: `stored ${user.actUserId} is not an Act! user any more`,
        });
        continue;
      }
      if (key && emailKey(stored.email) === key) {
        alreadyMapped.push({
          user,
          actUser: stored,
          accountMgr: matchAccountMgr(stored.displayName, repPicklist),
        });
        outcomes.push({ user, outcome: "already-mapped", detail: describeActUser(stored) });
        continue;
      }
      drift.push({
        user,
        reason: "stored-id-other-email",
        storedActUser: stored,
        matchedByEmail: [...candidates].sort(byActUser),
      });
      outcomes.push({
        user,
        outcome: "drift",
        detail: `stored id now belongs to ${stored.email?.trim() || "(no email)"}`,
      });
      continue;
    }

    if (candidates.length === 0) {
      unmatched.push(user);
      outcomes.push({ user, outcome: "unmatched", detail: "no Act! user has this email" });
      continue;
    }

    if (candidates.length > 1) {
      ambiguous.push({ user, reason: "two-act-users", candidates: [...candidates].sort(byActUser) });
      outcomes.push({
        user,
        outcome: "ambiguous",
        detail: `${candidates.length} Act! users share this email`,
      });
      continue;
    }

    const actUser = candidates[0];
    const accountMgr = matchAccountMgr(actUser.displayName, repPicklist);

    const rivals = (key ? (pqByEmail.get(key) ?? []) : []).filter((other) => other.id !== user.id);
    if (rivals.length > 0) {
      ambiguous.push({
        user,
        reason: "two-pathquote-users",
        actUser,
        rivals: [...rivals].sort(byEmail),
      });
      outcomes.push({
        user,
        outcome: "ambiguous",
        detail: `${rivals.length + 1} PathQuote users fold to this email`,
      });
      continue;
    }

    const holder = storedBy.get(actUser.id);
    if (holder && holder.id !== user.id) {
      drift.push({ user, reason: "target-held-by-another-user", actUser, heldBy: holder });
      outcomes.push({
        user,
        outcome: "drift",
        detail: `that Act! id is already stored on ${holder.email}`,
      });
      continue;
    }

    if (!isActive(actUser.status)) {
      inactiveMatched.push({ user, actUser, accountMgr });
      outcomes.push({ user, outcome: "inactive-match", detail: describeActUser(actUser) });
      continue;
    }

    matched.push({ user, actUser, accountMgr });
    outcomes.push({ user, outcome: "match", detail: describeActUser(actUser) });
  }

  // Act! users nobody claimed. "Claimed" counts a stored mapping as well as one
  // this run would make, so a user mapped on an earlier run is not relisted as
  // spare.
  const claimed = new Set<string>();
  for (const entry of [...alreadyMapped, ...matched, ...inactiveMatched]) {
    claimed.add(entry.actUser.id);
  }
  for (const entry of drift) {
    if (entry.reason === "stored-id-other-email") claimed.add(entry.storedActUser.id);
  }

  const unusedActUsers: UnusedActUser[] = [];
  for (const actUser of [...actUsers].sort(byActUser)) {
    if (claimed.has(actUser.id)) continue;
    unusedActUsers.push({
      actUser,
      reason: emailKey(actUser.email) === null ? "no-email" : "no-pathquote-user",
    });
  }

  // Account Mgr, over every row whose Act! user is confirmed: a stored mapping
  // that still holds, a match this run would make, and a match held back for
  // being inactive. Ambiguous, unmatched and drifted rows are deliberately out:
  // their Act! user is in doubt, and a gap reported against the wrong Act! user
  // sends an administrator to edit the wrong picklist item.
  //
  // The gap list ignores --include-inactive on purpose. Which rows get written
  // is accountMgrWrites' business; this list is work for a person, and dropping
  // an entry because of a flag on this run would hide it from them.
  const confirmed: { entry: MatchedEntry; outcome: Outcome }[] = [
    ...alreadyMapped.map((entry) => ({ entry, outcome: "already-mapped" as const })),
    ...matched.map((entry) => ({ entry, outcome: "match" as const })),
    ...inactiveMatched.map((entry) => ({ entry, outcome: "inactive-match" as const })),
  ];

  const accountMgrGaps: AccountMgrGap[] = [];
  const accountMgrConflicts: AccountMgrConflict[] = [];
  for (const { entry, outcome } of confirmed) {
    const { user, actUser, accountMgr } = entry;
    if (accountMgr.kind === "exact") {
      // A stored value that is not the item this Act! user resolves to. Not an
      // error and not repaired: somebody typed it, and overwriting it moves
      // clients between managers.
      if (user.actAccountMgr !== null && user.actAccountMgr !== accountMgr.value) {
        accountMgrConflicts.push({
          user,
          actUser,
          stored: user.actAccountMgr,
          value: accountMgr.value,
        });
      }
      continue;
    }
    accountMgrGaps.push({ user, actUser, match: accountMgr, outcome });
  }

  // Picklist items that are no Act! user's display name: `Achim Degel` and
  // `Mr Sistemas` in the list read on 2026-10-12, both distributors somebody
  // added by hand. Nothing to do about them -- they are here so the report
  // shows the whole vocabulary rather than only the half we can reach.
  const actUserNames = new Set(
    actUsers.map((actUser) => actUser.displayName).filter((name): name is string => name !== null),
  );
  const unusedRepItems = repPicklist
    .filter((item) => item.value === null || !actUserNames.has(item.value))
    .sort((a, b) => (a.value ?? "").localeCompare(b.value ?? "") || a.id.localeCompare(b.id));

  return {
    pathQuoteUsers: pathQuoteUsers.length,
    actUsers: actUsers.length,
    alreadyMapped: alreadyMapped.sort((a, b) => byEmail(a.user, b.user)),
    matched: matched.sort((a, b) => byEmail(a.user, b.user)),
    inactiveMatched: inactiveMatched.sort((a, b) => byEmail(a.user, b.user)),
    ambiguous,
    unmatched,
    drift,
    unusedActUsers,
    outcomes,
    repPicklistItems: repPicklist.length,
    accountMgrGaps: accountMgrGaps.sort((a, b) => byEmail(a.user, b.user)),
    accountMgrConflicts: accountMgrConflicts.sort((a, b) => byEmail(a.user, b.user)),
    unusedRepItems,
  };
}

/** What a run would do about the inactive matches, which is the one thing a
 *  flag changes. */
export type ReportOptions = { includeInactive: boolean };

/** One row `--apply` would set actAccountMgr on. `value` is a picklist item's
 *  own value, so it is a string the limit-to-list field will accept. */
export type AccountMgrWrite = { user: PathQuoteUserRow; actUser: ActUserRow; value: string };

/**
 * The rows `--apply` writes actAccountMgr on, given what the run was asked to
 * include. The sibling of entriesToWrite, and the same reason for existing: the
 * count the script offers and the rows it writes are one call.
 *
 * Three conditions, all necessary:
 *
 *  - The Act! user is confirmed -- a stored mapping that still resolves, a
 *    match this run makes, or an inactive match when --include-inactive was
 *    given. Never a row whose Act! user is ambiguous or drifted.
 *  - Its display name is an exact picklist item. See matchAccountMgr.
 *  - The column is still null. A value somebody typed is never replaced; it
 *    shows up in the report's conflicts instead.
 *
 * `alreadyMapped` is included deliberately. A row mapped by an earlier run of
 * this script has actUserId set and actAccountMgr null, because no run before
 * this change could write the second column; the Act! user behind it is
 * confirmed by email all the same, so it is one of the rows that still needs
 * the value. Re-running after that writes nothing, which is what keeps the
 * script idempotent.
 */
export function accountMgrWrites(plan: UserMapPlan, options: ReportOptions): AccountMgrWrite[] {
  const entries = [
    ...plan.alreadyMapped,
    ...plan.matched,
    ...(options.includeInactive ? plan.inactiveMatched : []),
  ];

  const writes: AccountMgrWrite[] = [];
  for (const { user, actUser, accountMgr } of entries) {
    if (accountMgr.kind !== "exact") continue;
    if (user.actAccountMgr !== null) continue;
    writes.push({ user, actUser, value: accountMgr.value });
  }
  return writes.sort((a, b) => byEmail(a.user, b.user));
}

/** Quoted, so a difference in case or whitespace is visible in the report
 *  rather than something the reader has to notice. */
const quoted = (value: string | null) => (value === null ? "(null)" : JSON.stringify(value));

/**
 * The ACCOUNT MGR section of the report.
 *
 * Written as its own function because it answers a different question from the
 * rest: not "which Act! user is this person" but "is there a legal Account Mgr
 * value for them", on a different key and under a stricter rule. Separated also
 * so the wording can be asserted on its own in a test -- the claim this section
 * makes about what is and is not written is exactly the kind that goes stale.
 */
export function formatAccountMgrSection(plan: UserMapPlan, options: ReportOptions): string[] {
  const out: string[] = [];
  const writes = accountMgrWrites(plan, options);

  out.push("ACCOUNT MGR -- User.actAccountMgr, set only on an exact picklist match");
  out.push("  Account Mgr is customFields/rep, a Character(50) field limited to the picklist");
  out.push('  named "Rep" (isLimitToList: true), so the only strings it accepts are that');
  out.push(`  picklist's items. ${plan.repPicklistItems} item(s) were read from the API for this run.`);
  out.push("  PathQuote decides client visibility on the same column, so a plausible wrong");
  out.push("  value here does not fail -- it hands one manager another's clients. That is why");
  out.push("  only an exact match is written and a near-match is reported instead.");

  out.push("");
  out.push(`  WOULD SET: ${writes.length}`);
  if (writes.length === 0) out.push("    none");
  for (const { user, actUser, value } of writes) {
    out.push(`    ${user.email.padEnd(34)}  ${actUser.displayName ?? "(no display name)"}`);
    out.push(`        -> ${quoted(value)}`);
  }

  // Said explicitly because the alternative is a silent absence. An inactive
  // match with a perfectly good picklist item appears in neither list above
  // when the flag is off -- it is not a gap and it is not a write -- and a
  // reader who knows that person has an item would be left wondering where it
  // went. `David Cook` is in the picklist and his Act! user is Inactive, so
  // this line is not hypothetical.
  if (!options.includeInactive) {
    const heldBack = accountMgrWrites(plan, { includeInactive: true }).length - writes.length;
    if (heldBack > 0) {
      out.push(
        `    (${heldBack} not listed: an exact item exists but the Act! user is not Active, so the`,
      );
      out.push("     value is held back with the actUserId. Add --include-inactive to write these.)");
    }
  }

  const nearGaps = plan.accountMgrGaps.filter((gap) => gap.match.kind === "near");
  out.push("");
  out.push(`  NEAR MATCH, NOT WRITTEN: ${nearGaps.length}`);
  if (nearGaps.length === 0) out.push("    none");
  for (const gap of nearGaps) {
    if (gap.match.kind !== "near") continue;
    out.push(`    ${gap.user.email.padEnd(34)}  ${outcomeLabel(gap.outcome)}`);
    out.push(`        Act! display name  ${quoted(gap.actUser.displayName)}`);
    for (const item of gap.match.items) {
      out.push(`        picklist item      ${quoted(item.value)}`);
    }
  }
  if (nearGaps.length > 0) {
    out.push("");
    out.push("    !! The two differ only in case or surrounding whitespace, and this script");
    out.push("    !! will not pick one for you: the field is limited to its list, so one of");
    out.push("    !! those spellings is a legal value and the other is not. Make the Act! user's");
    out.push("    !! display name and the picklist item identical -- in Act! Tools -> Manage");
    out.push("    !! Users, or by editing the Rep list -- and re-run. Nothing was written.");
  }

  const absentGaps = plan.accountMgrGaps.filter((gap) => gap.match.kind === "none");
  out.push("");
  out.push(`  NO PICKLIST ITEM: ${absentGaps.length} -- the list an administrator has to add`);
  if (absentGaps.length === 0) out.push("    none");
  for (const gap of absentGaps) {
    out.push(
      `    ${gap.user.email.padEnd(34)}  ${quoted(gap.actUser.displayName)}  ${outcomeLabel(gap.outcome)}`,
    );
  }
  if (absentGaps.length > 0) {
    out.push("");
    out.push("    !! These people are mapped to an Act! user, but no Rep picklist item carries");
    out.push("    !! that user's display name, so there is no legal Account Mgr value to write.");
    out.push("    !! Add the item in Act! (Tools -> Define Fields -> Account Mgr -> edit list),");
    out.push("    !! spelled exactly as the display name above, and re-run. actUserId is");
    out.push("    !! unaffected -- these rows still get their Act! user.");
  }

  out.push("");
  out.push(`  STORED VALUE DIFFERS: ${plan.accountMgrConflicts.length} -- never overwritten here`);
  if (plan.accountMgrConflicts.length === 0) out.push("    none");
  for (const conflict of plan.accountMgrConflicts) {
    out.push(`    ${conflict.user.email.padEnd(34)}  ${conflict.actUser.displayName ?? "(no display name)"}`);
    out.push(`        stored      ${quoted(conflict.stored)}`);
    out.push(`        picklist    ${quoted(conflict.value)}`);
  }
  if (plan.accountMgrConflicts.length > 0) {
    out.push("");
    out.push("    !! Somebody set that value by hand. Replacing it would move clients between");
    out.push("    !! managers, so decide which is right, clear the column if it is the stored");
    out.push("    !! one, and re-run.");
  }

  out.push("");
  out.push(
    `  PICKLIST ITEMS THAT ARE NO ACT! USER: ${plan.unusedRepItems.length} of ${plan.repPicklistItems}`,
  );
  if (plan.unusedRepItems.length === 0) out.push("    none");
  for (const item of plan.unusedRepItems) {
    const description = item.description?.trim();
    out.push(`    ${quoted(item.value)}${description ? `  -- ${description}` : ""}`);
  }
  if (plan.unusedRepItems.length > 0) {
    out.push("");
    out.push("    These are legal Account Mgr values that belong to nobody with an Act! login --");
    out.push("    distributors, mostly, added to the list by hand. Nothing here is actionable;");
    out.push("    it is shown so the whole vocabulary is visible, not only the half this script");
    out.push("    can reach.");
  }

  return out;
}

function outcomeLabel(outcome: Outcome): string {
  switch (outcome) {
    case "already-mapped":
      return "mapped";
    case "match":
      return "MATCH";
    case "inactive-match":
      return "match (inactive)";
    case "ambiguous":
      return "AMBIGUOUS";
    case "unmatched":
      return "UNMATCHED";
    case "drift":
      return "DRIFT";
  }
}

/**
 * The report, one string per line. Identical for a report-only run and for
 * `--apply` up to this point: the script adds what it wrote after it.
 */
export function formatReport(plan: UserMapPlan, options: ReportOptions): string[] {
  const out: string[] = [];
  const inactiveVerb = options.includeInactive
    ? "included by --include-inactive, would be written"
    : "held back; add --include-inactive to write them";

  out.push(`EVERY PATHQUOTE USER: ${plan.pathQuoteUsers}`);
  if (plan.outcomes.length === 0) out.push("  none");
  for (const line of plan.outcomes) {
    const name = line.user.name?.trim() || "(no name)";
    out.push(`  ${outcomeLabel(line.outcome).padEnd(17)}${line.user.email.padEnd(34)}  ${name}`);
    out.push(`    ${line.detail}`);
  }

  out.push("");
  out.push(`MATCHED: ${plan.matched.length} -- one Act! user on this email, Active, id free`);
  if (plan.matched.length === 0) out.push("  none");
  for (const { user, actUser } of plan.matched) {
    out.push(`  ${describePathQuoteUser(user)}`);
    out.push(`      -> ${describeActUser(actUser)}`);
  }

  out.push("");
  out.push(
    `ALREADY MAPPED: ${plan.alreadyMapped.length} -- stored id still matches on email; nothing to write`,
  );
  if (plan.alreadyMapped.length === 0) out.push("  none");
  for (const { user, actUser } of plan.alreadyMapped) {
    out.push(`  ${describePathQuoteUser(user)}`);
    out.push(`      == ${describeActUser(actUser)}`);
  }

  out.push("");
  out.push(
    `MATCHED BUT NOT ACTIVE IN ACT!: ${plan.inactiveMatched.length} -- ${inactiveVerb}`,
  );
  if (plan.inactiveMatched.length === 0) out.push("  none");
  for (const { user, actUser } of plan.inactiveMatched) {
    out.push(`  ${describePathQuoteUser(user)}`);
    out.push(`      -> ${describeActUser(actUser)}`);
  }
  if (plan.inactiveMatched.length > 0) {
    out.push("");
    out.push("  !! The email joins, but the Act! user is not Active. A record owned by a");
    out.push("  !! disabled user is a support call, so the id is not written by default.");
    out.push("  !! To fix: reactivate the person in Act! Tools -> Manage Users and re-run, or");
    out.push("  !! decide they should not own Act! records and leave them unmapped. If the");
    out.push("  !! mapping is wanted anyway, re-run with --include-inactive.");
  }

  out.push("");
  out.push(`AMBIGUOUS: ${plan.ambiguous.length} -- left alone, nothing written`);
  if (plan.ambiguous.length === 0) out.push("  none");
  for (const entry of plan.ambiguous) {
    out.push(`  ${describePathQuoteUser(entry.user)}`);
    if (entry.reason === "two-act-users") {
      out.push("      two or more Act! users carry this email:");
      for (const actUser of entry.candidates) out.push(`        ${describeActUser(actUser)}`);
    } else {
      out.push(`      matches ${describeActUser(entry.actUser)}`);
      out.push("      but these PathQuote users fold to the same email, and actUserId is unique:");
      for (const rival of entry.rivals) out.push(`        ${describePathQuoteUser(rival)}`);
    }
  }
  if (plan.ambiguous.length > 0) {
    out.push("");
    out.push("  !! Guessing here attaches a manager's pipeline to the wrong account. Fix the");
    out.push("  !! duplicate email -- in Act! Manage Users, or on the PathQuote user -- and");
    out.push("  !! re-run.");
  }

  out.push("");
  out.push(`UNMATCHED: ${plan.unmatched.length} -- no Act! user has this email; nothing written`);
  if (plan.unmatched.length === 0) out.push("  none");
  for (const user of plan.unmatched) out.push(`  ${describePathQuoteUser(user)}`);
  if (plan.unmatched.length > 0) {
    out.push("");
    out.push("  !! Either this person has no Act! login, or their Act! user has a different");
    out.push("  !! email (3 of the 20 users read on 2026-10-02 had no email at all). Set the");
    out.push("  !! email on the Act! user in Tools -> Manage Users, or on the PathQuote user,");
    out.push("  !! so the two agree, and re-run. Act! records this person creates stay with");
    out.push("  !! the integration account until then.");
  }

  out.push("");
  out.push(`DRIFT: ${plan.drift.length} -- a stored mapping that no longer holds; never repaired here`);
  if (plan.drift.length === 0) out.push("  none");
  for (const entry of plan.drift) {
    out.push(`  ${describePathQuoteUser(entry.user)}`);
    if (entry.reason === "stored-id-missing") {
      out.push(`      stored actUserId ${entry.storedActUserId} is not in the Act! user list.`);
      out.push("      The Act! user was deleted, or this database is not the one it came from.");
    } else if (entry.reason === "stored-id-other-email") {
      out.push(`      stored id resolves to ${describeActUser(entry.storedActUser)}`);
      out.push("      whose email is not this person's.");
      if (emailKey(entry.storedActUser.email) === null) {
        // Only a person can have made this link: no email means this script
        // never could. It is what a distributor linked by hand looks like.
        out.push("      That Act! user has no email, so this link was made by hand (Settings ->");
        out.push("      Users -> <user> -> ACT!), as distributors are linked. Expected; leave it.");
      }
      if (entry.matchedByEmail.length === 0) {
        out.push("      No Act! user carries this person's email.");
      } else if (entry.matchedByEmail.length === 1) {
        out.push(`      This email now matches ${describeActUser(entry.matchedByEmail[0])}`);
      } else {
        out.push(`      This email matches ${entry.matchedByEmail.length} Act! users:`);
        for (const actUser of entry.matchedByEmail) out.push(`        ${describeActUser(actUser)}`);
      }
    } else {
      out.push(`      matches ${describeActUser(entry.actUser)}`);
      out.push(`      but that id is already stored on ${describePathQuoteUser(entry.heldBy)}`);
      out.push("      and User.actUserId is unique, so the write would fail.");
    }
  }
  if (plan.drift.length > 0) {
    out.push("");
    out.push("  !! An Act! user id that changed hands means records are already attributed to");
    out.push("  !! the wrong person, so nothing here is repaired automatically. Decide who the");
    out.push("  !! id belongs to, clear actUserId on the other row, and re-run.");
  }

  out.push("");
  out.push(
    `ACT! USERS NO PATHQUOTE USER IS MAPPED TO: ${plan.unusedActUsers.length} of ${plan.actUsers}`,
  );
  if (plan.unusedActUsers.length === 0) out.push("  none");
  for (const { actUser, reason } of plan.unusedActUsers) {
    const why = reason === "no-email" ? "  no email, so it cannot be joined" : "";
    out.push(`  ${describeActUser(actUser)}${why}`);
  }
  if (plan.unusedActUsers.length > 0) {
    out.push("");
    out.push("  PathQuote has fewer users than Act! does, so most of this list is expected and");
    out.push("  needs nothing. One of these can also be an Act! user a section above wanted but");
    out.push("  could not have: an ambiguous or drifted row leaves its Act! user unmapped, so it");
    out.push("  appears here as well. Nothing is written for anything in this list.");
  }

  out.push("");
  out.push(...formatAccountMgrSection(plan, options));

  out.push("");
  out.push("SUMMARY");
  const line = (label: string, value: number, note = "") =>
    out.push(`  ${label.padEnd(34)}${String(value).padStart(5)}${note}`);
  line("PathQuote users", plan.pathQuoteUsers);
  line("Act! users", plan.actUsers);
  line("would be mapped", plan.matched.length);
  line("already mapped", plan.alreadyMapped.length);
  line(
    "matched but not Active in Act!",
    plan.inactiveMatched.length,
    options.includeInactive ? "   (would be written)" : "   (held back)",
  );
  line("ambiguous", plan.ambiguous.length);
  line("unmatched", plan.unmatched.length);
  line("drift", plan.drift.length);
  line("Rep picklist items", plan.repPicklistItems);
  line("account mgr would be set", accountMgrWrites(plan, options).length);
  line("account mgr with no item", plan.accountMgrGaps.length);

  return out;
}

/** The entries `--apply` writes, given what the run was asked to include. One
 *  function, so the number the script offers to write and the rows it actually
 *  writes cannot disagree -- they are the same call. */
export function entriesToWrite(plan: UserMapPlan, options: ReportOptions): MatchedEntry[] {
  return options.includeInactive ? [...plan.matched, ...plan.inactiveMatched] : plan.matched;
}
