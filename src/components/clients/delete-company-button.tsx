"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/clients";

/**
 * Danger-zone delete button for a company. Confirms via the shared
 * `useConfirm` dialog (Task C replaces every remaining `window.confirm` in
 * the clients screens — see src/components/catalog/delete-button.tsx for
 * the older pattern this supersedes here). On success `deleteCompany`
 * redirects to `/clients` itself, so there's no success toast to show —
 * the navigation away is the feedback.
 */
export function DeleteCompanyButton({
  action,
  companyName,
}: {
  action: () => Promise<ActionResult>;
  companyName: string;
}) {
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    const confirmed = await confirm({
      title: `Delete ${companyName}?`,
      description: "This removes its contacts too. This can't be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result?.error) setError(result.error);
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
        {pending ? "Deleting…" : "Delete company"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
