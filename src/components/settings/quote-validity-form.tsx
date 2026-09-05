"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/settings";

/**
 * ADMIN-only editor for the "quote.validityDays" app setting, rendered in
 * the Preferences card on the main /settings page. Uses the
 * transition+toast pattern (mirrors `SetPasswordForm`,
 * src/components/users/set-password-form.tsx) rather than `useActionState`,
 * since saving here never navigates away and needs an explicit success
 * signal.
 */
export function QuoteValidityForm({
  action,
  defaultValue,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValue: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success("Saved");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FieldRow
        label="Quote validity (days)"
        htmlFor="quote-validity-days"
        hint="How long a finalized quote stays valid, by default."
        className="max-w-40"
      >
        <input
          id="quote-validity-days"
          name="value"
          type="number"
          min={1}
          max={365}
          step={1}
          defaultValue={defaultValue}
          required
          disabled={pending}
          className={fieldInputClass}
        />
      </FieldRow>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="h-11 w-full sm:w-auto sm:self-start" variant="outline">
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
