"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContactFields, type ContactFieldValues } from "@/components/clients/contact-fields";
import type { ActionResult } from "@/lib/actions/clients";

export type ContactFormValues = ContactFieldValues & {
  isPrimary: boolean;
};

const initialState: ActionResult = {};

/**
 * Shared add/edit form for a company's contacts. Used both for the
 * always-visible "add contact" form and for a single contact's inline edit
 * mode. `onDone` fires once after a submission completes without error —
 * the parent uses it to close the inline editor / reset the add form,
 * since a successful action only revalidates data (no redirect to key off
 * of), and the parent otherwise has no signal that the submit finished.
 */
export function ContactForm({
  action,
  defaultValues,
  submitLabel,
  onDone,
  onCancel,
  idPrefix,
  defaultCountry,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValues: ContactFormValues;
  submitLabel: string;
  onDone?: () => void;
  onCancel?: () => void;
  idPrefix: string;
  /** ISO alpha-2 the phone field opens on for a contact with no number yet
   * — the company's own country. See `PhoneField`. */
  defaultCountry?: string;
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(formData),
    initialState
  );
  // Controlled, every field of it, because React empties an uncontrolled
  // form once its action returns — including when the action returned an
  // error. A manager who mistyped a phone number was made to retype the
  // name, the email and the position as well, none of which the server had
  // any complaint about. State survives that reset; `defaultValue` does not.
  const [values, setValues] = useState<ContactFormValues>(defaultValues);
  const wasPending = useRef(false);

  function set<K extends keyof ContactFormValues>(field: K, value: ContactFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      onDone?.();
    }
    wasPending.current = pending;
  }, [pending, state, onDone]);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <ContactFields
        values={values}
        // Its own setter rather than `set` above: `ContactFields` only knows
        // about `ContactFieldValues`, and a `set` narrowed to this form's
        // wider key set isn't the same function type even though every call it
        // makes is legal.
        set={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
        idPrefix={idPrefix}
        named
        defaultCountry={defaultCountry}
      />

      <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-brand-dark">
        <input
          name="isPrimary"
          type="checkbox"
          checked={values.isPrimary}
          onChange={(e) => set("isPrimary", e.target.checked)}
          className="size-4 rounded border-slate-300 accent-brand"
        />
        Primary contact
      </label>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Button
          type="submit"
          disabled={pending}
          className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:h-9 sm:w-auto"
        >
          {pending ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
            className="h-11 w-full sm:h-9 sm:w-auto"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
