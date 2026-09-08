"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import type { ActionResult } from "@/lib/actions/users";
import type { RegionOption } from "./user-form";

export type EditUserFormValues = {
  name: string;
  phone: string;
  role: "ADMIN" | "MANAGER" | "DEVELOPER";
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

  return (
    <form action={formAction} autoComplete="off" className="flex flex-col gap-4">
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
            defaultValue={defaultValues.name}
            maxLength={120}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Phone" htmlFor="edit-user-phone" hint="Shown on a quotation's Prepared by block.">
          <input
            id="edit-user-phone"
            name="phone"
            type="tel"
            defaultValue={defaultValues.phone}
            maxLength={40}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Role" htmlFor="edit-user-role" required>
          <select
            id="edit-user-role"
            name="role"
            defaultValue={defaultValues.role}
            required
            className={fieldInputClass}
          >
            <option value="MANAGER">Manager</option>
            <option value="ADMIN">Admin</option>
            <option value="DEVELOPER">Developer</option>
          </select>
        </FieldRow>

        <FieldRow label="Region" htmlFor="edit-user-region">
          <select
            id="edit-user-region"
            name="regionCode"
            defaultValue={defaultValues.regionCode}
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
