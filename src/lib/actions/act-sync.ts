"use server";

import { requireAdmin } from "@/lib/authz";
import { actClientFromEnv } from "@/lib/act/client";
import { messageOf } from "@/lib/act/run-record";
import { SyncAlreadyRunningError, syncContacts } from "@/lib/act/sync";
import { revalidateActSync } from "@/lib/revalidate";
import type { ActionResultWithWarning } from "./_shared";

export type { ActionResultWithWarning };

/**
 * Pull whatever has changed in ACT! since the stored cursor, now, because an
 * admin pressed the button rather than because the nightly timer fired.
 *
 * `warning` rather than `error` for the one outcome that is not a failure --
 * see the catch below. Everything else about this is the ordinary action
 * shape.
 *
 * HOW LONG THIS BLOCKS, which is the thing worth knowing before wiring a
 * button to it. A server action holds the request until it returns, and
 * Next.js dispatches a client's actions one at a time, so while this runs the
 * admin's other buttons queue behind it.
 *
 * The ordinary case is seconds: a night's worth of edits is a page or two of
 * 200 from ACT! (PAGE_SIZE, src/lib/act/client.ts) and a handful of rows
 * written per contact. The cases that are not seconds, with the numbers that
 * make them:
 *
 *   - A delta that has not run for a week, because the nightly job has been
 *     failing: a week of edits instead of a night of them. Larger, still
 *     bounded by how much anyone edits in a week.
 *   - A STORED CURSOR OF NULL. Then "delta" means every contact in ACT! --
 *     ~17,500, 88 pages -- without anybody passing `full`. This is the case
 *     that turns one click into a ten-minute import, and nothing in this file
 *     can see it coming; the Settings page can, because getActSyncStatus
 *     (src/lib/queries/act-sync.ts) returns the cursor for exactly this
 *     reason.
 *   - ACT! slow, or gone. One HTTP exchange is up to three attempts of a
 *     30-second timeout with 1s and 2s between them (REQUEST_TIMEOUT_MS,
 *     MAX_ATTEMPTS, RETRY_DELAY_MS in client.ts), so a single page can cost 93
 *     seconds and then either carry on or give up. Which way ACT! is gone
 *     decides which: a refused connection fails in moments and the run throws
 *     almost at once, where a host that swallows the connection instead -- the
 *     NAT rule withdrawn, the IIS box wedged -- costs the full 93 seconds for
 *     the very first request. ACT! merely slow is the expensive one: 88 pages
 *     that each answer in 29 seconds is ~43 minutes, and no timeout anywhere
 *     in this app stops it.
 *
 * What bounds it is not in this repository. nginx's `proxy_read_timeout`
 * defaults to 60 seconds, and the proxy configuration written out in
 * docs/runbook.md §3 sets no timeouts at all -- though the live site is a
 * WordOps proxy site (runbook, "Nginx: do not add global directives") whose
 * generated template is not in this repo, so 60 seconds is the documented
 * default rather than a number anyone has read off the VPS. Nothing in the app
 * narrows it: next.config.ts declares no `serverActions` limits, `maxDuration`
 * means nothing to a long-running `node server.js` behind a reverse proxy, and
 * Node's own response timeout is off by default. So at whatever that number
 * is, nginx stops waiting and answers 504, and the browser gets a gateway
 * error page where it expected an action result -- the button reports a
 * failure in whatever words the page's error handling uses.
 *
 * The sync does not stop when that happens: nothing cancels a server action
 * because the client went away, so the process carries on, keeps the advisory
 * lock, and still writes its own record at the end. A reload then says
 * "Running now" and a later one says what changed; a second click meanwhile
 * loses the lock race and says so.
 *
 * Which is what makes this acceptable as it stands -- the ceiling is reached
 * by the page giving up on a run that goes on to succeed, not by work being
 * lost halfway. A job queue is the real answer to a button that can take forty
 * minutes and is not worth building for one whose ordinary case is seconds.
 * What is required instead is that the section around this button tells the
 * truth about the wait; and if 60 seconds turns out to bite in practice,
 * `proxy_read_timeout` on the VPS is a one-line change.
 */
export async function runActSyncNow(): Promise<ActionResultWithWarning> {
  await requireAdmin();

  try {
    // Credentials come from the container's environment, the same way
    // scripts/act-sync.ts gets them. Nothing about which ACT! database to read
    // or who to read it as is taken from the request: the button is a trigger,
    // not a form.
    await syncContacts(actClientFromEnv(), {
      // `trigger: "manual"` is the only option set, and in particular NOT
      // `full: true`. The button runs the delta. A full re-read is ~17,500
      // contacts and ten minutes or more of an HTTP request that somebody is
      // watching, which is not a thing to put one click away; `npm run
      // act:sync -- --full` is still there for the person who means it.
      trigger: "manual",
    });
    return {};
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      // Not a failure: the nightly timer, or another admin, is doing the work
      // right now. The CLI reaches the same conclusion about the same error
      // (see the catch at the bottom of scripts/act-sync.ts -- it exits 0 and
      // explains itself), and this is the other half of that decision.
      //
      // Caught by type rather than by matching the message, for the reason the
      // CLI gives: the message is written for this button. Which is also why
      // it is returned as-is instead of being rewritten here -- there is one
      // sentence for this event, it is declared next to the throw in
      // src/lib/act/sync.ts, and a second copy in the action layer is how the
      // two start disagreeing.
      //
      // Returned as `warning`, not `error`, so the page can say it without the
      // red treatment reserved for something that needs fixing. That stretches
      // `warning` past its doc comment in ./_shared.ts, which describes a save
      // that did succeed -- this click saved nothing. It is the closer of the
      // two: nothing is wrong and there is nothing for the admin to do.
      return { warning: error.message };
    }

    // A real failure -- a 401 from ACT!, the ACT_* variables missing from the
    // container, the database refusing a write -- reaches the admin as its own
    // message rather than being flattened into "something went wrong".
    // Returned rather than rethrown because that is the only way the message
    // itself arrives: a server action that throws reaches the browser as an
    // opaque digest, and the sentence naming which of those three it was would
    // be left in the log.
    //
    // Nothing is swallowed by returning it. The worker has already written the
    // same message to the last-run record on its way out (the catch in
    // syncContacts), which is what makes the failure visible even when this
    // result never arrives -- a 504'd click, a closed tab -- and this line
    // puts it in the service log, where the stack trace survives too.
    console.error("act: the Sync now button's run failed", error);
    return { error: messageOf(error) };
  } finally {
    // Every path, including both failures. A thrown run and a lost race both
    // change what the page should say -- the first wrote a failure record, the
    // second means another run is live -- so the page is stale after all three
    // outcomes, not just the good one.
    revalidateActSync();
  }
}
