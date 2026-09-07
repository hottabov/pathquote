"use client";

import { useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";
import { Button } from "@/components/ui/button";

/**
 * The pad plus its chrome. Full-screen on a phone (where a signature drawn
 * in a small box looks nothing like the person's real one) and a large
 * fixed area on a desktop, chosen by CSS breakpoint rather than by sniffing
 * the user agent.
 *
 * Built on Base UI's `Dialog` — the same primitive `ConfirmProvider` uses via
 * `AlertDialog` (see src/components/ui-kit/confirm-dialog.tsx) — rather than
 * a hand-rolled `<div role="dialog">`. That gets focus trapping and
 * Escape-to-close for free, and it is also what correctly locks body scroll:
 * Base UI's modal `Dialog.Root` runs its own `useScrollLock` internally
 * whenever the dialog is open, so there is no ad-hoc
 * `document.body.style.overflow` toggling here to place in a ref callback or
 * a `useEffect` — the bug that motivated that question upstream doesn't
 * arise because this component never touches body scroll itself.
 */
export function SignatureDialog({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [hasInk, setHasInk] = useState(false);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-slate-900/40 transition-opacity duration-150 motion-reduce:transition-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          aria-label={title}
          className="fixed inset-0 z-50 flex flex-col gap-4 bg-white p-4 outline-none transition-all duration-150 motion-reduce:transition-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-auto sm:w-full sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:p-6 sm:data-[ending-style]:scale-95 sm:data-[starting-style]:scale-95"
        >
          <Dialog.Title className="text-lg font-medium">{title}</Dialog.Title>
          <Dialog.Description className="text-sm text-neutral-500">
            Draw your signature below.
          </Dialog.Description>

          <div className="min-h-0 flex-1 sm:h-56 sm:flex-none">
            <SignaturePad ref={padRef} onChange={setHasInk} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => padRef.current?.clear()}
              disabled={!hasInk}
            >
              Clear
            </Button>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!hasInk}
                onClick={() => {
                  const dataUrl = padRef.current?.toDataUrl();
                  if (dataUrl) onConfirm(dataUrl);
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
