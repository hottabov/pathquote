"use server";

import { requireSession } from "@/lib/authz";
import { actClientFromEnv } from "@/lib/act/client";
import { FAILED_CONTACTS_DETAIL, messageOf } from "@/lib/act/run-record";
import { SyncAlreadyRunningError, syncContacts } from "@/lib/act/sync";
import { plural } from "@/lib/plural";
import { revalidateActSync } from "@/lib/revalidate";
import type { ActionResultWithWarning } from "./_shared";

export type { ActionResultWithWarning };

/**
 * Pull whatever has changed in ACT! since the stored cursor, now, because
 * somebody pressed the button rather than because the nightly timer fired.
 *
 * `requireSession`, not `requireAdmin`: any signed-in user may press this, a
 * MANAGER included, and the point of that is the manager who can see their
 * own ACT! edit has not arrived and would otherwise have to ask for it. What
 * makes it safe to hand over is that there is nothing here to get wrong --
 * the sync only reads ACT!, its writes into PathQuote fill blanks and never
 * overwrite (`fillOnlyEmpty`, src/lib/act/merge.ts), the advisory lock below
 * means a second press cannot start a second run, and no option is taken from
 * the request (see the `trigger` comment inside). The guard is not deleted,
 * because there is still a caller to refuse: an unauthenticated POST to this
 * action's id must not reach ACT!, and this is the app's own answer to it
 * rather than the proxy's (see requireSession).
 *
 * `warning` rather than `error` for the two outcomes that are not this
 * caller's failure to report: a run that came back having dropped some
 * contacts, and losing the lock race to a run already going. Everything else
 * about this is the ordinary action shape.
 *
 * HOW LONG THIS BLOCKS, which is the thing worth knowing before wiring a
 * button to it. A server action holds the request until it returns, and
 * Next.js dispatches a client's actions one at a time, so while this runs the
 * presser's other buttons queue behind it.
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
 *     the very first request. ACT! merely slow is the expensive one, and it has
 *     two figures that are easy to confuse because they come from different
 *     arithmetic:
 *       - NOTHING RETRIES. Every page answers in 29 seconds, just inside the
 *         timeout, so every one succeeds first time: 88 x 29s is ~43 minutes.
 *       - EVERYTHING RETRIES. Each page's first two attempts time out and its
 *         third answers: 30 + 1 + 30 + 2 + 30 is 93 seconds, so 88 x 93s is
 *         ~2h16m. That is the ceiling -- the slowest a run can be and still
 *         finish -- and the 43 minutes is NOT it. Quote one or the other; the
 *         three-attempts-plus-backoff reasoning belongs to the 2h16m.
 *     No timeout anywhere in this app stops either of them.
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
 * lost halfway. A job queue is the real answer to a button that can take two
 * hours and is not worth building for one whose ordinary case is seconds.
 * What is required instead is that the section around this button tells the
 * truth about the wait; and if 60 seconds turns out to bite in practice,
 * `proxy_read_timeout` on the VPS is a one-line change.
 */
export async function runActSyncNow(): Promise<ActionResultWithWarning> {
  await requireSession();

  try {
    // Credentials come from the container's environment, the same way
    // scripts/act-sync.ts gets them. Nothing about which ACT! database to read
    // or who to read it as is taken from the request: the button is a trigger,
    // not a form.
    const result = await syncContacts(actClientFromEnv(), {
      // `trigger: "manual"` is the only option set, and in particular NOT
      // `full: true`. The button runs the delta. A full re-read is ~17,500
      // contacts and ten minutes or more of an HTTP request that somebody is
      // watching, which is not a thing to put one click away; `npm run
      // act:sync -- --full` is still there for the person who means it.
      trigger: "manual",
    });

    if (result.failed > 0) {
      // The run came back, so the work it got through is saved -- a caveat on a
      // save that succeeded, which is `warning` in its first sense. A plain `{}`
      // here fires the panel's success toast over a run that dropped contacts,
      // and whoever pressed it walks away believing it all went in.
      //
      // Everything after the count IS describeRun's failure detail -- the same
      // const, not a copy of its words -- because the `finally` below
      // revalidates and the section this toast sits on top of is about to say
      // exactly this. Two wordings of one fact invite reading them as two
      // different facts, and while this was a second copy held in step by a
      // comment, nothing would have failed when one of them was reworded.
      return {
        warning: `${plural(result.failed, "contact", "contacts")} failed. ${FAILED_CONTACTS_DETAIL}`,
      };
    }

    return {};
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) {
      // Not a failure: the nightly timer, or somebody else at the same
      // button, is doing the work right now -- and with the section open to
      // every signed-in user, "somebody else" is now a likelier reason than
      // it was. The CLI reaches the same conclusion about the same error (see
      // the catch at the bottom of scripts/act-sync.ts -- it exits 0 and
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
      // red treatment reserved for something that needs fixing. This click
      // saved nothing, which is the second of the two meanings `warning`
      // carries -- not this caller's failure, and nothing for the reader to do;
      // see the doc comment on ActionResultWithWarning in ./_shared.ts, which
      // names this function as the example.
      return { warning: error.message };
    }

    // A real failure -- a 401 from ACT!, the ACT_* variables missing from the
    // container, the database refusing a write -- reaches the reader as its own
    // message rather than being flattened into "something went wrong".
    // Returned rather than rethrown because that is the only way the message
    // itself arrives: a server action that throws reaches the browser as an
    // opaque digest, and the sentence naming which of those three it was would
    // be left in the log.
    //
    // Returning it does not swallow it, and for one of those three it does not
    // even have to. A failure raised inside syncContacts once the start record
    // had landed -- the 401, a contact write rejected mid-run -- has already
    // had this same message written to the last-run record by the worker on its
    // way out (the catch in syncContacts), which is what keeps the failure
    // visible when this result never arrives: a 504'd click, a closed tab.
    //
    // The other two leave no record to find. actClientFromEnv() throws before
    // syncContacts is entered, so a missing ACT_* variable never gets as far as
    // the start record; and a database refusing writes is precisely the case
    // where recordQuietly cannot store the failure either. For those the line
    // below is the only trace there will be, which is why it carries the error
    // itself and not just a sentence -- the stack survives in the service log.
    console.error("act: the Sync now button's run failed", error);
    return { error: messageOf(error) };
  } finally {
    // Every path that reached the sync, including both failures. A thrown run
    // and a lost race both change what the page should say -- the first wrote a
    // failure record, the second means another run is live -- so the page is
    // stale after all three outcomes, not just the good one. (requireSession()
    // redirects above the try, so an unauthenticated caller never gets here;
    // nothing changed for them to see, and there is no page of ours for them
    // to be standing on.)
    revalidateActSync();
  }
}
