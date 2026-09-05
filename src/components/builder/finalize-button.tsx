"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { finalizeDocument } from "@/lib/actions/finalize";

/**
 * Turns a DRAFT into a numbered FINAL document. Finalizing is a one-way
 * trip for a normal user (only an admin can undo it — see
 * UnfinalizeButton), so unlike the lightweight remove-item/delete-draft
 * buttons elsewhere in the builder this gets its own confirm dialog
 * spelling out exactly what happens, a success toast naming the assigned
 * number, and an explicit `router.refresh()`: the page's server component
 * needs to re-read `document.status`/`number` to flip the whole builder
 * into its read-only FINAL view (every section below switches `readOnly`),
 * not just have one row's data change underneath it.
 */
export function FinalizeButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Finalize this document?",
      description: "Assigns a number and freezes prices and company details.",
      confirmLabel: "Finalize",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await finalizeDocument(documentId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      toast.success(`Finalized as ${result.number}`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="h-11 w-full bg-brand text-white hover:bg-brand/90"
      >
        <CheckCircle2 className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Finalizing…" : "Finalize"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
