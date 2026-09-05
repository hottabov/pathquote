"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui-kit";

/**
 * The error boundary for everything inside the signed-in shell. Without it a
 * thrown query — a dropped database connection, a migration not yet applied
 * (see the 2026-08-31 incident noted in src/auth.ts) — reaches Next's own
 * unstyled fallback, which drops the user out of the app entirely with no way
 * back but the browser's reload button.
 *
 * The message is deliberately generic: `error.message` is whatever a Prisma
 * or engine failure happened to say, which can name tables, columns and
 * connection strings. It goes to the server log (where the digest already
 * points) rather than onto the screen. `reset()` re-renders the failed route
 * in place, which is all a transient failure needs.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] unhandled render error", error);
  }, [error]);

  return (
    <EmptyState
      icon={TriangleAlert}
      title="Something went wrong"
      description="This page couldn't be loaded. Trying again often clears it — if it doesn't, the error has been logged."
      action={
        <div className="flex flex-col items-center gap-2">
          <Button type="button" onClick={reset} className="h-11 px-4 bg-brand text-white hover:bg-brand/90">
            Try again
          </Button>
          {/* The digest is the only handle support has on the server-side
              log entry for this exact failure, so it's worth showing even
              though it means nothing to the person reading it. */}
          {error.digest ? (
            <span className="font-mono text-xs text-slate-400">{error.digest}</span>
          ) : null}
        </div>
      }
    />
  );
}
