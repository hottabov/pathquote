import { cn } from "@/lib/utils";
import type { AutosaveStatus } from "@/lib/use-autosave";

const STATUS_LABEL: Record<Exclude<AutosaveStatus, "error">, string> = {
  idle: "",
  saving: "Saving…",
  // Past SLOW_SAVE_MS (use-autosave.ts). A plain "Saving…" for a minute reads
  // as a frozen app; this says the save is still going and points at the
  // usual culprit, without suggesting anything was lost.
  slow: "Still saving… slow connection?",
  saved: "Saved",
};

/**
 * Subtle inline text next to an autosaved field — "Saving…" while a save
 * is in flight, "Saved" for a couple of seconds after (both fading via
 * opacity rather than layout shift, and empty rather than unmounted when
 * `status` is "idle" so the field never jumps), or the error message in
 * `text-destructive` when `status` is "error". `aria-live="polite"` so a
 * screen reader announces the outcome without interrupting typing — this
 * is the shared piece behind every `useAutosave` consumer (see
 * item-discount-field.tsx, document-discount-field.tsx, notes-section.tsx).
 */
export function AutosaveIndicator({ status, error }: { status: AutosaveStatus; error: string | null }) {
  if (status === "error") {
    return (
      <span role="alert" className="text-xs text-destructive">
        {error ?? "Save failed"}
      </span>
    );
  }

  return (
    <span
      aria-live="polite"
      className={cn(
        "text-xs text-slate-400 transition-opacity duration-300",
        status === "idle" ? "opacity-0" : "opacity-100"
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
