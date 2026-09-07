"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { SignatureDialog } from "@/components/signing/signature-dialog";
import { signQuoteAsAuthor } from "@/lib/actions/signing";

/**
 * Lets the document's author (or an admin — the same scope
 * `signQuoteAsAuthor` checks via `documentWhereForUser`, which is also what
 * governs whether this page renders for this viewer at all) apply their
 * signature to a FINAL quote.
 *
 * When the signed-in user has a signature already saved to their profile
 * (drawn once in Account — see `SignatureEditor`), offer it as a one-tap
 * "Use this" alongside "Draw a new one"; with nothing saved, open the pad
 * directly. Both paths call the same action, which always writes a *new*
 * upload rather than pointing at the saved one — see that action's own doc
 * comment for why that copy matters.
 */
export function SignButton({
  documentId,
  hasAuthorSignature,
  savedSignatureUrl,
}: {
  documentId: string;
  /** Whether an AUTHOR row already exists on this document — only changes
   * the button's label ("Sign" vs "Re-sign"); re-signing before the quote is
   * sent is allowed (see `signQuoteAsAuthor`'s NOT_SENT/DECLINED check). */
  hasAuthorSignature: boolean;
  savedSignatureUrl: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [drawing, setDrawing] = useState(false);

  function submit(dataUrl: string) {
    setError(null);
    startTransition(async () => {
      const result = await signQuoteAsAuthor(documentId, dataUrl);
      if (result.error) {
        setError(result.error);
        return;
      }
      setChoosing(false);
      setDrawing(false);
      toast.success("Signature applied");
      router.refresh();
    });
  }

  function handleSignClick() {
    setError(null);
    if (savedSignatureUrl) {
      setChoosing(true);
    } else {
      setDrawing(true);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="outline"
        onClick={handleSignClick}
        disabled={pending}
        className="h-11 w-full"
      >
        <PenLine className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Signing…" : hasAuthorSignature ? "Re-sign" : "Sign"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* The saved-signature choice, styled after SignatureDialog's own
          fixed overlay (src/components/signing/signature-dialog.tsx) for
          visual consistency across the signing feature, but plain markup
          rather than that component itself: this has no canvas and no
          drawing gesture to protect from page scroll. */}
      {choosing ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Sign this quote"
        >
          <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg bg-white p-6">
            <h2 className="text-lg font-medium">Sign this quote</h2>
            <div className="flex h-16 items-end border-b border-slate-300">
              {/* Plain <img>, not next/image: a locally stored upload, same
                  reasoning as SignatureEditor's own preview. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={savedSignatureUrl ?? undefined}
                alt="Your saved signature"
                className="max-h-16 max-w-full object-contain"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Button type="button" disabled={pending} onClick={() => submit("saved")}>
                Use this
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setChoosing(false);
                  setDrawing(true);
                }}
              >
                Draw a new one
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setChoosing(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {drawing ? (
        <SignatureDialog
          title="Sign this quote"
          confirmLabel="Sign"
          onConfirm={submit}
          onCancel={() => setDrawing(false)}
        />
      ) : null}
    </div>
  );
}
