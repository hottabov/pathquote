"use client";

import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/documents";
import type { DocumentStatus, SigningStatus } from "@prisma/client";

/**
 * Per-row "delete document" icon button on the /quotes list (desktop
 * table's Actions column and the mobile card). Visibility is decided by the
 * caller (`DocumentsPage`) — a MANAGER only ever sees their own documents
 * in this list already (`documentWhereForUser`), so "author or admin" for a
 * DRAFT collapses to "any MANAGER may delete a DRAFT they see, admin
 * always can"; a FINAL document only shows this button for an ADMIN, unless
 * it is also SIGNED, in which case it only shows for a DEVELOPER (see
 * `canDeleteDocument`, src/lib/signing/state.ts, and `isDeveloperRole`,
 * src/lib/roles.ts, for why that one status has its own rule). `deleteDocument`
 * (src/lib/actions/documents.ts) re-checks scope, the SIGNED/developer rule,
 * and the FINAL-requires-admin rule server-side regardless of what's
 * rendered here.
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
  signingStatus,
  action,
}: {
  documentId: string;
  /** Display number (or "Quote draft" fallback) used in the aria-label and
   * confirm dialog copy. */
  numberLabel: string;
  status: DocumentStatus;
  signingStatus: SigningStatus;
  action: (documentId: string) => Promise<ActionResult>;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  async function handleClick() {
    // A SIGNED quote's confirmation is deliberately its own branch, not a
    // variant of the FINAL copy below: this button only ever renders for a
    // SIGNED document when the viewer is a DEVELOPER (see this component's
    // own doc comment), and that developer is about to destroy a client's
    // signed, archived record and both signature images along with it -- a
    // testing affordance, not an everyday delete, so the dialog needs to say
    // exactly that rather than reuse "finalized" wording that would
    // undersell what's actually being destroyed.
    const confirmed =
      signingStatus === "SIGNED"
        ? await confirm({
            title: `Permanently destroy signed ${numberLabel}?`,
            description: `${numberLabel} was signed by the client. Deleting it destroys the archived signed PDF and both signature images for good, along with the row itself -- this is a developer-only testing action, not an ordinary delete, and it cannot be recovered.`,
            confirmLabel: "Destroy signed quote",
            tone: "danger",
          })
        : status === "FINAL"
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
