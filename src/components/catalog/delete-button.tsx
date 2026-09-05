"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm, useToast } from "@/components/ui-kit/client";

/**
 * A danger-zone delete button, shared by the product and option editors.
 * Confirms via the shared `useConfirm` dialog (replaces the old
 * `window.confirm` — see src/components/clients/delete-company-button.tsx
 * for the pattern this mirrors), then calls the bound delete server action
 * directly. On success the action redirects away (Next.js turns that into a
 * client-side navigation even when the action was invoked outside a
 * <form>) — the navigation is the feedback, so no success toast is needed;
 * on failure (e.g. "still referenced by a document") it shows the returned
 * error both inline and as an error toast.
 */
export function DeleteButton({
  action,
  confirmTitle,
  confirmDescription,
  label = "Delete",
}: {
  action: () => Promise<{ error?: string }>;
  confirmTitle: string;
  confirmDescription?: string;
  label?: string;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: confirmTitle,
      description: confirmDescription,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="destructive"
        onClick={handleClick}
        disabled={pending}
        className="h-11 w-full sm:w-fit"
      >
        <Trash2 className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Deleting…" : label}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
