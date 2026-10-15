// Linking one PathQuote user to an ACT! user BY HAND: the decision half of the
// ACT! section on Settings -> Users -> <user> (the page,
// src/app/(app)/settings/users/[userId]/page.tsx; the read,
// src/lib/act/user-link-read.ts; the save, setUserActLink in
// src/lib/actions/act-user-link.ts).
//
// Why by hand. `npm run act:map-users` (src/lib/act/user-map.ts) joins on email
// and on nothing else, on purpose -- see that file's header for why names are
// not a key. Distributors are now created in ACT! as users with NO email (ACT!
// will not take one) and Inactive (no licence), so the email join can never
// reach them. Vadym's decision (2026-10-16): an administrator picks the ACT!
// user, and the Acc Mgr value, from lists read live from ACT!. A name match is
// offered as a suggestion and is never saved by itself -- the admin chooses and
// presses Save.
//
// What is written is two columns of User and nothing else: actUserId (whose
// records the drain files under that ACT! user as record manager -- an author
// with none falls back to the ACT_USER login, unchanged) and actAccountMgr
// (the `Rep` picklist item a contact created for this user's quotes gets as
// Acc Mgr, `customFields/rep`, limited to the list).
//
// Pure: no database, no network, no clock. Everything the page and the action
// decide is here, tested in tests/act-user-link.test.ts.

import { ActApiError, ActNoAnswerError, ActNotSentError } from "@/lib/act/client";
import type { ActUserRow, RepPicklistItem } from "@/lib/act/user-map";

export type { ActUserRow, RepPicklistItem };

/** How long the user page and the save wait for ACT!'s two lists, in all. */
export const ACT_USER_LINK_DEADLINE_MS = 10_000;

/**
 * Thrown by the reader when ACT! has not answered both lists within
 * ACT_USER_LINK_DEADLINE_MS. Its own class so `actUnreachableReason` can say
 * "no answer within 10 seconds" rather than whatever the abandoned request
 * would have said later.
 */
export class ActUserLinkDeadlineError extends Error {
  constructor(readonly ms: number) {
    super(`ACT! did not answer within ${Math.round(ms / 1000)} seconds`);
    this.name = "ActUserLinkDeadlineError";
  }
}

/** Trimmed and lower-cased; empty is no key. The only comparison a suggestion
 *  uses. Never used to decide a write. */
function looseKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** An explicit status other than Active. A missing status is not called
 *  inactive (user-map.ts's isActive takes the same lenient direction). */
export function isInactiveStatus(status: string | null): boolean {
  const value = status?.trim();
  if (!value) return false;
  return value.toLowerCase() !== "active";
}

function shownName(actUser: ActUserRow): string {
  return actUser.displayName?.trim() || "(no display name)";
}

/**
 * How an ACT! user reads in the select: `Name`, then `(Inactive)` -- or
 * whatever non-Active status ACT! reports -- and the email when there is one.
 * `Jane Doe (Inactive) — jane@x.com`, `Mr Sistemas (Inactive)`.
 */
export function actUserLabel(actUser: ActUserRow): string {
  const status = actUser.status?.trim();
  const tag = isInactiveStatus(actUser.status) ? ` (${status})` : "";
  const email = actUser.email?.trim();
  return `${shownName(actUser)}${tag}${email ? ` — ${email}` : ""}`;
}

function byDisplayName(a: ActUserRow, b: ActUserRow): number {
  return (
    shownName(a).localeCompare(shownName(b), "en", { sensitivity: "base" }) ||
    shownName(a).localeCompare(shownName(b)) ||
    a.id.localeCompare(b.id)
  );
}

/** One option of the "ACT! user" select. */
export type ActUserOption = {
  /** The ACT! user's uuid: what is posted and stored. */
  value: string;
  label: string;
  /** The Rep item this ACT! user's display name suggests (suggestAccountMgr),
   *  so the form can hint Acc Mgr for whichever user is chosen without
   *  shipping the lists' logic to the browser. */
  suggestedAccountMgr: string | null;
  /** True for the stored id when ACT! no longer lists it: shown so the select
   *  can display what is stored, refused if saved (validateActLink). */
  missing: boolean;
};

/**
 * Every ACT! user as an option, sorted by display name, Inactive ones
 * included -- distributors ARE Inactive, so leaving them out would defeat the
 * section. A stored id ACT! no longer lists comes first, marked, so the select
 * still shows what is stored.
 */
export function buildActUserOptions(
  actUsers: readonly ActUserRow[],
  repItems: readonly RepPicklistItem[],
  storedActUserId: string | null,
): ActUserOption[] {
  const options: ActUserOption[] = [...actUsers].sort(byDisplayName).map((actUser) => ({
    value: actUser.id,
    label: actUserLabel(actUser),
    suggestedAccountMgr: suggestAccountMgr(actUser.displayName, repItems),
    missing: false,
  }));
  if (storedActUserId && !actUsers.some((actUser) => actUser.id === storedActUserId)) {
    options.unshift({
      value: storedActUserId,
      label: `${storedActUserId} (not an ACT! user any more)`,
      suggestedAccountMgr: null,
      missing: true,
    });
  }
  return options;
}

/** One option of the "Acc Mgr" select. */
export type AccountMgrOption = { value: string; label: string; missing: boolean };

/** The Rep items a person can choose: a value that is null or empty cannot be
 *  told apart from "— none —" in a form, so it is left out. Duplicates once. */
function choosableRepValues(repItems: readonly RepPicklistItem[]): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of repItems) {
    if (item.value === null || item.value === "" || seen.has(item.value)) continue;
    seen.add(item.value);
    values.push(item.value);
  }
  return values;
}

/**
 * Every Rep item as an option, in ACT!'s own order and spelled exactly as ACT!
 * lists it -- the field is limited to the list, so the value is not ours to
 * tidy. A stored value that is not an item comes first, marked, so the select
 * still shows what is stored.
 */
export function buildAccountMgrOptions(
  repItems: readonly RepPicklistItem[],
  storedAccountMgr: string | null,
): AccountMgrOption[] {
  const values = choosableRepValues(repItems);
  const options: AccountMgrOption[] = values.map((value) => ({ value, label: value, missing: false }));
  if (storedAccountMgr !== null && storedAccountMgr !== "" && !values.includes(storedAccountMgr)) {
    options.unshift({
      value: storedAccountMgr,
      label: `${storedAccountMgr} (not in the Rep list)`,
      missing: true,
    });
  }
  return options;
}

/**
 * The one ACT! user whose display name equals this PathQuote user's name,
 * trimmed and ignoring case -- or null when none does, or more than one does,
 * or the PathQuote user has no name. A HINT ONLY: nothing is preselected or
 * saved from it (see the file header, and user-map.ts's for why).
 */
export function suggestActUser(
  pathQuoteName: string | null,
  actUsers: readonly ActUserRow[],
): ActUserRow | null {
  const key = looseKey(pathQuoteName);
  if (key === null) return null;
  const matches = actUsers.filter((actUser) => looseKey(actUser.displayName) === key);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The Rep item an ACT! display name suggests: the item spelled identically if
 * there is one, else the one item equal to it trimmed and ignoring case, else
 * null (none, or several that differ only in case). The value returned is the
 * item's own spelling, never the display name's.
 */
export function suggestAccountMgr(
  displayName: string | null,
  repItems: readonly RepPicklistItem[],
): string | null {
  if (!displayName) return null;
  const values = choosableRepValues(repItems);
  if (values.includes(displayName)) return displayName;
  const key = looseKey(displayName);
  if (key === null) return null;
  const near = values.filter((value) => looseKey(value) === key);
  return near.length === 1 ? near[0] : null;
}

/** The two values a save posts, as the form sends them. */
export type ActLinkSubmission = {
  /** An ACT! user uuid, or null to unlink. */
  actUserId: string | null;
  /** A Rep item, exactly as posted, or null for none. */
  accountMgr: string | null;
};

/**
 * Read the posted pair. Both fields must be present as strings: an absent
 * field is a form that did not send it, and reading that as "clear" would let
 * a broken caller unlink a user (the reason updateUserSchema has no `active`).
 * The empty string is the "— not linked —" / "— none —" choice.
 *
 * The id is trimmed (it is a uuid); the Acc Mgr value is NOT -- it must match
 * a Rep item byte for byte, and trimming would make a value the list does not
 * hold.
 */
export function parseActLinkForm(raw: {
  actUserId: unknown;
  accountMgr: unknown;
}): { ok: true; value: ActLinkSubmission } | { ok: false; error: string } {
  if (typeof raw.actUserId !== "string" || typeof raw.accountMgr !== "string") {
    return { ok: false, error: "The form did not send both the ACT! user and the Acc Mgr. Reload the page and try again." };
  }
  const actUserId = raw.actUserId.trim();
  return {
    ok: true,
    value: {
      actUserId: actUserId === "" ? null : actUserId,
      accountMgr: raw.accountMgr === "" ? null : raw.accountMgr,
    },
  };
}

/** Another PathQuote user, as far as "who already holds this ACT! user" needs. */
export type LinkedPathQuoteUser = {
  id: string;
  name: string | null;
  email: string;
  actUserId: string | null;
};

/** A PathQuote user as an error names them: name and email, or the email. */
function namedUser(user: { name: string | null; email: string }): string {
  const name = user.name?.trim();
  return name ? `${name} (${user.email})` : user.email;
}

/** The refusal when the chosen ACT! user is already another PathQuote user's.
 *  Also what the action says when the unique index catches the same thing in
 *  a race. */
export function actUserHeldError(holder: { name: string | null; email: string }): string {
  return `That ACT! user is already linked to ${namedUser(holder)}. Unlink it on their page first — one ACT! user can belong to one PathQuote user only.`;
}

/**
 * Whether the posted pair may be stored on user `userId`, judged against
 * ACT!'s lists as read server-side for this save and against every other
 * PathQuote user's stored link. Returns the pair to write, or the sentence
 * refusing it. Unlinking (null) and "no Acc Mgr" (null) are always allowed.
 */
export function validateActLink(input: {
  userId: string;
  submission: ActLinkSubmission;
  actUsers: readonly ActUserRow[];
  repItems: readonly RepPicklistItem[];
  /** Other PathQuote users; the target itself is ignored if present. */
  otherUsers: readonly LinkedPathQuoteUser[];
}): { ok: true; value: ActLinkSubmission } | { ok: false; error: string } {
  const { userId, submission, actUsers, repItems, otherUsers } = input;

  if (submission.actUserId !== null && !actUsers.some((actUser) => actUser.id === submission.actUserId)) {
    return {
      ok: false,
      error: "That ACT! user is not in ACT!'s user list (any more), so nothing was saved. Choose another, or — not linked —.",
    };
  }

  if (submission.accountMgr !== null && !choosableRepValues(repItems).includes(submission.accountMgr)) {
    return {
      ok: false,
      error: `“${submission.accountMgr}” is not an item of ACT!'s Rep list, so ACT! would refuse it as Acc Mgr and nothing was saved. Choose an item, or — none —.`,
    };
  }

  if (submission.actUserId !== null) {
    const holder = otherUsers.find((other) => other.id !== userId && other.actUserId === submission.actUserId);
    if (holder) return { ok: false, error: actUserHeldError(holder) };
  }

  return { ok: true, value: submission };
}

/** How the section names the ACT! login a user with no link falls back to. */
export function fallbackOwnerName(loginName: string | null): string {
  const name = loginName?.trim();
  return name ? name : "the ACT! login user (ACT_USER, which is not set on this server)";
}

/**
 * The "currently" lines of the section: who this user is in ACT!, and their
 * Acc Mgr. `actUsers` is null when ACT! could not be read, and a stored id is
 * then shown as the id.
 */
export function describeCurrentLink(input: {
  storedActUserId: string | null;
  storedAccountMgr: string | null;
  actUsers: readonly ActUserRow[] | null;
  loginName: string | null;
}): { actUser: string; linked: boolean; accountMgr: string } {
  const { storedActUserId, storedAccountMgr, actUsers, loginName } = input;
  const accountMgr = storedAccountMgr !== null && storedAccountMgr !== "" ? storedAccountMgr : "none";

  if (storedActUserId === null) {
    return {
      actUser: `Not linked — records for this user's quotes are owned by ${fallbackOwnerName(loginName)}.`,
      linked: false,
      accountMgr,
    };
  }

  if (actUsers === null) {
    return { actUser: `ACT! user ${storedActUserId} (details unavailable)`, linked: true, accountMgr };
  }

  const actUser = actUsers.find((candidate) => candidate.id === storedActUserId);
  if (!actUser) {
    return {
      actUser: `ACT! user ${storedActUserId}, which ACT! no longer lists — choose another ACT! user, or — not linked —.`,
      linked: true,
      accountMgr,
    };
  }

  const parts = [shownName(actUser), actUser.status?.trim() || "status not reported"];
  const email = actUser.email?.trim();
  parts.push(email ? email : "no email");
  return { actUser: parts.join(" · "), linked: true, accountMgr };
}

/** Longest a reason quoted from an unexpected error may run. */
const REASON_MAX = 160;

/**
 * The short reason ACT! could not be read, for "ACT! could not be reached:
 * <reason>; the link cannot be changed right now".
 */
export function actUnreachableReason(error: unknown): string {
  if (error instanceof ActUserLinkDeadlineError) {
    return `no answer within ${Math.round(error.ms / 1000)} seconds`;
  }
  if (error instanceof ActApiError) {
    return error.authorizing ? `ACT! refused the login (HTTP ${error.status})` : `ACT! answered HTTP ${error.status}`;
  }
  if (error instanceof ActNotSentError || error instanceof ActNoAnswerError) {
    return "no answer from ACT!";
  }
  const message = error instanceof Error ? error.message : String(error);
  const missing = /^missing environment: (.+)$/.exec(message);
  if (missing) return `ACT! is not configured on this server (${missing[1]} not set)`;
  return message.length > REASON_MAX ? `${message.slice(0, REASON_MAX - 1)}…` : message;
}

/** The sentence the section and the save show when ACT! could not be read. */
export function actUnreachableMessage(reason: string): string {
  return `ACT! could not be reached: ${reason}; the link cannot be changed right now.`;
}
