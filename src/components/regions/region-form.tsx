"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { currencySymbol } from "@/lib/format";
import { BankDetailsEditor } from "./bank-details-editor";
import type { ActionResult } from "@/lib/actions/regions";

export type RegionFormValues = {
  code: string;
  name: string;
  currency: string;
  currencySymbol: string;
  taxName: string;
  taxRate: string;
  entityName: string;
  entityLegalId: string;
  entityAddress: string;
  footerText: string;
  bankDetails: Record<string, string> | null;
  /** String form of the region's discount cap, as the input holds it
   * (mirrors `taxRate`) — empty string means no cap. */
  maxDiscountPct: string;
  /** String form of the region's markup ceiling (mirrors `maxDiscountPct`
   * above, for the opposite direction) — empty string means no ceiling. */
  maxMarkupPct: string;
  active: boolean;
};

const initialState: ActionResult = {};

/**
 * Shared create/edit form for /settings/regions. On create, `createRegion`
 * redirects to the new region's editor on success (mirrors
 * `UserForm`/`ProductForm`); on edit, `updateRegion` never navigates away and
 * just returns `{}` (mirrors `EditUserForm`) — either way `useActionState`
 * only ever needs to render the error path.
 *
 * `code` is only ever editable at create time — `codeEditable={false}`
 * renders it disabled (and `updateRegionSchema` has no `code` field at all,
 * so even a tampered submission couldn't change it server-side).
 *
 * Controlled throughout, for the reason `CompanyForm` spells out: React
 * empties an uncontrolled form the moment its action returns, error or not,
 * so one rejected field — a tax rate typed as "10%", a region deactivated
 * while users are still assigned to it — used to wipe the entity address and
 * footer text an admin had just written out longhand. `defaultValue` cannot
 * survive that reset; state can. (Re-keying the form on failure would remount
 * it and lose the same values just as thoroughly — `key` is for re-seeding a
 * form when its defaults genuinely change, not for holding on to typing.)
 * `BankDetailsEditor` keeps its rows in state of its own and was never
 * affected.
 */
export function RegionForm({
  action,
  defaultValues,
  submitLabel,
  codeEditable,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValues: RegionFormValues;
  submitLabel: string;
  codeEditable: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(formData),
    initialState
  );
  const [values, setValues] = useState<RegionFormValues>(defaultValues);

  function set<K extends keyof RegionFormValues>(field: K, value: RegionFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FieldRow
          label="Code"
          htmlFor="region-code"
          required
          hint={codeEditable ? "2-3 letters (AU, US, UK...). Can't be changed later." : "Can't be changed after creation."}
        >
          <input
            id="region-code"
            name="code"
            value={values.code}
            onChange={(e) => set("code", e.target.value)}
            required={codeEditable}
            disabled={!codeEditable}
            maxLength={3}
            className={cn(fieldInputClass, "uppercase")}
          />
        </FieldRow>

        <FieldRow label="Name" htmlFor="region-name" required>
          <input
            id="region-name"
            name="name"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            required
            minLength={2}
            maxLength={200}
            className={fieldInputClass}
          />
        </FieldRow>

        <div className="grid grid-cols-2 gap-4">
          <FieldRow label="Currency" htmlFor="region-currency" required hint="3 letters (AUD, USD, GBP...).">
            <input
              id="region-currency"
              name="currency"
              value={values.currency}
              onChange={(e) => set("currency", e.target.value)}
              required
              maxLength={3}
              className={cn(fieldInputClass, "uppercase")}
            />
          </FieldRow>

          <FieldRow
            label="Currency symbol"
            htmlFor="region-currency-symbol"
            hint="What prints in front of an amount ($, A$, £, €). Leave blank to derive it from the code."
          >
            <input
              id="region-currency-symbol"
              name="currencySymbol"
              value={values.currencySymbol}
              onChange={(e) => set("currencySymbol", e.target.value)}
              maxLength={6}
              placeholder={currencySymbol(values.currency)}
              className={fieldInputClass}
            />
          </FieldRow>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FieldRow label="Tax name" htmlFor="region-tax-name" required hint="e.g. GST, Sales Tax, VAT.">
            <input
              id="region-tax-name"
              name="taxName"
              value={values.taxName}
              onChange={(e) => set("taxName", e.target.value)}
              required
              maxLength={40}
              className={fieldInputClass}
            />
          </FieldRow>

          <FieldRow label="Tax rate (%)" htmlFor="region-tax-rate" required>
            <input
              id="region-tax-rate"
              name="taxRate"
              type="number"
              min={0}
              max={99.99}
              step={0.01}
              value={values.taxRate}
              onChange={(e) => set("taxRate", e.target.value)}
              required
              className={fieldInputClass}
            />
          </FieldRow>
        </div>

        <FieldRow
          label="Max discount %"
          htmlFor="region-max-discount-pct"
          hint="Managers cannot exceed this discount. Leave blank for no cap."
        >
          <input
            id="region-max-discount-pct"
            name="maxDiscountPct"
            type="text"
            inputMode="decimal"
            value={values.maxDiscountPct}
            onChange={(e) => set("maxDiscountPct", e.target.value)}
            placeholder="No cap"
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow
          label="Max markup %"
          htmlFor="region-max-markup-pct"
          hint="How far above list a price may go. Leave blank for no ceiling."
        >
          <input
            id="region-max-markup-pct"
            name="maxMarkupPct"
            type="text"
            inputMode="decimal"
            value={values.maxMarkupPct}
            onChange={(e) => set("maxMarkupPct", e.target.value)}
            placeholder="No ceiling"
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Entity name" htmlFor="region-entity-name" required className="lg:col-span-2">
          <input
            id="region-entity-name"
            name="entityName"
            value={values.entityName}
            onChange={(e) => set("entityName", e.target.value)}
            required
            maxLength={200}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow label="Entity legal ID" htmlFor="region-entity-legal-id" hint="e.g. ABN, EIN.">
          <input
            id="region-entity-legal-id"
            name="entityLegalId"
            value={values.entityLegalId}
            onChange={(e) => set("entityLegalId", e.target.value)}
            maxLength={100}
            className={fieldInputClass}
          />
        </FieldRow>

        <FieldRow
          label="Entity address"
          htmlFor="region-entity-address"
          className="lg:col-span-2"
          hint="One line each for street, city/postcode, and contact details (phone/email/web) — each line break here appears as a new line on documents."
        >
          <textarea
            id="region-entity-address"
            name="entityAddress"
            value={values.entityAddress}
            onChange={(e) => set("entityAddress", e.target.value)}
            maxLength={400}
            rows={4}
            className={cn(fieldInputClass, "h-auto min-h-24 py-2")}
          />
        </FieldRow>

        <FieldRow
          label="Footer text"
          htmlFor="region-footer-text"
          className="lg:col-span-2"
          hint="Shown at the bottom of documents issued from this region."
        >
          <textarea
            id="region-footer-text"
            name="footerText"
            value={values.footerText}
            onChange={(e) => set("footerText", e.target.value)}
            maxLength={2000}
            rows={3}
            className={cn(fieldInputClass, "h-auto min-h-20 py-2")}
          />
        </FieldRow>

        <label className="flex h-11 items-center gap-2 text-sm font-medium text-brand-dark">
          <input
            name="active"
            type="checkbox"
            checked={values.active}
            onChange={(e) => set("active", e.target.checked)}
            className="size-4 rounded border-slate-300 accent-brand disabled:cursor-not-allowed"
          />
          Active
        </label>
      </div>

      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="p-0 text-sm font-medium text-brand-dark">Bank details</legend>
        <BankDetailsEditor name="bankDetails" defaultValue={defaultValues.bankDetails} />
        <p className="text-sm text-slate-500">
          Shown on quotes for this region — bank name, account number, SWIFT/BSB, etc.
        </p>
      </fieldset>

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
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
