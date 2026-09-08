"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { revokeSigningLink } from "@/lib/actions/signing";

/**
 * Kills the outstanding client signing link and returns the quote to
 * NOT_SENT. Rendered alongside `SendToClientButton` (in the same file), only
 * while `canRevoke(document.signingStatus)` (src/lib/signing/state.ts) is
 * true -- i.e. only while a link is actually live, matching that function's
 * own DocuSign-Void-style restriction (nothing revokes a completed quote).
 *
 * The confirmation calls out the one-way consequence a manager might not
 * expect: this kills a link the client could be looking at right now.
 */
export function RevokeSigningLinkButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Revoke this signing link?",
      description:
        "The client's link stops working immediately, even if they have it open right now. They'll be emailed to let them know. The quote goes back to Not sent.",
      confirmLabel: "Revoke",
      tone: "danger",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await revokeSigningLink(documentId);
      if (result.error) {
        setError(result.error);
        return;
      }
      toast.success("Signing link revoked");
      router.refresh();
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
        <Ban className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Revoking…" : "Revoke link"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
