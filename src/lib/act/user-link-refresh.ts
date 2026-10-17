// The background half of the ACT! user-link lists: read both from ACT! and
// store the snapshot that src/lib/act/user-link-read.ts serves. Imported by
// scripts/act-drain.ts only -- never by a page or a server action
// (tests/act-isolation.test.ts). The client's ordinary limits apply: the
// first five-minute tick on the VPS showed ACT!'s login alone can outlast the
// 10 s deadline the old in-page read used (2026-10-16).

import type { Prisma, PrismaClient } from "@prisma/client";
import { actReaderFromEnv, REP_PICKLIST_ID } from "@/lib/act/client";
import {
  ACT_LINK_LISTS_KEY,
  ACT_LINK_LISTS_MAX_AGE_MS,
  parseStoredActLinkLists,
  type StoredActLinkLists,
} from "@/lib/act/user-link-read";

type SettingClient = Pick<PrismaClient, "setting">;

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
