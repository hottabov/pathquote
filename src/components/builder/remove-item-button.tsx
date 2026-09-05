"use client";

import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/documents";

/**
 * Removes an item (or a custom extra line) from the builder. The server
 * action's `revalidatePath` refetches the builder page's own data, so the
 * row just disappears from the list on the next render — this component
 * never redirects on its own. Confirms via `useConfirm` (Phase 5b replaced
 * every `window.confirm` in the builder with the shared dialog) since a
 * mis-tap on a 44px icon button is easy enough that a quick "are you sure"
 * is worth the extra step, even though the removal itself is easily undone
 * by adding the item/line back.
 */
export function RemoveItemButton({
  action,
  itemName,
}: {
  action: () => Promise<ActionResult>;
  /** Plain display name (no "Remove " prefix) — used to build the
   * aria-label, confirm dialog copy, and the success toast. */
  itemName: string;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: `Remove ${itemName}?`,
      description: "You can add it back afterwards if this was a mistake.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result?.error) {
        setError(result.error);
        return;
      }
      toast.success(`Removed ${itemName}`);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleClick}
        disabled={pending}
        aria-label={`Remove ${itemName}`}
        className="focus-ring size-11 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
