"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { sendQuoteForSignature } from "@/lib/actions/signing";

/**
 * Emails a tokenised signing link to the document's contact. Rendered
 * alongside `SignButton` (src/components/builder/sign-button.tsx) — the
 * builder page (`DocumentActions`) decides whether to show this at all by
 * checking `canSendToClient` server-side first, the same gate this action
 * enforces again on submit; when the verdict there is not `ok`, the page
 * still renders this button but disabled, with the verdict's own reason as
 * its tooltip (a plain `title` attribute, the convention this codebase
 * already uses for a disabled/truncated control — see app-shell.tsx's
 * user-email `title`), rather than hiding it outright, so a manager can see
 * *why* sending isn't available (e.g. "Sign the quote before sending it.")
 * without hunting for it.
 *
 * `title` alone isn't enough: it's hover-only, and a manager on a tablet has
 * no hover. The same reason is also rendered as small, muted text beneath
 * the button — quiet on purpose, so it reads as an explanation rather than
 * an error — kept in sync with the tooltip since both come from the one
 * `disabledReason` prop.
 *
 * The confirmation names the destination address before anything is sent —
 * the one place in this flow a manager can catch a stale or wrong contact
 * email before a credential goes out to it.
 */
export function SendToClientButton({
  documentId,
  contactEmail,
  disabledReason,
}: {
  documentId: string;
  /** The address this would send to — always present when `disabledReason`
   * is null, since `canSendToClient` refuses (with `NO_CONTACT_EMAIL`)
   * before this button is ever enabled without one. */
  contactEmail: string | null;
  /** `canSendToClient`'s verdict reason, or `null` when sending is allowed
   * right now. */
  disabledReason: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (!contactEmail) return;
    const confirmed = await confirm({
      title: "Send this quote for signature?",
      description: `An email with a link to review and sign will be sent to ${contactEmail}.`,
      confirmLabel: "Send",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await sendQuoteForSignature(documentId);
      if (result.error) {
        setError(result.error);
        return;
      }
      toast.success("Sent to client");
      router.refresh();
    });
  }

  const disabled = pending || disabledReason !== null;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        onClick={handleClick}
        disabled={disabled}
        title={disabledReason ?? undefined}
        className="h-11 w-full"
      >
        <Send className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Sending…" : "Send to client"}
      </Button>
      {disabledReason ? <p className="text-xs text-slate-500">{disabledReason}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
