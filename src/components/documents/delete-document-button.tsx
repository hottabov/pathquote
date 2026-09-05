"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/documents";
import type { DocumentStatus } from "@prisma/client";

/**
 * Per-row "delete document" icon button on the /documents list (desktop
 * table's Actions column and the mobile card). Visibility is decided by the
 * caller (`DocumentsPage`) — a MANAGER only ever sees their own documents
 * in this list already (`documentWhereForUser`), so "author or admin" for a
 * DRAFT collapses to "any MANAGER may delete a DRAFT they see, admin
 * always can"; a FINAL document only ever shows this button for an ADMIN.
 * `deleteDocument` (src/lib/actions/documents.ts) re-checks both scope and
 * the FINAL-requires-admin rule server-side regardless of what's rendered
 * here.
 *
 * Deliberately not nested inside the row/card's own navigation `<Link>`
 * (a `<button>` inside an `<a>` is invalid HTML and would also fire both a
 * click and a navigation) — the desktop version sits in its own `<td>`
 * outside any `RowCell` link, and the mobile version sits beside the card's
 * link, not inside it.
 */
export function DeleteDocumentButton({
  documentId,
  numberLabel,
  status,
  action,
}: {
  documentId: string;
  /** Display number (or "Quote draft" fallback) used in the aria-label and
   * confirm dialog copy. */
  numberLabel: string;
  status: DocumentStatus;
  action: (documentId: string) => Promise<ActionResult>;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  async function handleClick() {
    const confirmed =
      status === "FINAL"
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

    startTransition(async () => {
      const result = await action(documentId);
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      toast.success(`Deleted ${numberLabel}`);
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={handleClick}
      disabled={pending}
      aria-label={`Delete ${numberLabel}`}
      className="focus-ring size-11 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
    >
      <Trash2 className="size-4" aria-hidden="true" />
    </Button>
  );
}
