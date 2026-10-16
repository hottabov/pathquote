"use server";

import { requireActSync } from "@/lib/authz";
import { messageOf } from "@/lib/act/run-record";
import { revalidateActSync } from "@/lib/revalidate";
import { requestSync } from "@/lib/act/sync-request";
import { db } from "@/lib/db";
import type { ActionResultWithWarning } from "./_shared";

/**
 * "Sync now": records a request that the background job honours at its next
 * tick (scripts/act-drain.ts, every SYNC_REQUEST_PICKUP_MINUTES minutes).
 *
 * Until 2026-10-16 this ran `syncContacts` inside the server action -- 17-19 s
 * per press in production's nginx log, on the pool every request shares, with
 * nginx's 60 s `proxy_read_timeout` as the ceiling on a bad night (the long
 * note that used to live here is in git history, 12a146a^). The owner's rule
 * since the audit is that nothing reads from or writes to ACT! on a user's
 * request; see src/lib/act/sync-request.ts. The page, revalidated below, says
 * "requested" until the run's own record replaces it.
 *
 * `requireActSync`, not `requireAdmin`: a MANAGER may press this when an admin
 * has granted the section (`actSyncVisible`); the request carries their id.
 */
export async function runActSyncNow(): Promise<ActionResultWithWarning> {
  const session = await requireActSync();
  try {
    await requestSync(db, session.user.id);
    return {};
  } catch (error) {
    console.error("act: the Sync now request could not be recorded", error);
    return { error: messageOf(error) };
  } finally {
    revalidateActSync();
  }
}
