"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { finalizeDocument } from "@/lib/actions/finalize";
import type { ReadinessRow } from "@/lib/quote-readiness";

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
export function FinalizeButton({
  documentId,
  rows,
  capBlocker = null,
}: {
  documentId: string;
  /**
   * Every readiness row for this quote, from `quoteReadiness`. The button
   * reads the same rows the rail's ReadinessPanel renders, which is the
   * whole point of them existing: the panel cannot say "ready" while this
   * button refuses, because there is only one answer. The server enforces
   * the same state regardless of what arrives here.
   */
  rows: ReadinessRow[];
  /**
   * The region discount-cap / markup-ceiling message when the quote is over
   * it, or null. A hard stop for every role -- see `validateFinalizable`.
   * Not a readiness row: it is not something you complete, it is a limit you
   * have to come back under.
   */
  capBlocker?: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unmet = rows.filter((row) => row.blocking && !row.met);

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
        disabled={pending || unmet.length > 0 || capBlocker !== null}
        variant="brand"
        size="touch"
        className="w-full"
      >
        <CheckCircle2 className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Finalizing…" : "Finalize"}
      </Button>
      {capBlocker ? (
        <p role="status" className="text-sm text-destructive">
          Can&rsquo;t finalize — {capBlocker} Bring it within the limit first.
        </p>
      ) : null}
      {unmet.length > 0 ? (
        <p role="status" className="text-sm text-amber-700">
          {/* The row's `detail` is the specific problem ("EL-3220 has no
              price"); its `label` is only the heading ("13 machines
              priced"), which reads as nonsense in a sentence. */}
          {unmet.length === 1
            ? `Left to do: ${unmet[0].detail ?? unmet[0].label.toLowerCase()}.`
            : `${unmet.length} things left before this can be finalized.`}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
