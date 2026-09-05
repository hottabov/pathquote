"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui-kit/client";
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
export function DeleteDraftButton({ documentId }: { documentId: string }) {
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
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="destructive"
        onClick={handleClick}
        disabled={pending}
        className="h-11 w-fit"
      >
        <Trash2 className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Deleting…" : "Delete draft"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
