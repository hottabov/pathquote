"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { PenLine, Printer, Send } from "lucide-react";
import { SignatureDialog } from "./signature-dialog";
import { signAsClient, completeSigning, declineSigning } from "@/lib/actions/signing-client";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Sign | Print | Send, sticky at the foot of the client's quote.
 *
 * Send stays disabled until a signature exists, and its confirmation names
 * the quote, the total and the recipient before saying plainly that the
 * signature cannot be changed afterwards (see `ConfirmSend`'s own doc
 * comment) — DocuSign does not say that, which is why its forums are full of
 * people asking to unsign.
 *
 * A drawn-but-unconfirmed signature does NOT disable the Sign button —
 * unlike the placeholder this replaces. `signAsClient` upserts on
 * `[documentId, role]` specifically so a client can reopen the pad and
 * redraw as many times as they like before pressing Send; disabling the
 * button the moment a signature exists would silently take away the one
 * thing this feature adds over a plain "type your name" box (see the
 * design's own D7 and this task's invariant #1).
 *
 * There is no fourth "Decline" button here: three large adjacent buttons,
 * one of which irreversibly kills the deal, is an invitation to a stray
 * thumb. Declining is `DeclineLink`, below, rendered by the page under the
 * quote sheet rather than in this bar.
 */
export function ClientActionBar({
  token,
  completed,
  hasClientSignature,
  quoteNumber,
  total,
  authorName,
  authorEmail,
  signedOn,
}: {
  token: string;
  completed: boolean;
  hasClientSignature: boolean;
  quoteNumber: string;
  total: string;
  authorName: string;
  authorEmail: string;
  /** Already formatted (`formatDateAU`), or `null` when `completed` is
   * false — see `QuotationSignature.signedAt` (src/lib/quotation-data.ts). */
  signedOn: string | null;
}) {
  const router = useRouter();
  const [drawing, setDrawing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (completed) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-medium text-neutral-700">
            Signed{signedOn ? ` ${signedOn}` : ""}
          </span>
          <span className="text-sm text-neutral-500">
            Questions? {authorName}, {authorEmail}
          </span>
          <a
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            href={`/sign/${token}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Download PDF
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-center gap-2">
          <Button type="button" disabled={pending} onClick={() => setDrawing(true)} className="h-11">
            <PenLine className="mr-2 size-4" aria-hidden="true" />
            {hasClientSignature ? "Redraw" : "Sign"}
          </Button>

          <a
            className={cn(buttonVariants({ variant: "outline" }), "h-11")}
            href={`/sign/${token}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Printer className="mr-2 size-4" aria-hidden="true" />
            Print
          </a>

          <Button
            type="button"
            disabled={!hasClientSignature || pending}
            onClick={() => setConfirming(true)}
            className="h-11"
          >
            <Send className="mr-2 size-4" aria-hidden="true" />
            Send
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      {drawing ? (
        <SignatureDialog
          title="Sign this quote"
          confirmLabel="Done"
          onCancel={() => setDrawing(false)}
          onConfirm={(dataUrl) => {
            setError(null);
            startTransition(async () => {
              const result = await signAsClient(token, dataUrl);
              if (result.error) {
                setError(result.error);
                return;
              }
              setDrawing(false);
              router.refresh();
            });
          }}
        />
      ) : null}

      <ConfirmSend
        open={confirming}
        quoteNumber={quoteNumber}
        total={total}
        authorName={authorName}
        pending={pending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setError(null);
          startTransition(async () => {
            const result = await completeSigning(token);
            if (result.error) {
              setError(result.error);
              setConfirming(false);
              return;
            }
            setConfirming(false);
            router.refresh();
          });
        }}
      />
    </>
  );
}

/**
 * The one irreversible step in this whole flow, and the only place this
 * feature asks for a second tap before doing something it cannot undo. Built
 * on Base UI's `AlertDialog` — the same primitive `ConfirmProvider` uses
 * (src/components/ui-kit/confirm-dialog.tsx) — rather than that provider
 * itself: `ConfirmProvider` is mounted once in the `(app)` layout, which this
 * public, unauthenticated page must never import from (see src/app/(sign)/
 * layout.tsx's own doc comment), and its plain title+description shape has
 * nowhere to put the bolded amount and recipient this confirmation needs
 * anyway.
 *
 * The last line is load-bearing, not decoration: it states plainly that the
 * signature cannot be changed once sent. DocuSign has no equivalent
 * statement at its own point of no return, which is why its support forums
 * are full of people asking how to "unsign" an envelope — the honest answer
 * being that they can't, and nobody told them beforehand.
 */
function ConfirmSend({
  open,
  quoteNumber,
  total,
  authorName,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  quoteNumber: string;
  total: string;
  authorName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-slate-900/40" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-6 shadow-lg outline-none">
          <AlertDialog.Title className="text-base font-semibold">Send signed quote?</AlertDialog.Title>
          <AlertDialog.Description className="mt-3 text-sm text-neutral-700">
            {quoteNumber} for <strong>{total}</strong> will be sent to <strong>{authorName}</strong>.
          </AlertDialog.Description>
          <p className="mt-2 text-sm text-neutral-500">
            Once sent, this signature cannot be changed.
          </p>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11 sm:h-9" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" className="h-11 sm:h-9" onClick={onConfirm} disabled={pending}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/**
 * "I don't want to sign this" — a restrained text link below the quote
 * sheet, not a button in `ClientActionBar`. Three large adjacent buttons,
 * one of which irreversibly kills the deal, invites a stray thumb; a quiet
 * link a client has to notice and deliberately tap does not.
 *
 * The reason is optional free text, capped the same way `declineSigning`
 * itself caps it (2000 characters) — enforced again here only so a client
 * typing a very long explanation sees it trimmed rather than silently
 * dropped server-side.
 */
export function DeclineLink({ token }: { token: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="mx-auto max-w-4xl px-4 pt-3 pb-36 text-center">
      <button
        type="button"
        className="text-sm text-neutral-400 underline underline-offset-2 hover:text-neutral-600"
        onClick={() => setOpen(true)}
      >
        I don&apos;t want to sign this
      </button>

      <AlertDialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) setOpen(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-slate-900/40" />
          <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-6 text-left shadow-lg outline-none">
            <AlertDialog.Title className="text-base font-semibold">Decline this quote?</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-neutral-500">
              Let the sender know why, if you&apos;d like — this is optional.
            </AlertDialog.Description>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value.slice(0, 2000))}
              rows={3}
              placeholder="Reason (optional)"
              className="mt-3 w-full resize-none rounded-md border border-neutral-300 p-2 text-sm outline-none focus:border-neutral-500"
            />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="h-11 sm:h-9"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                Never mind
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="h-11 sm:h-9"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const result = await declineSigning(token, reason);
                    if (result.error) {
                      setError(result.error);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  });
                }}
              >
                {pending ? "Declining…" : "Decline quote"}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
