import { TriangleAlert } from "lucide-react";

/**
 * Persistent "over the region's discount cap" indicator for the builder's
 * Summary panel. Replaces the old behaviour of toasting the ADMIN-only
 * non-blocking concession warning on *every* mutation while the document
 * stayed over the cap, including edits that had nothing to do with money —
 * the owner's complaint was exactly that: a message that disappears is the
 * wrong shape for a fact that's still true five minutes later. This is that
 * fact, on screen for as long as it's true: the caller (see
 * `[documentId]/page.tsx`) only renders this component while
 * `documentConcession.exceedsCap` is true, so it appears and disappears
 * with the document's own state, no extra wiring needed here.
 *
 * `message` is the same `concessionCapMessage(...)` string every mutating
 * server action already builds (`recalcDocument`, src/lib/actions/documents.ts)
 * and the one-time transition toast uses (`ConcessionCapToast`) — one
 * sentence, reused everywhere it's shown, rather than a shorter paraphrase
 * that could drift from it.
 *
 * Styled as a warning (amber), not an error (rose/destructive) — a MANAGER
 * can save this state too (2026-09-17; their save used to be
 * rejected outright, see `recalcAndEnforce`), and an ADMIN may save it as a
 * draft. Finalizing it is refused for everyone (`validateFinalizable`), and
 * the Finalize button says so.
 */
export function ConcessionCapBadge({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}
