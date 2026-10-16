// The I/O half of linking a PathQuote user to an ACT! user by hand: read
// ACT!'s user list and its Rep picklist, within a short budget, and never
// throw. Every decision about what was read is in src/lib/act/user-link.ts.
//
// Called by the ACT! section of the user page (which must not take the rest of
// the page down with it -- ACT! answers only the production VPS) and by
// setUserActLink, which re-reads both lists before it writes rather than
// trusting what the browser was shown.

import { actReaderFromEnv, REP_PICKLIST_ID, type ActRequestLimits } from "@/lib/act/client";
import {
  ACT_USER_LINK_DEADLINE_MS,
  ActUserLinkDeadlineError,
  actUnreachableReason,
  type ActUserRow,
  type RepPicklistItem,
} from "@/lib/act/user-link";

/**
 * One attempt per request, and under the overall deadline: a person is
 * waiting on the page, and a second attempt would only double the wait for an
 * ACT! that is not answering (the same reasoning as ACT_CONTACT_CHECK_LIMITS
 * in src/lib/act/outbox-admin.ts). The deadline, not these, is what bounds the
 * whole read; a request still running when it passes is a GET, and is simply
 * abandoned.
 */
const ACT_USER_LINK_LIMITS: ActRequestLimits = { timeoutMs: ACT_USER_LINK_DEADLINE_MS, attempts: 1 };

export type ActLinkLists =
  | { ok: true; loginName: string | null; actUsers: ActUserRow[]; repItems: RepPicklistItem[] }
  | { ok: false; loginName: string | null; reason: string };

/** ACT_USER as set, for "owned by <login>". Read from the environment rather
 *  than the client so it is known even when the client cannot be built. */
function loginNameFromEnv(): string | null {
  return process.env.ACT_USER?.trim() || null;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActUserLinkDeadlineError(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function readBoth(): Promise<{ actUsers: ActUserRow[]; repItems: RepPicklistItem[] }> {
  const reader = actReaderFromEnv(ACT_USER_LINK_LIMITS);
  // One after the other: the client logs in on its first request, and two at
  // once would log in twice.
  const users = await reader.users();
  const items = await reader.picklistItems(REP_PICKLIST_ID);
  // `?? null` for the reason scripts/map-act-users.ts gives: swagger marks no
  // field required, so an omitted one arrives as undefined.
  return {
    actUsers: users.map((user) => ({
      id: user.id,
      displayName: user.displayName ?? null,
      email: user.email ?? null,
      status: user.status ?? null,
      role: user.role ?? null,
    })),
    repItems: items.map((item) => ({
      id: item.id,
      value: item.value ?? null,
      description: item.description ?? null,
    })),
  };
}

/**
 * How long a successful read is reused before ACT! is asked again. The
 * production nginx log of 2026-10-16 showed what reading live costs: ACT!
 * answers the VPS in 1-2 s per request (TCP 0.25 s, TLS 0.8 s, then the
 * query), two requests in sequence here, so every open of a user page and --
 * worse -- every save of the ACT! link (setUserActLink re-reads before it
 * writes, then the page re-renders and reads a third time) took 6-11 s. The
 * two lists are an administrator's user table and a picklist; ten minutes of
 * staleness means a user added in ACT! this minute is offered after lunch,
 * which is a fair trade for a page that opens at once.
 */
const ACT_LINK_LISTS_TTL_MS = 10 * 60 * 1000;

/** A failed read is not retried on every request either: ACT! being down is
 * a condition that lasts minutes, and each attempt costs the deadline. */
const ACT_LINK_LISTS_FAILURE_TTL_MS = 30 * 1000;

let cached: { lists: ActLinkLists; expiresAt: number } | null = null;
let inFlight: Promise<ActLinkLists> | null = null;

async function readUncached(): Promise<ActLinkLists> {
  const loginName = loginNameFromEnv();
  try {
    const lists = await withDeadline(readBoth(), ACT_USER_LINK_DEADLINE_MS);
    return { ok: true, loginName, ...lists };
  } catch (error) {
    console.warn("act user link: could not read ACT!'s users or Rep list", error);
    return { ok: false, loginName, reason: actUnreachableReason(error) };
  }
}

/**
 * ACT!'s users and Rep items, or why they could not be read. Never throws.
 * Served from a process-wide cache for ACT_LINK_LISTS_TTL_MS after a
 * successful read (ACT_LINK_LISTS_FAILURE_TTL_MS after a failed one), and
 * concurrent callers share one read rather than logging in to ACT! twice.
 */
export async function readActLinkLists(): Promise<ActLinkLists> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.lists;
  if (inFlight) return inFlight;
  inFlight = readUncached()
    .then((lists) => {
      cached = { lists, expiresAt: Date.now() + (lists.ok ? ACT_LINK_LISTS_TTL_MS : ACT_LINK_LISTS_FAILURE_TTL_MS) };
      return lists;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drops the cache, so the next read asks ACT! again. For tests and for an
 * administrator's "refresh" should one ever be added. */
export function forgetActLinkLists(): void {
  cached = null;
}
