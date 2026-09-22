"use client";

import { startTransition, useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import type { ActionResult } from "@/lib/actions/users";
import type { RegionOption } from "./user-form";

export type EditUserFormValues = {
  name: string;
  phone: string;
  role: "ADMIN" | "MANAGER" | "REGIONAL_MANAGER" | "DEVELOPER";
  regionCode: string;
};

const initialState: ActionResult = {};

/**
 * Edit form for name, phone, role and region. Whether the account can sign in
 * is NOT here — it is its own button in the Access section below (see
 * `UserAccessSection` and `setUserActive`), so revoking someone's access is
 * never a by-product of saving this form. Unlike `UserForm`,
 * saving here never navigates away (mirrors `CompanyForm` on the company
 * edit page), so a successful submit just quietly revalidates — only the
 * error path needs rendering.
 *
 * Controlled throughout AND submitted through `onSubmit`, for the reason
 * `CompanyForm` (src/components/clients/company-form.tsx) spells out at
 * length: both halves are needed, and this form had neither.
 *
 * Reported by Vadym 2026-09-22: changing Role and saving left the select
 * showing the PREVIOUS role, and only a page reload showed the new one. The
 * save itself was always fine -- the header badge beside it updated on the
 * spot. What happened is that `<form action>` makes React 19 reset the form
 * once the action settles, and that reset is imperative: it puts the
 * `<select>` back to its DOM default without changing any React state, so
 * there is no re-render to put the chosen value back. Holding the value in
 * state is therefore not enough on its own -- state stayed correct while the
 * DOM did not, which is exactly what an admin saw.
 *
 * So the values live in state (seeded once from `defaultValues` and
 * deliberately not re-synced, as `CompanyForm` does it -- what is on screen
 * is the admin's own edits) and the form posts a FormData built in
 * `handleSubmit` instead of handing React the action. The second half also
 * closes the worse follow-on: with `<form action>` the browser builds
 * FormData from the DOM, so after one reset the NEXT save would have posted
 * the reset select rather than the visible state.
 *
 * `isSelf`/`isLastActiveAdmin` don't disable any control: the actual
 * safeguard lives server-side in `canModifyUser`
 * (src/lib/validation/users.ts) and is re-checked on every submit regardless
 * of what the client shows. These are hints only, so the admin understands
 * *why* a save might come back with an error instead of being surprised by
 * one.
 */
export function EditUserForm({
  action,
  defaultValues,
  regions,
  isSelf,
  isLastActiveAdmin,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValues: EditUserFormValues;
  regions: RegionOption[];
  isSelf: boolean;
  isLastActiveAdmin: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(formData),
    initialState
  );
  const [values, setValues] = useState<EditUserFormValues>(defaultValues);

  function set<K extends keyof EditUserFormValues>(field: K, value: EditUserFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  // See the doc comment above: `<form action>` would make React reset this
  // form after every save, silently reverting both selects in the DOM.
  // Browser validation still runs before this fires.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} autoComplete="off" className="flex flex-col gap-4">
      {isSelf ? (
        <p className="rounded-lg border border-brand-accent-ink/30 bg-brand-accent-ink/5 px-3 py-2 text-sm text-brand-accent-ink">
          This is your own account — you can&apos;t remove your own admin role.
        </p>
      ) : null}
      {isLastActiveAdmin ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          This is the last active admin — it can&apos;t be demoted until another admin exists.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FieldRow label="Name" htmlFor="edit-user-name">
          <input
            id="edit-user-name"
            name="name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={120}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Phone" htmlFor="edit-user-phone" hint="Shown on a quotation's Prepared by block.">
          <input
            id="edit-user-phone"
            name="phone"
            type="tel"
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            maxLength={40}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Role" htmlFor="edit-user-role" required>
          <select
            id="edit-user-role"
            name="role"
            value={values.role}
            onChange={(e) => set("role", e.target.value as EditUserFormValues["role"])}
            required
            className={fieldInputClass}
          >
            <option value="MANAGER">Manager</option>
            <option value="REGIONAL_MANAGER">Regional manager</option>
            <option value="ADMIN">Admin</option>
            <option value="DEVELOPER">Developer</option>
          </select>
        </FieldRow>

        <FieldRow label="Region" htmlFor="edit-user-region">
          <select
            id="edit-user-region"
            name="regionCode"
            value={values.regionCode}
            onChange={(e) => set("regionCode", e.target.value)}
            autoComplete="off"
            className={fieldInputClass}
          >
            <option value="">No region</option>
            {regions.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name} ({r.code})
              </option>
            ))}
          </select>
        </FieldRow>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={pending}
        className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto sm:self-start"
      >
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}
