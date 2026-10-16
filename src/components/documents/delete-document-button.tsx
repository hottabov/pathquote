"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/documents";
import type { DocumentStatus, SigningStatus } from "@prisma/client";

/** What the delete flow needs to know about a row: its id for the action,
 * and the three things the confirmation copy is written from. */
export type DeletableQuote = {
  id: string;
  /** Display number (or "Quote draft" fallback) used in the aria-label and
   * confirm dialog copy. */
  numberLabel: string;
  status: DocumentStatus;
  signingStatus: SigningStatus;
};

/**
 * The "delete document" flow of the /quotes list -- confirm, run the server
 * action, toast the outcome -- held ONCE for the whole list rather than once
 * per row.
 *
 * It used to be a component per row carrying `useConfirm`, `useToast` and a
 * `useTransition` of its own, which at 600 rows was 1,800 hook instances to
 * hydrate for a button almost nobody clicks. The list now calls this hook
 * once and hands each row a plain `<button>` (`DeleteDocumentButton` below)
 * that reports which row was clicked; `pendingId` tells that row to disable
 * itself while its action runs.
 *
 * Visibility is decided by the caller (`toQuoteListRows`, ./quote-list-rows.ts)
 * -- a MANAGER only ever sees their own documents in this list already
 * (`documentWhereForUser`), so "author or admin" for a DRAFT collapses to "any
 * MANAGER may delete a DRAFT they see, admin always can"; a FINAL document only
 * shows the button for an ADMIN, unless it is also SIGNED, in which case it
 * only shows for a DEVELOPER (see `canDeleteDocument`, src/lib/signing/state.ts,
 * and `isDeveloperRole`, src/lib/roles.ts, for why that one status has its own
 * rule). `deleteDocument` (src/lib/actions/documents.ts) re-checks scope, the
 * SIGNED/developer rule, and the FINAL-requires-admin rule server-side
 * regardless of what's rendered.
 *
 * `onDeleted` fires after a successful delete with the row's id, so a list
 * holding rows the server page did not render (the "Show all" remainder) can
 * drop the row itself rather than wait for a payload that will not mention it.
 */
export function useDeleteDocument({
  action,
  onDeleted,
}: {
  action: (documentId: string) => Promise<ActionResult>;
  onDeleted?: (documentId: string) => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function requestDelete(row: DeletableQuote) {
    const { numberLabel } = row;
    // A SIGNED quote's confirmation is deliberately its own branch, not a
    // variant of the FINAL copy below: this button only ever renders for a
    // SIGNED document when the viewer is a DEVELOPER (see the hook's doc
    // comment), and that developer is about to destroy a client's signed,
    // archived record and both signature images along with it -- a testing
    // affordance, not an everyday delete, so the dialog needs to say exactly
    // that rather than reuse "finalized" wording that would undersell what's
    // actually being destroyed.
    const confirmed =
      row.signingStatus === "SIGNED"
        ? await confirm({
            title: `Permanently destroy signed ${numberLabel}?`,
            description: `${numberLabel} was signed by the client. Deleting it destroys the archived signed PDF and both signature images for good, along with the row itself -- this is a developer-only testing action, not an ordinary delete, and it cannot be recovered.`,
            confirmLabel: "Destroy signed quote",
            tone: "danger",
          })
        : row.status === "FINAL"
          ? await confirm({
              title: `Delete finalized ${numberLabel}?`,
              description: `Deletes finalized ${numberLabel} permanently. Number will NOT be reused.`,
              confirmLabel: "Delete",
              tone: "danger",
            })
          : await confirm({
              title: `Delete ${numberLabel}?`,
              description: `Deletes ${numberLabel} permanently. This can't be undone.`,
              confirmLabel: "Delete",
              tone: "danger",
            });
    if (!confirmed) return;

    setPendingId(row.id);
    startTransition(async () => {
      try {
        const result = await action(row.id);
        if (result?.error) {
          toast.error(result.error);
          return;
        }
        toast.success(`Deleted ${numberLabel}`);
        onDeleted?.(row.id);
      } finally {
        setPendingId(null);
      }
    });
  }

  return { requestDelete, pendingId: pending ? pendingId : null };
}

/**
 * The per-row trash icon. Stateless: the list's `useDeleteDocument` owns the
 * flow, this only says which row was clicked and greys out while that row's
 * action runs.
 *
 * Deliberately not nested inside the row's own navigation `<Link>` (a
 * `<button>` inside an `<a>` is invalid HTML and would also fire both a click
 * and a navigation) -- it sits in its own cell, and `LinkedRowsBody`
 * (src/components/ui-kit/list-table.tsx) leaves clicks on a `<button>` alone.
 */
export function DeleteDocumentButton({
  row,
  pending,
  onClick,
}: {
  row: DeletableQuote;
  pending: boolean;
  onClick: (row: DeletableQuote) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => onClick(row)}
      disabled={pending}
      aria-label={`Delete ${row.numberLabel}`}
      className="focus-ring size-11 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
    >
      <Trash2 className="size-4" aria-hidden="true" />
    </Button>
  );
}
