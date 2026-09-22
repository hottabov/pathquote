"use client";

import { startTransition, useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { IndustryPicker, type IndustryOption } from "@/components/clients/industry-picker";
import {
  CompanyDeliverySameAsMainField,
  CompanyField,
  type CompanyFieldBinding,
  type CompanyFieldValues,
} from "@/components/clients/company-fields";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/clients";

/** The shared company fields (see `CompanyFieldValues`) plus the two freeform
 * notes only this screen offers — the builder's inline panel has no room for
 * them and never captured them. */
export type CompanyFormValues = CompanyFieldValues & {
  notes: string;
  deliveryNotes: string;
};

/**
 * Bundled props for the `IndustryPicker` field. On the edit screen
 * (src/app/(app)/clients/[companyId]/page.tsx) `companyId` is set and the
 * picker saves through its own server action (see industry-picker.tsx). On
 * the "new client" screen there is no company yet, so `companyId` is left
 * out: the choice is held here and submitted with the form as `industryId`,
 * restricted to the existing list.
 */
export type IndustryPickerProps = {
  companyId?: string;
  industries: IndustryOption[];
  selectedId: string | null;
  /** `null` when the count must be withheld — see `IndustryPicker`'s prop. */
  usageCount: number | null;
  canRename: boolean;
};

const initialState: ActionResult = {};

/**
 * The company create/edit form. Same shape for both — on create, the bound
 * server action redirects to the new company's editor; on update it stays
 * put and just revalidates, so this only ever needs to render an error
 * state (mirrors src/components/catalog/option-form.tsx). Laid out as the
 * two-column desktop grid the design direction calls for: name pairs with
 * website, tax ID with industry, then the full address block, then a
 * full-width notes field, then the delivery address section.
 *
 * The fields themselves come from `@/components/clients/company-fields`,
 * shared with the builder's inline "+ New company" panel — this screen keeps
 * the ordering, the hints and the two notes textareas, which are its own.
 */
export function CompanyForm({
  action,
  defaultValues,
  submitLabel,
  industryPicker,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValues: CompanyFormValues;
  submitLabel: string;
  /** See `IndustryPickerProps`. Omitted, the form has no industry field. */
  industryPicker?: IndustryPickerProps;
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(formData),
    initialState
  );
  // Controlled throughout. React empties an uncontrolled form as soon as its
  // action returns, error or not, so a single rejected field used to send a
  // manager back to the top of a nineteen-field form -- and the country
  // select went back to "Select a country..." quietly enough to be missed on
  // the way through. State survives that reset; `defaultValue` does not.
  const [values, setValues] = useState<CompanyFormValues>(defaultValues);
  const sameAsMain = values.deliverySameAsMain;
  // Only read without a `companyId` (the create screen); with one, the picker
  // saves on its own and its `selectedId` comes back from the server render.
  const [industryId, setIndustryId] = useState<string | null>(industryPicker?.selectedId ?? null);

  function set<K extends keyof CompanyFormValues>(field: K, value: CompanyFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  // Its own setter rather than `set` above: the shared fields only know about
  // `CompanyFieldValues`, and a `set` narrowed to this form's wider key set
  // isn't the same function type even though every call it makes is legal.
  const binding: CompanyFieldBinding = {
    values,
    set: (field, value) => setValues((current) => ({ ...current, [field]: value })),
    idPrefix: "company",
    named: true,
  };

  // Submitted through `onSubmit` rather than `<form action>`: with `action`,
  // React 19 calls `form.reset()` once the action settles, and a native
  // `<select>` resets its DOM value to the first option even when it is
  // controlled -- React never re-syncs it because the state did not change.
  // The country showed "Select a country..." after every save, the phone
  // picker jumped to the first dialling code, and the *next* save posted the
  // blank country from the DOM. Browser validation still runs before submit.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => formAction(formData));
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CompanyField binding={binding} field="name" required minLength={2} />
        <CompanyField binding={binding} field="website" />
        <CompanyField binding={binding} field="taxId" hint="ABN, EIN, VAT number, etc." />

        {industryPicker && (
          <FieldRow label="Industry" htmlFor="company-industry" className="lg:col-span-2">
            <IndustryPicker
              id="company-industry"
              industries={industryPicker.industries}
              {...(industryPicker.companyId
                ? { companyId: industryPicker.companyId, selectedId: industryPicker.selectedId }
                : {
                    selectedId: industryId,
                    onChange: setIndustryId,
                    name: "industryId",
                  })}
              // Industries come from the list admins keep in Settings ->
              // Industries; a manager picks one, never types a new one.
              allowCreate={false}
              usageCount={industryPicker.usageCount}
              canRename={industryPicker.canRename}
            />
          </FieldRow>
        )}

        <CompanyField binding={binding} field="street" />
        <CompanyField binding={binding} field="city" />
        <CompanyField binding={binding} field="state" />
        <CompanyField binding={binding} field="postcode" />
        <CompanyField binding={binding} field="country" className="lg:col-span-2" />

        <FieldRow label="Notes" htmlFor="company-notes" className="lg:col-span-2">
          <textarea
            id="company-notes"
            name="notes"
            value={values.notes}
            onChange={(e) => set("notes", e.target.value)}
            maxLength={2000}
            rows={3}
            className={cn(fieldInputClass, "h-auto min-h-24 py-2")}
          />
        </FieldRow>
      </div>

      <div className="flex flex-col gap-4 border-t border-slate-200 pt-6">
        <div>
          <h3 className="text-sm font-semibold text-brand-dark">Delivery address</h3>
          <p className="text-sm text-slate-500">
            Where equipment ships to, when different from the main address above.
          </p>
        </div>

        <CompanyDeliverySameAsMainField
          binding={binding}
          label="Same as main address"
          className="flex min-h-11 w-fit items-center gap-2 text-sm font-medium text-brand-dark"
        />

        {!sameAsMain ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CompanyField binding={binding} field="deliveryStreet" required />
            <CompanyField binding={binding} field="deliveryCity" required />
            <CompanyField binding={binding} field="deliveryState" />
            <CompanyField binding={binding} field="deliveryPostcode" required />
            <CompanyField
              binding={binding}
              field="deliveryCountry"
              required
              className="lg:col-span-2"
            />
            <CompanyField
              binding={binding}
              field="deliveryContactName"
              hint="Who receives the delivery on site — recommended."
            />
            <CompanyField
              binding={binding}
              field="deliveryPhone"
              hint="Who to call on arrival — recommended."
            />

            <FieldRow label="Delivery notes" htmlFor="company-delivery-notes" className="lg:col-span-2">
              <textarea
                id="company-delivery-notes"
                name="deliveryNotes"
                value={values.deliveryNotes}
                onChange={(e) => set("deliveryNotes", e.target.value)}
                maxLength={500}
                rows={2}
                className={cn(fieldInputClass, "h-auto min-h-16 py-2")}
              />
            </FieldRow>
          </div>
        ) : null}
      </div>

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
