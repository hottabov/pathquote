"use client";

import { FieldRow, fieldInputClass, CountrySelect } from "@/components/ui-kit";
import { PhoneField } from "@/components/ui-kit/client";

/**
 * The fields a company is described by, in the one shape both screens that
 * capture a company agree on: the full /clients form
 * (src/components/clients/company-form.tsx) and the builder's inline "+ New
 * company" panel (src/components/builder/client-section.tsx). Those two used
 * to carry a private copy each of all seventeen inputs — identical labels,
 * identical length limits, the same `PhoneField` and `CountrySelect`, the same
 * "delivery address same as main" rule — and drifted apart a field at a time.
 *
 * `notes`/`deliveryNotes` are deliberately absent: only the full form has
 * them, so they stay its own business. This type is the common core, and a
 * caller with extra fields of its own passes its wider values object straight
 * through.
 */
export type CompanyFieldValues = {
  name: string;
  regionCode: string;
  website: string;
  taxId: string;
  street: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  deliverySameAsMain: boolean;
  deliveryStreet: string;
  deliveryCity: string;
  deliveryState: string;
  deliveryPostcode: string;
  deliveryCountry: string;
  deliveryContactName: string;
  deliveryPhone: string;
};

export type RegionOption = { code: string; name: string };

/** A blank company, for a "new company" form's initial state. `regionCode`
 * is the caller's because a sensible default differs by screen — the
 * document's own region in the builder, the first configured one on /clients. */
export function emptyCompanyFields(regionCode: string): CompanyFieldValues {
  return {
    name: "",
    regionCode,
    website: "",
    taxId: "",
    street: "",
    city: "",
    state: "",
    postcode: "",
    country: "",
    deliverySameAsMain: true,
    deliveryStreet: "",
    deliveryCity: "",
    deliveryState: "",
    deliveryPostcode: "",
    deliveryCountry: "",
    deliveryContactName: "",
    deliveryPhone: "",
  };
}

/**
 * Everything a field needs from its host that doesn't vary field to field.
 * Passed as one object rather than five props per input, since a company form
 * renders a dozen of these in a row.
 *
 * `named` is the real difference between the two hosts. The /clients form
 * submits a `<form action={...}>` and needs a `name` on every input for the
 * FormData its server action parses; the builder's panel keeps its values in
 * React state and hands them to a JSON action, where a stray `name` would
 * only invite the assumption that something reads it.
 */
export type CompanyFieldBinding = {
  values: CompanyFieldValues;
  set: <K extends keyof CompanyFieldValues>(field: K, value: CompanyFieldValues[K]) => void;
  /** Prefixes every input's `id` — "company" on /clients, "inline-company" in
   * the builder — so two of these can coexist without colliding `htmlFor`s. */
  idPrefix: string;
  /** Emit a `name` attribute on each input. See above. */
  named: boolean;
  disabled?: boolean;
};

type TextSpec = { kind: "text"; label: string; maxLength: number; placeholder?: string };
type ChoiceSpec = { kind: "country" | "phone"; label: string };

/**
 * The shared half of each field: what it is called and what it will accept.
 * Hints are not here — they are advice one screen gives and the other doesn't,
 * so they stay at the call site as an override.
 */
const COMPANY_FIELD_SPECS = {
  name: { kind: "text", label: "Company name", maxLength: 200 },
  website: { kind: "text", label: "Website", maxLength: 200, placeholder: "https://example.com" },
  taxId: { kind: "text", label: "Tax ID", maxLength: 50 },
  street: { kind: "text", label: "Street", maxLength: 120 },
  city: { kind: "text", label: "City", maxLength: 120 },
  state: { kind: "text", label: "State", maxLength: 120 },
  postcode: { kind: "text", label: "Postcode", maxLength: 20 },
  country: { kind: "country", label: "Country" },
  deliveryStreet: { kind: "text", label: "Delivery street", maxLength: 120 },
  deliveryCity: { kind: "text", label: "Delivery city", maxLength: 120 },
  deliveryState: { kind: "text", label: "Delivery state", maxLength: 120 },
  deliveryPostcode: { kind: "text", label: "Delivery postcode", maxLength: 20 },
  deliveryCountry: { kind: "country", label: "Delivery country" },
  deliveryContactName: { kind: "text", label: "Delivery contact name", maxLength: 160 },
  deliveryPhone: { kind: "phone", label: "Delivery phone" },
} satisfies Record<string, TextSpec | ChoiceSpec>;

export type CompanyFieldName = keyof typeof COMPANY_FIELD_SPECS;

/** camelCase -> kebab-case, so a field's `id` reads the way the markup used to
 * spell it by hand (`taxId` -> `company-tax-id`). */
function fieldId(idPrefix: string, field: string) {
  return `${idPrefix}-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * One labelled company field, picked by name. Text inputs, the two country
 * selects and the delivery phone all come from here; `label` and `hint` are
 * overridable because the builder's cramped panel titles one field more
 * briefly than the full form does and offers no hints at all.
 */
export function CompanyField({
  binding,
  field,
  label,
  hint,
  required,
  minLength,
  className,
}: {
  binding: CompanyFieldBinding;
  field: CompanyFieldName;
  label?: string;
  hint?: string;
  required?: boolean;
  /** Only the /clients form asks for one, and only on the company name — the
   * builder's panel never submits a `<form>`, so browser-side length
   * validation would not run there anyway. */
  minLength?: number;
  className?: string;
}) {
  const spec: TextSpec | ChoiceSpec = COMPANY_FIELD_SPECS[field];
  const id = fieldId(binding.idPrefix, field);
  const name = binding.named ? field : undefined;
  const value = binding.values[field];
  // `required` marks the label either way, but the HTML attribute goes only on
  // a field that will actually be submitted: browser constraint validation
  // runs on form submit, and the builder's panel never submits a form — it
  // gates its own "Create" button instead. Setting it there would leave an
  // input permanently matching `:invalid` for no benefit.
  const requiredAttr = required && binding.named;

  return (
    <FieldRow label={label ?? spec.label} htmlFor={id} hint={hint} required={required} className={className}>
      {spec.kind === "text" ? (
        <input
          id={id}
          name={name}
          value={value}
          onChange={(e) => binding.set(field, e.target.value)}
          required={requiredAttr}
          minLength={minLength}
          maxLength={spec.maxLength}
          placeholder={spec.placeholder}
          disabled={binding.disabled}
          className={fieldInputClass}
        />
      ) : spec.kind === "country" ? (
        <CountrySelect
          id={id}
          name={name}
          value={value}
          onChange={(country) => binding.set(field, country)}
          disabled={binding.disabled}
        />
      ) : (
        <PhoneField
          id={id}
          name={name}
          value={value}
          onChange={(phone) => binding.set(field, phone)}
          // Opens on the delivery country when one is set, else the company's
          // own — a delivery address is nearly always in the same country as
          // the office, and when it isn't the manager has already said so.
          defaultCountry={binding.values.deliveryCountry || binding.values.country || undefined}
          disabled={binding.disabled}
        />
      )}
    </FieldRow>
  );
}

/**
 * The company's "Region", which needs the configured region list and so can't
 * be driven by the spec table above. Empty list renders a single disabled-
 * looking placeholder rather than an empty select the manager could stare at.
 */
export function CompanyRegionField({
  binding,
  regions,
  hint,
  required,
  className,
}: {
  binding: CompanyFieldBinding;
  regions: RegionOption[];
  hint?: string;
  required?: boolean;
  className?: string;
}) {
  const id = fieldId(binding.idPrefix, "region");

  // One region means no choice. A select with one option invites a click
  // that can do nothing and implies other regions exist. Render the value
  // instead — but keep feeding the form exactly what the select would have:
  // a `regionCode` input when this binding is named (the /clients form
  // posts FormData), and nothing extra when it is not (the builder submits
  // `binding.values` from state).
  //
  // What is rendered is the binding's OWN `regionCode`, not the offered
  // region. Those normally agree, and diverge on the client card when an
  // admin re-homes a manager: `updateUser` moves the manager, it does not
  // move the companies they already filed, so a manager now in US can open
  // a company that still belongs to AU. Displaying (and submitting) the
  // offered region there would rewrite that company's region — and with it
  // its currency and tax rules — on any save, including one that only
  // touched a phone number, and `assertRegionWritable` would wave it
  // through because the submitted region genuinely is the manager's. So the
  // offered region is used for nothing but looking up a display name, and
  // only when it is the region actually being displayed; a company sitting
  // in a region this viewer is not offered shows its bare code rather than
  // an invented name, submits that same code, and is rejected by
  // `assertRegionWritable` with FOREIGN_REGION_ERROR into `CompanyForm`'s
  // error slot. Visible and fail-closed beats silent and wrong.
  //
  // `FieldRow.htmlFor` is required, so it still points at `id` and the
  // rendered value carries it — a label on a non-form control, which is
  // inert rather than wrong, and keeps the row's markup identical to every
  // other field's.
  if (regions.length === 1) {
    // The fallback is for a genuinely empty value only — a "new company"
    // screen that seeded nothing — where the offered region is the right
    // default and there is no current value to contradict it.
    const code = binding.values.regionCode || regions[0].code;
    const offered = regions.find((r) => r.code === code);
    return (
      <FieldRow label="Region" htmlFor={id} hint={hint} required={required} className={className}>
        <span id={id} className="text-sm font-medium text-brand-dark">
          {offered ? `${offered.name} (${offered.code})` : code}
          {binding.named && <input type="hidden" name="regionCode" value={code} />}
        </span>
      </FieldRow>
    );
  }

  return (
    <FieldRow label="Region" htmlFor={id} hint={hint} required={required} className={className}>
      <select
        id={id}
        name={binding.named ? "regionCode" : undefined}
        value={binding.values.regionCode}
        onChange={(e) => binding.set("regionCode", e.target.value)}
        autoComplete="off"
        required={required && binding.named}
        disabled={binding.disabled}
        className={fieldInputClass}
      >
        {regions.length === 0 && <option value="">No regions configured</option>}
        {regions.map((r) => (
          <option key={r.code} value={r.code}>
            {r.name} ({r.code})
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

/**
 * "Same as main address" (owner: avoid double entry when the client office and
 * the manufacturing/delivery site are the same address). Unchecking it is what
 * reveals the delivery fields; the caller decides where those go, since one
 * host gives them a grid of their own and the other folds them into an
 * existing one.
 *
 * `named` also turns on a hidden fallback input of the same name, because a
 * plain unchecked `<input type="checkbox">` isn't submitted at all and
 * `deliverySameAsMainSchema` (src/lib/validation/clients.ts) needs an explicit
 * `"false"` to tell "unchecked" apart from "field never sent". Order matters:
 * `FormData.get` returns the first value for a repeated name and only a
 * checked box is ever included, so checked -> the checkbox's `"true"` wins,
 * unchecked -> only the hidden `"false"` is there.
 */
export function CompanyDeliverySameAsMainField({
  binding,
  label,
  className,
}: {
  binding: CompanyFieldBinding;
  label: string;
  className?: string;
}) {
  return (
    <label className={className}>
      <input
        type="checkbox"
        name={binding.named ? "deliverySameAsMain" : undefined}
        value="true"
        checked={binding.values.deliverySameAsMain}
        onChange={(e) => binding.set("deliverySameAsMain", e.target.checked)}
        disabled={binding.disabled}
        className="size-4 rounded border-slate-300 accent-brand"
      />
      {label}
      {binding.named ? <input type="hidden" name="deliverySameAsMain" value="false" /> : null}
    </label>
  );
}
