// The I/O half of linking a PathQuote user to an ACT! user by hand.
//
// ACT!'s user list and its Rep picklist are read FROM A SNAPSHOT in the
// database, never from ACT! on a request. Until 2026-10-16 the user page read
// both lists live on every render and `setUserActLink` read them again before
// every write: ACT! answers the VPS in 1-2 s per call, so the page took 6-10 s
// and a save 6-11 s (production nginx log). The owner's rule is that nothing
// reads from ACT! on a user's request. The periodic drain (scripts/act-drain.ts,
// every five minutes) refreshes the snapshot when it is older than
// ACT_LINK_LISTS_MAX_AGE_MS; the page and the action read the row and nothing
// else. Every decision about what was read is in src/lib/act/user-link.ts.
// The database client is a parameter so this module (and its test) never
// builds the pool on import.

import type { Prisma, PrismaClient } from "@prisma/client";
import { actReaderFromEnv, REP_PICKLIST_ID } from "@/lib/act/client";
import type { ActUserRow, RepPicklistItem } from "@/lib/act/user-link";

export const ACT_LINK_LISTS_KEY = "act.linkLists";

/** A snapshot older than this is read again at the next drain tick. An
 *  administrator's user table and a picklist change a few times a year. */
export const ACT_LINK_LISTS_MAX_AGE_MS = 60 * 60 * 1000;

// The client's ordinary limits, not the 10 s deadline the in-page read had:
// this runs in the background now, and the first tick on the VPS showed ACT!'s
// login alone can take longer than that (2026-10-16). A hung ACT! still cannot
// hold the drain past the client's own timeout and attempts.

export type ActLinkLists =
  | { ok: true; loginName: string | null; actUsers: ActUserRow[]; repItems: RepPicklistItem[]; readAt: string }
  | { ok: false; loginName: string | null; reason: string };

export type StoredActLinkLists = { readAt: string; actUsers: ActUserRow[]; repItems: RepPicklistItem[] };

/** ACT_USER as set, for "owned by <login>". Read from the environment rather
 *  than the client so it is known even when the client cannot be built. */
function loginNameFromEnv(): string | null {
  return process.env.ACT_USER?.trim() || null;
}

/** The reason the page shows while no snapshot exists -- a fresh install, or
 *  a drain that has not run since this code shipped. */
export const ACT_LINK_LISTS_NOT_READ_YET = "ACT!'s user list has not been read yet; the background job reads it every few minutes";

type SettingClient = Pick<PrismaClient, "setting">;

/** The stored lists, or null when the row is missing or does not parse. */
export function parseStoredActLinkLists(value: unknown): StoredActLinkLists | null {
  const record = value as { readAt?: unknown; actUsers?: unknown; repItems?: unknown } | null;
  if (!record || typeof record !== "object") return null;
  if (typeof record.readAt !== "string" || !Array.isArray(record.actUsers) || !Array.isArray(record.repItems)) return null;
  return {
    readAt: record.readAt,
    actUsers: record.actUsers as ActUserRow[],
    repItems: record.repItems as RepPicklistItem[],
  };
}

/**
 * ACT!'s users and Rep items as last read by the background job, or why they
 * are not available. Never throws, and never calls ACT!.
 */
export async function readActLinkLists(client: SettingClient): Promise<ActLinkLists> {
  const loginName = loginNameFromEnv();
  try {
    const row = await client.setting.findUnique({ where: { key: ACT_LINK_LISTS_KEY } });
    const stored = row ? parseStoredActLinkLists(row.value) : null;
    if (!stored) return { ok: false, loginName, reason: ACT_LINK_LISTS_NOT_READ_YET };
    return { ok: true, loginName, ...stored };
  } catch (error) {
    console.warn("act user link: could not read the stored ACT! lists", error);
    return { ok: false, loginName, reason: "the stored ACT! lists could not be read" };
  }
}

async function readBothFromAct(): Promise<Omit<StoredActLinkLists, "readAt">> {
  const reader = actReaderFromEnv();
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
 * Reads both lists from ACT! and stores them. For the background job only
 * (scripts/act-drain.ts); throws on an ACT! failure so the caller can log it,
 * leaving the previous snapshot in place.
 */
export async function refreshActLinkLists(client: SettingClient, now: Date = new Date()): Promise<StoredActLinkLists> {
  const lists = await readBothFromAct();
  const value: StoredActLinkLists = { readAt: now.toISOString(), ...lists };
  await client.setting.upsert({
    where: { key: ACT_LINK_LISTS_KEY },
    create: { key: ACT_LINK_LISTS_KEY, value: value as unknown as Prisma.InputJsonValue },
    update: { value: value as unknown as Prisma.InputJsonValue },
  });
  return value;
}

/** Refreshes only when the snapshot is missing or older than `maxAgeMs`.
 *  Returns what it did, for the job's log line. */
export async function refreshActLinkListsIfStale(
  client: SettingClient,
  maxAgeMs: number = ACT_LINK_LISTS_MAX_AGE_MS,
  now: Date = new Date(),
): Promise<"fresh" | "refreshed"> {
  const row = await client.setting.findUnique({ where: { key: ACT_LINK_LISTS_KEY } });
  const stored = row ? parseStoredActLinkLists(row.value) : null;
  if (stored && now.getTime() - Date.parse(stored.readAt) < maxAgeMs) return "fresh";
  await refreshActLinkLists(client, now);
  return "refreshed";
}
