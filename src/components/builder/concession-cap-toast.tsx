"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui-kit/client";

/**
 * Toasts the ADMIN-only non-blocking concession-cap warning exactly once —
 * on the save that actually carries the document from within the region's
 * discount cap to over it — instead of on every mutation while it merely
 * stays over the cap (the old behaviour: every mutating server action
 * returns the same `warning` from `recalcAndEnforce` while `exceedsCap`
 * stays true, and every field that touched money used to toast it
 * unconditionally). The persistent state itself now lives in
 * `ConcessionCapBadge` in the Summary panel, on screen for as long as it's
 * true — a toast is only for the moment it *became* true.
 *
 * `[documentId]/page.tsx` (a server component) re-renders and re-passes new
 * props to this component after every mutating action, via each action's
 * own `revalidatePath`. That re-render is what lets a plain `useRef`
 * compare "was the document over the cap last render" against "is it over
 * the cap now" — no extra plumbing back through the server actions
 * themselves, and no risk of firing on the first render of an
 * already-over-cap document (the ref's initial value is `exceedsCap`
 * itself, not `false`, so a page load that's already over cap is never
 * mistaken for a fresh transition into it).
 *
 * Mounted only for an ADMIN (see the caller) — a MANAGER's save that would
 * cross the cap is rejected and rolled back outright (see
 * `recalcAndEnforce`), so a MANAGER's own actions can never produce this
 * transition; their rejection toast is a separate, unrelated thing that
 * stays exactly as it was.
 */
export function ConcessionCapToast({
  exceedsCap,
  message,
}: {
  exceedsCap: boolean;
  message: string | null;
}) {
  const toast = useToast();
  const wasOverCap = useRef(exceedsCap);

  useEffect(() => {
    if (exceedsCap && !wasOverCap.current && message) {
      toast.info(message);
    }
    wasOverCap.current = exceedsCap;
  }, [exceedsCap, message, toast]);

  return null;
}
