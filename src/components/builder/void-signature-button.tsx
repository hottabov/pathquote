"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { fieldInputClass } from "@/components/ui-kit";
import { voidSignature } from "@/lib/actions/finalize";

/**
 * ADMIN-only (spec §6): annuls a client's signature and reopens the quote to
 * DRAFT. Unlike Unfinalize this is the only path that reopens a SIGNED quote,
 * so it is deliberately heavier — a reason is MANDATORY (the Void button stays
 * disabled until one is typed) and the signed revision is kept as a legal
 * record. The page renders this only for an admin on a SIGNED quote; the
 * server (`voidSignature` → `requireAdmin`) is the real boundary.
 */
export function VoidSignatureButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (reason.trim() === "") return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await voidSignature(documentId, reason.trim());
        if ("error" in result) {
          setError(result.error);
          return;
        }
        toast.success("Signature voided — quote back to draft");
        setOpen(false);
        setReason("");
        router.refresh();
      } catch {
        setError("Forbidden");
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        onClick={() => setOpen(true)}
        className="h-11 w-full"
      >
        <ShieldOff className="size-4" data-icon="inline-start" aria-hidden="true" />
        Void signature
      </Button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-slate-900/40 transition-opacity duration-150 motion-reduce:transition-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg bg-white p-6 outline-none transition-all duration-150 motion-reduce:transition-none data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <Dialog.Title className="text-lg font-medium">Void the client&apos;s signature?</Dialog.Title>
            <Dialog.Description className="text-sm text-neutral-500">
              The quote goes back to DRAFT. The signed version stays on file as a permanent record — this
              only annuls the signature. A reason is required.
            </Dialog.Description>

            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              placeholder="Why is this signature being voided?"
              className={fieldInputClass}
              aria-label="Reason for voiding the signature"
            />

            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending || reason.trim() === ""}
                onClick={submit}
              >
                {pending ? "Voiding…" : "Void signature"}
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
