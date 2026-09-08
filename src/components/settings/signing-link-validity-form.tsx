"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/settings";

/**
 * ADMIN-only editor for the "signing.linkValidityDays" app setting, rendered
 * in the Preferences card on /settings/preferences. Copies
 * `QuoteValidityForm`'s shape exactly (same transition+toast pattern,
 * mirroring `SetPasswordForm`, src/components/users/set-password-form.tsx),
 * but NOT its range: this field caps at 90 days, not 365 — see
 * `signingLinkValidityDaysSchema` (src/lib/validation/settings.ts) for why a
 * signing link's exposure window isn't the same question as a quote's
 * validity window.
 *
 * The helper text calls out that this only governs links issued from now on
 * — see `getSigningLinkValidityDays` (src/lib/queries/settings.ts) for why:
 * the value is frozen into `SigningRequest.expiresAt` at send time, so
 * lowering it here never shortens a link already in a client's inbox.
 */
export function SigningLinkValidityForm({
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
      <label htmlFor="signing-link-validity-days" className="text-sm font-medium text-brand-dark">
        Signing link validity (days)
      </label>
      <div className="flex items-center gap-2">
        <input
          id="signing-link-validity-days"
          name="value"
          type="number"
          min={1}
          max={90}
          step={1}
          defaultValue={defaultValue}
          required
          disabled={pending}
          aria-describedby={error ? "signing-link-validity-days-error" : "signing-link-validity-days-hint"}
          aria-invalid={error ? true : undefined}
          className={cn(fieldInputClass, "w-24 shrink-0")}
        />
        <Button type="submit" disabled={pending} className="h-11 shrink-0" variant="outline">
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>

      {error ? (
        <p id="signing-link-validity-days-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        <p id="signing-link-validity-days-hint" className="text-sm text-slate-500">
          How long a client&apos;s signing link stays usable. Changing this does not affect links already sent.
        </p>
      )}
    </form>
  );
}
