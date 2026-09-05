"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import type { ActionResult } from "@/lib/actions/users";

/**
 * Standalone "set new password" section — a single password field that
 * replaces the user's hash outright (or gives a magic-link-only account its
 * first one). No confirmation field per the spec ("confirm-not-needed"): a
 * typo just means the admin resets it again, and demanding it be typed
 * twice adds friction for a low-stakes admin action. Uses the
 * transition+toast pattern from `ContentBlockForm`
 * (src/components/content/content-block-form.tsx) rather than
 * `useActionState`, since success here doesn't navigate away and needs an
 * explicit confirmation the way a silent revalidate wouldn't provide — the
 * field is also cleared on success so the just-set password doesn't linger
 * on screen.
 */
export function SetPasswordForm({
  action,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
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
      setPassword("");
      toast.success("Password updated");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FieldRow label="New password" htmlFor="set-password" required className="lg:max-w-sm">
        <input
          id="set-password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={10}
          maxLength={200}
          autoComplete="new-password"
          disabled={pending}
          className={fieldInputClass}
        />
      </FieldRow>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={pending}
        className="h-11 w-full sm:w-auto sm:self-start"
        variant="outline"
      >
        {pending ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}
