"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { unfinalizeDocument } from "@/lib/actions/finalize";

/**
 * Reopens a FINAL quote for editing (spec §4). Available to the OWNER (a
 * manager on their own quote) as well as an ADMIN, and only before the client
 * has signed — the page hides it once `signingStatus` is SIGNED, where an
 * admin gets Void signature instead. This component doesn't re-check the role
 * itself, matching every other lifecycle control here: the server action
 * (`unfinalizeDocument` → `requireSession` + scope) is the real enforcement
 * boundary, which is why the call is wrapped in try/catch rather than assumed
 * to only ever resolve to an `UnfinalizeResult`.
 *
 * When the quote was already SENT, the confirm dialog says so plainly — the
 * client is holding a version that will stop matching, and a resend is needed.
 */
export function UnfinalizeButton({
  documentId,
  wasSent = false,
  sentLabel,
}: {
  documentId: string;
  wasSent?: boolean;
  sentLabel?: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Unfinalize this document?",
      description: wasSent
        ? `The client has already received version ${sentLabel ?? "of this quote"}. After changes you'll need to send the quote again. It goes back to DRAFT and becomes editable — its number is kept and reused when finalized again.`
        : "It goes back to DRAFT and becomes editable again — its number is kept and will be reused if it's finalized again.",
      confirmLabel: "Unfinalize",
      tone: "danger",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      try {
        const result = await unfinalizeDocument(documentId);
        if ("error" in result) {
          setError(result.error);
          return;
        }
        toast.success("Document unfinalized — back to draft");
        router.refresh();
      } catch {
        setError("Forbidden");
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        onClick={handleClick}
        disabled={pending}
        className="h-11 w-full"
      >
        <RotateCcw className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Unfinalizing…" : "Unfinalize"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
