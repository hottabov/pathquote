"use client";

import { startTransition, useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/catalog";

export type OptionFormValues = {
  code: string;
  name: string;
  shortDescription: string;
  active: boolean;
  noCommission: boolean;
  sortOrder: number;
};

/** What this form holds while it is being edited — see the note on
 * `sortOrder` below. */
type OptionFormState = Omit<OptionFormValues, "sortOrder"> & { sortOrder: string };

const initialState: ActionResult = {};

/**
 * The option create/edit form. Same fields as ProductForm plus a short
 * description.
 *
 * Controlled throughout, for the reason `CompanyForm` spells out: React
 * empties an uncontrolled form as soon as its action returns, error or not,
 * so a rejected save (a duplicate code, say) used to take everything typed
 * with it. `defaultValue` cannot survive that reset; state can.
 */
export function OptionForm({
  action,
  defaultValues,
  submitLabel,
  readOnly = false,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValues: OptionFormValues;
  submitLabel: string;
  /** MANAGER view: render every field disabled and hide the submit button. */
  readOnly?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(formData),
    initialState
  );
  // `sortOrder` is held as the string the input actually contains, not as a
  // number: `Number("")` is 0, so a number-typed state would turn a cleared
  // field into a visible "0" the moment the admin deleted the last digit. The
  // server parses the submitted string either way (see `optionSchema`).
  const [values, setValues] = useState<OptionFormState>(() => ({
    ...defaultValues,
    sortOrder: String(defaultValues.sortOrder),
  }));

  function set<K extends keyof OptionFormState>(field: K, value: OptionFormState[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  // Submitted through `onSubmit` rather than `<form action>` -- see
  // `CompanyForm` (src/components/clients/company-form.tsx). `<form action>`
  // still resets every field's DOM value once the action settles regardless
  // of state, so a rejected field would come back visibly blank while
  // `values` still held what was typed, and the next save would have posted
  // that blank DOM value instead. Browser validation still runs before this
  // fires.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FieldRow label="Code" htmlFor="option-code" required>
          <input
            id="option-code"
            name="code"
            value={values.code}
            onChange={(e) => set("code", e.target.value)}
            required
            disabled={readOnly}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Name" htmlFor="option-name" required>
          <input
            id="option-name"
            name="name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            required
            minLength={2}
            maxLength={200}
            disabled={readOnly}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow
          label="Short description"
          htmlFor="option-short-description"
          className="lg:col-span-2"
        >
          <textarea
            id="option-short-description"
            name="shortDescription"
            value={values.shortDescription}
            onChange={(e) => set("shortDescription", e.target.value)}
            maxLength={500}
            rows={2}
            disabled={readOnly}
            className={cn(fieldInputClass, "h-auto min-h-16 py-2")}
          />
        </FieldRow>

        <label className="flex h-11 items-center gap-2 text-sm font-medium text-brand-dark">
          <input
            name="active"
            type="checkbox"
            checked={values.active}
            onChange={(e) => set("active", e.target.checked)}
            disabled={readOnly}
            className="size-4 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
          />
          Active
        </label>

        <label className="flex h-11 items-center gap-2 text-sm font-medium text-brand-dark">
          <input
            name="noCommission"
            type="checkbox"
            checked={values.noCommission}
            onChange={(e) => set("noCommission", e.target.checked)}
            disabled={readOnly}
            className="size-4 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
          />
          No commission
        </label>

        <FieldRow label="Sort order" htmlFor="option-sort-order" hint="Lower numbers list first.">
          <input
            id="option-sort-order"
            name="sortOrder"
            type="number"
            min={0}
            step={1}
            value={values.sortOrder}
            onChange={(e) => set("sortOrder", e.target.value)}
            disabled={readOnly}
            className={fieldInputClass}
          />
        </FieldRow>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      {!readOnly && (
        <Button
          variant="brand"
          type="submit"
          disabled={pending}
          className="h-11 w-full sm:w-auto sm:self-start"
        >
          {pending ? "Saving…" : submitLabel}
        </Button>
      )}
    </form>
  );
}
