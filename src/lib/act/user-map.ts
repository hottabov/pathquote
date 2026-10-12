// Decide which ACT! user, if any, each PathQuote user is.
//
// Nothing populates User.actUserId today, and until something does, every
// record PathQuote creates in ACT! would be owned by the integration account
// (`Marketing`) -- twelve managers' quotes showing up as one person's
// pipeline. This module is the decision half of the script that fills it in;
// scripts/map-act-users.ts is the I/O around it.
//
// Pure and tested for the same reason preflight.ts is: the risk in the script
// is writing the wrong id onto the wrong person, and that decision can be
// checked without a database or a network.
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
// What this module deliberately does NOT decide: User.actAccountMgr. See
// ACCOUNT_MGR_NOTE at the bottom of this file.

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
};

/** A PathQuote user paired with the Act! user it resolved to. */
export type MatchedEntry = { user: PathQuoteUserRow; actUser: ActUserRow };

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
};

/** The join key. An address that trims to nothing is no key at all. */
function emailKey(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed ? trimmed : null;
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
 */
export function planUserMap(
  actUsers: readonly ActUserRow[],
  pathQuoteUsers: readonly PathQuoteUserRow[],
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
        alreadyMapped.push({ user, actUser: stored });
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
      inactiveMatched.push({ user, actUser });
      outcomes.push({ user, outcome: "inactive-match", detail: describeActUser(actUser) });
      continue;
    }

    matched.push({ user, actUser });
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
  };
}

/**
 * Why `--apply` writes actUserId and leaves actAccountMgr null.
 *
 * The column is documented as "this user's name as it appears in ACT!'s
 * 'Account Mgr' field". Account Mgr is `customFields/rep`: a Character(50)
 * custom field bound to the picklist named `Rep`, whose `isLimitToList` is
 * true (RAW/ACT/meta/fields_contact.json, verified on the production box
 * 2026-10-12). Its valid values are therefore the picklist's items, and those
 * items are not the same strings as the Act! users' display names:
 *
 *   - The 17,373-contact export (RAW/ACT/PF_Contacts_20260819) holds 26
 *     distinct non-empty Account Mgr values against 20 Act! users, and 10 of
 *     those 26 are not any user's display name. `Achim Degel`, `Mr Sistemas`
 *     and `AOS ArtOfService` are not even case variants of one -- they are
 *     Account Mgr values belonging to no Act! user at all.
 *   - One real user differs only in case between the two vocabularies: the
 *     Act! user's display name is `Kevin du Plessis`, and the Account Mgr
 *     value on 77 contacts is `Kevin Du Plessis`. So even the users who do
 *     appear are not reachable by copying the display name across.
 *
 * So a display name is not a valid Account Mgr value, and no rule turning one
 * into the other can be derived from the data this script reads. Account Mgr
 * is what client visibility is decided on (prisma/schema.prisma,
 * `Contact.actAccountMgr`), so a plausible-looking wrong value there is worse
 * than a null: it would quietly give one manager another's clients.
 *
 * Resolving it needs the picklist contents, which the API does expose --
 * `GET /api/metadata/drop-down/lists/{list}/items`, list id
 * 65898243-e8ef-4c0f-84d6-bbc93144eac0 -- plus a person to say which item
 * belongs to which user for the ones that do not match exactly. That is a task
 * of its own. Until then the column stays null and the report says so.
 */
export const ACCOUNT_MGR_NOTE = [
  "ACCOUNT MGR -- nothing is written to User.actAccountMgr, by design",
  "  Account Mgr is customFields/rep, a Character(50) field limited to the picklist",
  "  named \"Rep\" (isLimitToList: true). Its valid values are that picklist's items,",
  "  which are not the Act! users' display names: the contact export holds 26 distinct",
  "  non-empty Account Mgr values against 20 Act! users, 10 of them matching no user's",
  "  display name -- Achim Degel, Mr Sistemas and AOS ArtOfService are not users at all,",
  "  and one real user differs by case alone: the user is \"Kevin du Plessis\", the",
  "  Account Mgr value on 77 contacts is \"Kevin Du Plessis\".",
  "  Client visibility is decided on Account Mgr, so a plausible wrong value there",
  "  would hand one manager another's clients. Resolving it needs the picklist items",
  "  (GET /api/metadata/drop-down/lists/{list}/items, list 65898243-e8ef-4c0f-84d6-bbc93144eac0)",
  "  and a person to pair them with users. Separate task; actUserId is what this one does.",
];

/** What a run would do about the inactive matches, which is the one thing a
 *  flag changes. */
export type ReportOptions = { includeInactive: boolean };

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
  out.push(...ACCOUNT_MGR_NOTE);

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

  return out;
}

/** The entries `--apply` writes, given what the run was asked to include. One
 *  function, so the number the script offers to write and the rows it actually
 *  writes cannot disagree -- they are the same call. */
export function entriesToWrite(plan: UserMapPlan, options: ReportOptions): MatchedEntry[] {
  return options.includeInactive ? [...plan.matched, ...plan.inactiveMatched] : plan.matched;
}
