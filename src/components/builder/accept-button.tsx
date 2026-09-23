"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { acceptQuote } from "@/lib/actions/finalize";

/**
 * Accepts a client-signed quote into production (CLIENT_SIGNED → ACCEPTED,
 * spec §1). The page only renders this once the client has signed AND the
 * manager has signed too (`canAccept`'s two conditions), so the button itself
 * just confirms and calls — the server (`acceptQuote`) re-checks both and is
 * the real boundary, hence the try/catch around the call.
 */
export function AcceptButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: "Accept this quote into production?",
      description:
        "Both signatures are on it. Accepting marks the deal committed and moves the quote into production.",
      confirmLabel: "Accept",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      try {
        const result = await acceptQuote(documentId);
        if ("error" in result) {
          setError(result.error);
          return;
        }
        toast.success("Quote accepted");
        router.refresh();
      } catch {
        setError("Forbidden");
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button type="button" onClick={handleClick} disabled={pending} size="touch" className="w-full">
        <CheckCircle2 className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Accepting…" : "Accept quote"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
