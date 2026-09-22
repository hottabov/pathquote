"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import type { ActionResult } from "@/lib/actions/catalog";

const initialState: ActionResult = {};

/**
 * Name-only create/edit form for an `OptionConflictGroup` — e.g. "Knife
 * tools — fit one only". The name is the only field a group has (no code,
 * no compatibility, no price): it's what the settings list and the option
 * editor's read-only "Conflict groups" summary both display, and what the
 * builder's disabled-option message quotes (see `isOptionDisabled`,
 * src/lib/catalog-compat.ts), so it needs to be something an admin
 * recognises at a glance — see the model comment on `OptionConflictGroup`
 * in schema.prisma.
 */
export function ConflictGroupForm({
  action,
  defaultValue,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValue: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(formData),
    initialState
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FieldRow
        label="Name"
        htmlFor="conflict-group-name"
        required
        hint='e.g. "Knife tools — fit one only"'
      >
        <input
          id="conflict-group-name"
          name="name"
          defaultValue={defaultValue}
          required
          minLength={2}
          maxLength={200}
          className={fieldInputClass}
        />
      </FieldRow>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <Button
        variant="brand"
        type="submit"
        disabled={pending}
        className="h-11 w-full sm:w-auto sm:self-start"
      >
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
