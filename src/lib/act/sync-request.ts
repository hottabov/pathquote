// "Sync now" as a request, not a run.
//
// Until 2026-10-16 the button ran the inbound ACT! sync inside the web
// process: a server action that took 17-19 s in production (nginx's log),
// held the shared database pool, and was cut off by nginx at 60 s on a bad
// night. The owner's rule is that nothing reads from or writes to ACT! on a
// user's request -- ACT! answers the VPS in 1-2 s per call, and it belongs in
// the background. So the button now writes one row, and the periodic drain
// (scripts/act-drain.ts, pq-act-drain.timer, every five minutes) runs the sync
// at its next tick and clears the row. The page reads the row to say "requested,
// waiting for the next run".

import type { Prisma, PrismaClient } from "@prisma/client";

export const SYNC_REQUEST_KEY = "act.sync.requested";

/** How soon the request is honoured: the drain timer's cadence
 *  (scripts/ops/pq-act-drain.timer). Named here so the page and the toast
 *  say the same number the unit runs on. */
export const SYNC_REQUEST_PICKUP_MINUTES = 5;

export type SyncRequest = { at: string; byUserId: string };

type SettingClient = Pick<PrismaClient, "setting">;

/** Records that a person asked for a sync. A second press replaces the first;
 *  there is nothing to queue twice. */
export async function requestSync(db: SettingClient, byUserId: string, now: Date = new Date()): Promise<void> {
  const value: SyncRequest = { at: now.toISOString(), byUserId };
  await db.setting.upsert({
    where: { key: SYNC_REQUEST_KEY },
    create: { key: SYNC_REQUEST_KEY, value: value as unknown as Prisma.InputJsonValue },
    update: { value: value as unknown as Prisma.InputJsonValue },
  });
}

/** The outstanding request, if any; a row that does not parse counts as one
 *  (somebody wrote it), with no author. */
export async function readSyncRequest(db: SettingClient): Promise<SyncRequest | null> {
  const row = await db.setting.findUnique({ where: { key: SYNC_REQUEST_KEY } });
  if (!row) return null;
  return parseSyncRequest(row.value);
}

export function parseSyncRequest(value: unknown): SyncRequest {
  const record = (value ?? {}) as { at?: unknown; byUserId?: unknown };
  return {
    at: typeof record.at === "string" ? record.at : new Date(0).toISOString(),
    byUserId: typeof record.byUserId === "string" ? record.byUserId : "",
  };
}

/** Takes the request off the table before running it, so a press during the
 *  run queues the next one rather than being swallowed by this one. */
export async function takeSyncRequest(db: SettingClient): Promise<SyncRequest | null> {
  const request = await readSyncRequest(db);
  if (!request) return null;
  await db.setting.deleteMany({ where: { key: SYNC_REQUEST_KEY } });
  return request;
}
