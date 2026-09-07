"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/settings";

/**
 * ADMIN-only editor for the "signing.linkValidityDays" app setting, rendered
 * in the Preferences card on /settings/preferences. Copies
 * `QuoteValidityForm`'s shape exactly (same transition+toast pattern,
 * mirroring `SetPasswordForm`, src/components/users/set-password-form.tsx)
 * since the two fields are the same "whole days, 1..365" shape.
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FieldRow
        label="Signing link validity (days)"
        htmlFor="signing-link-validity-days"
        hint="How long a client's signing link stays usable. Changing this does not affect links already sent."
        className="max-w-40"
      >
        <input
          id="signing-link-validity-days"
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
