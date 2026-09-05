"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { unfinalizeDocument } from "@/lib/actions/finalize";

/**
 * ADMIN-only escape hatch for a FINAL document issued in error (see
 * `unfinalizeDocument`'s doc comment for why the number survives the round
 * trip). The builder page only ever renders this for `session.user.role ===
 * "ADMIN"` — this component doesn't re-check that itself, matching every
 * other admin-only control in this codebase (the server action is the real
 * enforcement boundary via `requireAdmin`; a manager who somehow triggered
 * this would get `requireAdmin`'s thrown "Forbidden: admin only" rejected
 * back at the call below, which is why that call is wrapped in try/catch
 * rather than assumed to only ever resolve to an `UnfinalizeResult`).
 */
export function UnfinalizeButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Unfinalize this document?",
      description:
        "It goes back to DRAFT and becomes editable again — its number is kept and will be reused if it's finalized again.",
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
