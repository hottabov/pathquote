"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" styles the confirm button destructively — use for delete /
   * irreversible actions. */
  tone?: "default" | "danger";
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

type PendingConfirm = ConfirmOptions;

/**
 * Replaces `window.confirm` app-wide: mount once near the root of the (app)
 * tree, then call `useConfirm()` anywhere below it to await a boolean
 * instead of blocking the main thread. Built on Base UI's `AlertDialog`
 * (already a project dependency) rather than hand-rolled, so focus trapping,
 * Escape-to-close, and `role="alertdialog"` labelling come for free.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setPending(options);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setPending(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-slate-900/40 transition-opacity duration-150 motion-reduce:transition-none data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <AlertDialog.Popup
            className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-6 shadow-lg outline-none transition-all duration-150 motion-reduce:transition-none data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0"
          >
            {pending ? (
              <>
                <AlertDialog.Title className="text-base font-semibold text-brand-dark">
                  {pending.title}
                </AlertDialog.Title>
                {pending.description ? (
                  <AlertDialog.Description className="mt-2 text-sm text-slate-500">
                    {pending.description}
                  </AlertDialog.Description>
                ) : null}
                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 sm:h-9"
                    onClick={() => settle(false)}
                  >
                    {pending.cancelLabel ?? "Cancel"}
                  </Button>
                  <Button
                    variant="brand"
                    type="button"
                    autoFocus
                    onClick={() => settle(true)}
                    className={cn(
                      "h-11 sm:h-9",
                      // The shared `destructive` Button variant is tinted
                      // (bg-destructive/10), which is right for a delete
                      // button sitting inside a form but far too quiet for
                      // the confirm step of a destructive dialog, where this
                      // is the action the dialog exists to make explicit.
                      pending.tone === "danger" &&
                        "bg-destructive text-white hover:bg-destructive/90"
                    )}
                  >
                    {pending.confirmLabel ?? "Confirm"}
                  </Button>
                </div>
              </>
            ) : null}
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}

/** Returns a `confirm(options) => Promise<boolean>` function — `await` it
 * in place of `window.confirm`. Must be called from inside `ConfirmProvider`
 * (mounted once in `(app)/layout.tsx`). */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return ctx;
}
