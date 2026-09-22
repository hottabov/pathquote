"use client";

import { startTransition, useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import type { ActionResult } from "@/lib/actions/users";

export type RegionOption = { code: string; name: string };

type UserFormValues = {
  email: string;
  name: string;
  phone: string;
  role: string;
  regionCode: string;
  password: string;
};

const initialState: ActionResult = {};

const BLANK_USER: UserFormValues = {
  email: "",
  name: "",
  phone: "",
  role: "MANAGER",
  regionCode: "",
  password: "",
};

/**
 * The "new user" form. On success `createUser` redirects to the new user's
 * editor, so this only ever needs to render an error state — same shape as
 * `CompanyForm`/`ProductForm` (src/components/clients/company-form.tsx,
 * src/components/catalog/product-form.tsx). Email/role/region occupy the
 * two-column grid; the password field spans full-width with its
 * magic-link-only note directly beneath it.
 *
 * Controlled throughout AND submitted through `onSubmit`, for the reason
 * `CompanyForm` spells out at length: both halves are needed, and this form
 * had only the first. "That email is already in use" is the likeliest thing
 * this form ever says, and with `<form action>` the two selects (Role,
 * Region) would come back reverted in the DOM on that error while state
 * still showed the admin's picks — so the name, phone, role, region and
 * password all used to go down with it, and a second submit would have
 * posted the reverted role/region rather than what was visible. The password
 * is held the same way as the rest: an admin who has to retype it is an admin
 * who types a different one, and then has to go and tell the new user twice.
 */
export function UserForm({
  action,
  regions,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  regions: RegionOption[];
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(formData),
    initialState
  );
  const [values, setValues] = useState<UserFormValues>(BLANK_USER);

  function set<K extends keyof UserFormValues>(field: K, value: UserFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  // Submitted through `onSubmit` rather than `<form action>` -- see
  // `CompanyForm` (src/components/clients/company-form.tsx) for why. Here it
  // is both selects: "That email is already in use" is the likeliest error
  // this form ever shows, and with `<form action>` it would come back with
  // Role and Region silently reverted in the DOM while state (and the rest
  // of the visible form) still showed what the admin picked -- and the next
  // submit would have posted the reverted role. Browser validation still
  // runs before this fires.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} autoComplete="off" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FieldRow label="Email" htmlFor="user-email" required>
          <input
            id="user-email"
            name="email"
            type="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            required
            maxLength={200}
            autoComplete="off"
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Name" htmlFor="user-name">
          <input
            id="user-name"
            name="name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={120}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Phone" htmlFor="user-phone" hint="Shown on a quotation's Prepared by block.">
          <input
            id="user-phone"
            name="phone"
            type="tel"
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            maxLength={40}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Role" htmlFor="user-role" required>
          <select
            id="user-role"
            name="role"
            value={values.role}
            onChange={(e) => set("role", e.target.value)}
            required
            className={fieldInputClass}
          >
            <option value="MANAGER">Manager</option>
            <option value="REGIONAL_MANAGER">Regional manager</option>
            <option value="ADMIN">Admin</option>
            <option value="DEVELOPER">Developer</option>
          </select>
        </FieldRow>

        <FieldRow label="Region" htmlFor="user-region" hint="Leave unset if this user isn't tied to one region.">
          <select
            id="user-region"
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

        <FieldRow
          label="Initial password"
          htmlFor="user-password"
          className="lg:col-span-2"
          hint="Leave empty to let the user sign in via magic link only."
        >
          <input
            id="user-password"
            name="password"
            type="password"
            value={values.password}
            onChange={(e) => set("password", e.target.value)}
            minLength={10}
            maxLength={200}
            autoComplete="new-password"
            className={fieldInputClass}
          />
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
        {pending ? "Creating…" : "Create user"}
      </Button>
    </form>
  );
}
