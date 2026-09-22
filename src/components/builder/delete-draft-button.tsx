"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Tooltip, useConfirm } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { deleteDraft } from "@/lib/actions/documents";

/**
 * Deletes the current draft. Builder-local equivalent of
 * src/components/catalog/delete-button.tsx (which still uses
 * `window.confirm` — out of scope for Phase 5b Task B, which only covers
 * the documents list and builder screens) but built on the shared
 * `useConfirm` dialog instead. On success `deleteDraft` redirects away
 * itself, same as the catalog version, so there is no post-delete state to
 * handle here beyond the error branch.
 */
export function DeleteDraftButton({
  documentId,
  className,
}: {
  documentId: string;
  /** Lets the caller size it to match whatever row it sits in -- today the
   * Preview / Download / Delete row in the Summary card, where all three
   * have to be the same shape or the row reads as two buttons and an
   * afterthought. */
  className?: string;
}) {
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Delete this draft?",
      description: "This can't be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await deleteDraft(documentId);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Tooltip label="Delete this draft">
        <button
          type="button"
          onClick={handleClick}
          disabled={pending}
          aria-label="Delete this draft"
          className="focus-ring flex h-11 w-full items-center justify-center rounded-lg border border-rose-200 bg-white text-rose-600 transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none disabled:opacity-60 md:hover:bg-rose-50"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </Tooltip>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
