"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { describeSyncAttempt, type SyncAttempt } from "@/lib/act/sync-view";

/**
 * The Sync now button, and whatever one press of it came back as.
 *
 * Same shape as ContactsVisibilityEditor and CatalogVisibilityEditor:
 * `useTransition` for the pending state, a toast on success, `role="alert"` on
 * a failure, one `Button variant="brand"` at `h-11`. The words are not decided
 * here -- `hint` arrives from the page and `describeSyncAttempt` turns the
 * settled call into a message, both from src/lib/act/sync-view.ts, where they
 * have tests. What is left here is the part a pure function cannot hold: the
 * transition, and the try/catch below.
 *
 * THE TRY/CATCH IS THE POINT OF THIS COMPONENT. This is the one button in the
 * app whose server action can fail to come back while its work carries on: the
 * worst case the delta can produce is ~43 minutes and nothing in the
 * application bounds it, so nginx answers 504 at its `proxy_read_timeout` while
 * the sync keeps the lock, finishes, and writes its record. In Next.js 16 that
 * arrives here as a REJECTED promise carrying "An unexpected response was
 * received from the server." -- see the long note on `describeSyncAttempt` for
 * how that was read off Next's own reducer rather than assumed. Without the
 * catch, that rejection escapes the transition and takes the whole route down
 * to its error boundary, replacing the page that was about to be able to answer
 * the question. With it, the reader is told the truth: no answer came back, the
 * sync did not stop, reload and look.
 *
 * `window.location.reload()` rather than `router.refresh()` for that control,
 * because the two are different promises. A refresh re-renders the route in
 * place; a reload is what the sentence says and what the reader would do by
 * hand, and after a timed-out action there is no reason to prefer keeping any
 * client state over starting clean.
 */
export function ActSyncPanel({
  hint,
  action,
}: {
  /** What the button does, before the click. Decided by the page. */
  hint: string;
  action: () => Promise<{ error?: string; warning?: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [attempt, setAttempt] = useState<SyncAttempt | null>(null);
  const toast = useToast();

  function run() {
    setAttempt(null);
    startTransition(async () => {
      let settled: SyncAttempt;
      try {
        settled = describeSyncAttempt({ answered: true, result: await action() });
      } catch (error) {
        // Logged but not shown. Whatever reaches here is about the HTTP
        // exchange, not about the sync: the 504 case arrives as Next's own
        // generic "An unexpected response was received from the server.", which
        // would read on this page as a sentence about ACT! and would be the one
        // wrong answer the section can give.
        //
        // The console is where it goes instead of nowhere. The server side of
        // this button logs its failures (`console.error` in
        // src/lib/actions/act-sync.ts), and discarding the value here left a
        // 504, an `E715` stale action id after a deploy and a real bug in this
        // component looking identical from the outside -- three different
        // things to do about them, and nothing anywhere saying which it was.
        console.error("act: the Sync now action did not return", error);
        settled = describeSyncAttempt({ answered: false });
      }

      if (settled.outcome === "done") {
        // The page beneath this has already been revalidated by the action's
        // `finally`, so it is about to say what the run did; the toast is only
        // the "that's finished" the reader needs while they are looking at the
        // button.
        toast.success(settled.message);
        setAttempt(null);
        return;
      }
      setAttempt(settled);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {attempt ? (
        <div
          role="alert"
          className={
            attempt.outcome === "failed"
              ? "rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800"
              : "rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          }
        >
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{attempt.message}</span>
          </p>
          {attempt.outcome === "no-answer" ? (
            <Button
              variant="ghost"
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 h-11 px-2 text-amber-900 underline underline-offset-2"
            >
              <RotateCw className="size-4" data-icon="inline-start" aria-hidden="true" />
              Reload this page
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Button
          variant="brand"
          type="button"
          onClick={run}
          disabled={pending}
          className="h-11 w-full shrink-0 sm:w-fit"
        >
          <RefreshCw
            className={pending ? "size-4 animate-spin" : "size-4"}
            data-icon="inline-start"
            aria-hidden="true"
          />
          {pending ? "Syncing…" : "Sync now"}
        </Button>
        {/* While it runs, what it is doing -- a spinner on its own says only
            that something is happening, which is no help to somebody deciding
            whether to wait. `aria-live` so the change is announced rather than
            only drawn. */}
        <p aria-live="polite" className="text-xs text-slate-500 sm:max-w-prose">
          {pending
            ? "Reading the changes from ACT! and writing them into PathQuote. This usually takes a few seconds. Leave this page open — closing it does not stop the sync, but you will not see the result."
            : hint}
        </p>
      </div>
    </div>
  );
}
