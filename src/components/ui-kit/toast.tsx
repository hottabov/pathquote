"use client";

import { useMemo } from "react";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// `useToastManager` is only re-exported as a type from the package's top
// level entry point — the real runtime hook lives on the `Toast` namespace
// (mirrors `Toast.Root`, `Toast.Provider`, etc.).
const { useToastManager } = BaseToast;

export type ToastVariant = "success" | "error" | "info";

const VARIANT_ICON: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: "border-emerald-200 text-emerald-600",
  error: "border-rose-200 text-rose-600",
  info: "border-brand-accent-ink/40 text-brand-accent-ink",
};

/**
 * Toast host: mount once in `(app)/layout.tsx` alongside `ConfirmProvider`.
 * Built on Base UI's `Toast` primitive (already a project dependency) for
 * its accessible viewport (`role="region"`, `aria-live="polite"` — see
 * `ToastViewport`), swipe-to-dismiss, and pause-on-hover/focus behavior,
 * rather than reimplementing those from scratch.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <BaseToast.Provider timeout={4000} limit={4}>
      {children}
      <BaseToast.Portal>
        {/* `pointer-events-none` is load-bearing, not decoration: below `sm`
            this viewport is a full-width strip pinned to the bottom of the
            screen at `z-50`, so even with no toasts in it, its padding box
            sits directly over the mobile bottom nav (`z-20`) and swallowed
            every tap on those buttons. Each toast re-enables pointer events
            on itself (`pointer-events-auto` on Root) so it stays clickable
            and dismissable. */}
        <BaseToast.Viewport className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end sm:p-0">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

function ToastList() {
  const { toasts } = useToastManager();

  return toasts.map((toast) => {
    const variant: ToastVariant =
      toast.type === "success" || toast.type === "error" ? toast.type : "info";
    const Icon = VARIANT_ICON[variant];

    return (
      <BaseToast.Root
        key={toast.id}
        toast={toast}
        className={cn(
          "pointer-events-auto flex w-[calc(100vw-2rem)] max-w-sm items-start gap-3 rounded-xl border bg-white p-4 shadow-lg transition-all duration-150 motion-reduce:transition-none",
          "data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          VARIANT_CLASSES[variant]
        )}
      >
        <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <BaseToast.Title className="text-sm font-medium text-brand-dark" />
          {toast.description ? (
            <BaseToast.Description className="mt-0.5 text-sm text-slate-500" />
          ) : null}
        </div>
        <BaseToast.Close
          aria-label="Dismiss"
          className="focus-ring -m-2.5 flex size-11 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="size-4" />
        </BaseToast.Close>
      </BaseToast.Root>
    );
  });
}

/**
 * `const toast = useToast(); toast.success("Saved")` — must be called from
 * inside `ToastProvider` (mounted once in `(app)/layout.tsx`). Auto-dismisses
 * after 4s; the toast viewport pauses that timer on hover/focus.
 */
export function useToast() {
  const manager = useToastManager();

  return useMemo(
    () => ({
      show: (message: string, variant: ToastVariant = "info") =>
        manager.add({ title: message, type: variant }),
      success: (message: string) => manager.add({ title: message, type: "success" }),
      error: (message: string) => manager.add({ title: message, type: "error" }),
      info: (message: string) => manager.add({ title: message, type: "info" }),
    }),
    [manager]
  );
}
