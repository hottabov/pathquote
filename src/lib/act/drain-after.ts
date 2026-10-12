// The fast path: drain one quote's ActOutbox row right after the event that
// queued it -- a finalise, the client's signature, an acceptance -- rather
// than leaving it for the nightly drain.
//
// Scheduled with `after()` from next/server, the pattern completeSigning
// already uses for its completion emails (src/lib/actions/signing-client.ts):
// the callback runs once the action's response has gone, so the manager or
// the client is never kept waiting on ACT!. `after()` is available in Server
// Functions (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
// after.md), and the three callers -- finalizeDocument and acceptQuote in
// src/lib/actions/finalize.ts, completeSigning in
// src/lib/actions/signing-client.ts -- are server actions, called only from
// client components (finalize-button.tsx, accept-button.tsx,
// client-action-bar.tsx).
//
// BEST-EFFORT, AND NEVER THE ACTION'S PROBLEM. The event has committed by the
// time this is called, and it stands whatever happens here: every failure is
// caught and logged, and the row waits for the nightly drain. That includes
// scheduling itself -- `after()` throws when called outside a request -- and
// building the client: actClientFromEnv throws when an ACT_* variable is
// missing, which is why it is called inside the callback, inside its try,
// and only once the switch is known to be on.

import { after } from "next/server";
import { actClientFromEnv } from "@/lib/act/client";
import { drainActOutbox, readActWriteSwitch } from "@/lib/act/drain";

/** After the response, drain `documentId`'s row; `event` names the caller in the log. */
export function drainAfterResponse(documentId: string, event: "finalise" | "signature" | "acceptance"): void {
  try {
    after(async () => {
      try {
        // Off: nothing to do, and no reason to need ACT_* at all.
        if (!(await readActWriteSwitch())) return;
        const result = await drainActOutbox(actClientFromEnv(), { onlyDocumentId: documentId });
        if (result.status === "busy") {
          console.info(`[act] another drain was running after the ${event}; the row waits for the next one`, { documentId });
        }
      } catch (error) {
        console.error(`[act] the drain after the ${event} failed; the row waits for the nightly drain`, {
          documentId,
          error,
        });
      }
    });
  } catch (error) {
    console.error(`[act] could not schedule the drain after the ${event}; the row waits for the nightly drain`, {
      documentId,
      error,
    });
  }
}
