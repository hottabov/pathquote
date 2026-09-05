"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { SupportActionResult } from "@/lib/actions/support";

/**
 * The PathQuote Support form itself — just a subject and a message. Every
 * other piece of context (who's asking, their role and region, the app
 * version) is attached server-side by `submitSupportMessage`
 * (src/lib/actions/support.ts); this component never collects it, only
 * shows the sender what will be attached (see the page it's rendered on).
 *
 * Mirrors `QuoteValidityForm`'s transition+toast pattern rather than
 * `useActionState`: saving here should clear the fields for the next report
 * rather than navigate away, so the form needs an explicit reset hook,
 * which `useActionState`'s re-render-with-previous-state model doesn't give
 * cleanly.
 */
export function SupportMessageForm({
  action,
  disabled,
}: {
  action: (formData: FormData) => Promise<SupportActionResult>;
  disabled?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      formRef.current?.reset();
      if (result?.warning) {
        toast.info(result.warning);
      } else {
        toast.success("Sent to the developer");
      }
    });
  }

  const fieldsDisabled = pending || disabled;

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FieldRow label="Subject" htmlFor="support-subject" required>
        <input
          id="support-subject"
          name="subject"
          maxLength={150}
          required
          disabled={fieldsDisabled}
          placeholder="Short summary — e.g. “X-Calibre prices showing AUD for a US client”"
          className={fieldInputClass}
        />
      </FieldRow>

      <FieldRow
        label="Message"
        htmlFor="support-body"
        required
        hint="What were you doing, what did you expect, what happened instead? Include a quote number or item code if there is one."
      >
        <textarea
          id="support-body"
          name="body"
          maxLength={5000}
          rows={8}
          required
          disabled={fieldsDisabled}
          placeholder="Describe the problem…"
          className={cn(fieldInputClass, "h-auto min-h-40 py-2")}
        />
      </FieldRow>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={fieldsDisabled}
        className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto sm:self-start"
      >
        {pending ? "Sending…" : "Send to the developer"}
      </Button>
    </form>
  );
}
