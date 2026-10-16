// The fast path: drain one quote's ActOutbox row right after the event that
// queued it -- a finalise, the client's signature, an acceptance -- or the
// administrator's action that released it (src/lib/actions/act-outbox.ts),
// rather than leaving it for a later drain over every row.
//
// Scheduled with `after()` from next/server, the pattern completeSigning
// already uses for its completion emails (src/lib/actions/signing-client.ts):
// the callback runs once the action's response has gone, so the manager or
// the client is never kept waiting on ACT!. `after()` is available in Server
// Functions (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
// after.md), and the callers -- finalizeDocument and acceptQuote in
// src/lib/actions/finalize.ts, completeSigning in
// src/lib/actions/signing-client.ts, and the administrator's actions in
// src/lib/actions/act-outbox.ts -- are server actions, called only from
// client components (finalize-button.tsx, accept-button.tsx,
// client-action-bar.tsx, act-admin-actions.tsx).
//
// BEST-EFFORT, AND NEVER THE ACTION'S PROBLEM. The event has committed by the
// time this is called, and it stands whatever happens here: every failure is
// caught and logged, and the row waits for the next drain that reaches it.
// That includes scheduling itself -- `after()` throws when called outside a
// request -- and building the client: actClientFromEnv throws when an ACT_*
// variable is missing, which is why it is called inside the callback, inside
// its try, and only once the switch is known to be on. The drain that reaches
// it is the periodic one every 15 minutes (scripts/act-drain.ts,
// pq-act-drain.timer in the `tools` container) or an inbound sync's, both
// over every row, at the first pass after it falls due.

import { after } from "next/server";
import { actClientFromEnv } from "@/lib/act/client";
import { drainActOutbox, readActWriteSwitch } from "@/lib/act/drain";

/** What becomes of a row this fast path did not write: the end of each log line below. */
/** How long the fast path may spend before leaving the row to the periodic drain. */
const IN_REQUEST_DRAIN_BUDGET_MS = 20_000;

const ROW_WAITS = "the row waits for the next drain that reaches it (the 15-minute drain, the nightly sync's, or the quote's next event)";

/** After the response, drain `documentId`'s row; `event` names the caller in the log. */
export function drainAfterResponse(
  documentId: string,
  event: "finalise" | "signature" | "acceptance" | "administrator's action",
): void {
  try {
    after(async () => {
      try {
        // Off: nothing to do, and no reason to need ACT_* at all.
        if (!(await readActWriteSwitch())) return;
        // A short budget, not the five-minute default: this runs inside the
        // web process, on the pool every request shares. One quote's row is a
        // handful of ACT! calls; if ACT! is slow today the periodic drain
        // picks the row up, as the log line below says.
        const result = await drainActOutbox(actClientFromEnv(), {
          onlyDocumentId: documentId,
          timeBudgetMs: IN_REQUEST_DRAIN_BUDGET_MS,
        });
        if (result.status === "busy") {
          console.info(`[act] another drain was running after the ${event}; ${ROW_WAITS}`, { documentId });
        }
      } catch (error) {
        console.error(`[act] the drain after the ${event} failed; ${ROW_WAITS}`, {
          documentId,
          error,
        });
      }
    });
  } catch (error) {
    console.error(`[act] could not schedule the drain after the ${event}; ${ROW_WAITS}`, {
      documentId,
      error,
    });
  }
}
