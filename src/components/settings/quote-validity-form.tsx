"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <label htmlFor="quote-validity-days" className="text-sm font-medium text-brand-dark">
        Quote validity (days)
      </label>
      <div className="flex items-center gap-2">
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
          aria-describedby={error ? "quote-validity-days-error" : "quote-validity-days-hint"}
          aria-invalid={error ? true : undefined}
          className={cn(fieldInputClass, "w-24 shrink-0")}
        />
        <Button type="submit" disabled={pending} className="h-11 shrink-0" variant="outline">
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>

      {error ? (
        <p id="quote-validity-days-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p id="quote-validity-days-hint" className="text-sm text-slate-500">
          How long a finalized quote stays valid, by default.
        </p>
      )}
    </form>
  );
}
