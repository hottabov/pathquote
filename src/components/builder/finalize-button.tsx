"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { finalizeDocument } from "@/lib/actions/finalize";
import { unmetBlockers, type ReadinessRow } from "@/lib/quote-readiness";

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
}: {
  documentId: string;
  /**
   * Every readiness row for this quote, from `quoteReadiness`. The button
   * reads the same rows the rail's ReadinessPanel renders, which is the
   * whole point of them existing: the panel cannot say "ready" while this
   * button refuses, because there is only one answer. The region caps and
   * per-item discount limits are rows too. The server enforces the same
   * state regardless of what arrives here.
   */
  rows: ReadinessRow[];
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const unmet = unmetBlockers(rows);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Finalize this document?",
      description: "Assigns a number and freezes prices and company details.",
      confirmLabel: "Finalize",
    });
    if (!confirmed) return;

    // A failed finalize is a toast, not a line under the button: the button
    // sits in the quote bar, where anything below it adds height to a header
    // every tab shares.
    startTransition(async () => {
      const result = await finalizeDocument(documentId);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Finalized as ${result.number}`);
      router.refresh();
    });
  }

  // What is stopping this quote is said once, in the Summary panel — not a
  // second time under this button. The
  // button lives in the quote bar, whose height every tab inherits, so a
  // one- or two-line explanation here pushed the whole header down for as
  // long as the quote was unfinished, which is most of a quote's life. The
  // reason survives as the disabled state and as the button's title, for a
  // hover on the control itself.
  const blockedReason =
    unmet.length === 0
      ? undefined
      : unmet.length === 1
        ? // The row's `detail` is the specific problem ("M-7220: knife
          // size"); its `label` is only the heading, which reads as nonsense
          // in a sentence.
          `Left to do: ${unmet[0].detail ?? unmet[0].label.toLowerCase()}`
        : `${unmet.length} things left before this can be finalized — see the Summary panel.`;

  return (
    <Button
      type="button"
      onClick={handleClick}
      disabled={pending || unmet.length > 0}
      title={blockedReason}
      variant="brand"
      size="touch"
    >
      <CheckCircle2 className="size-4" data-icon="inline-start" aria-hidden="true" />
      {pending ? "Finalizing…" : "Finalize"}
    </Button>
  );
}
