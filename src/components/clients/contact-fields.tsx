"use client";

import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { PhoneField } from "@/components/ui-kit/client";

/** The five fields that describe a person at a client company. `isPrimary`
 * is not one of them: only the /clients form offers it, and it is a fact
 * about the company's contact list rather than about the contact. */
export type ContactFieldValues = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  position: string;
};

export const EMPTY_CONTACT_FIELDS: ContactFieldValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  position: "",
};

/**
 * The contact name/email/phone/position grid, shared by the /clients contact
 * form (src/components/clients/contact-form.tsx — add and inline-edit both)
 * and the builder's inline "New contact" panel
 * (src/components/builder/client-section.tsx). The two hosts differ only in
 * how they submit: a real `<form action>` posting FormData on one side, React
 * state handed to a JSON action on the other. The fields themselves never
 * differed, and keeping two copies of them meant the panel quietly missed
 * whatever the form gained.
 *
 * `named` follows that split — see `CompanyFieldBinding` for the same
 * distinction spelled out at length. It also decides whether the first name
 * carries a `required` attribute: the label is marked required on both
 * screens, but browser constraint validation only runs on a form submit, and
 * the builder's panel disables its "Create" button on a blank first name
 * instead of submitting anything.
 */
export function ContactFields({
  values,
  set,
  idPrefix,
  named,
  disabled = false,
  defaultCountry,
}: {
  values: ContactFieldValues;
  set: <K extends keyof ContactFieldValues>(field: K, value: ContactFieldValues[K]) => void;
  idPrefix: string;
  named: boolean;
  disabled?: boolean;
  /** ISO alpha-2 the phone field opens on for a contact with no number yet —
   * the company's own country. See `PhoneField`. */
  defaultCountry?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <FieldRow label="First name" htmlFor={`${idPrefix}-first-name`} required>
        <input
          id={`${idPrefix}-first-name`}
          name={named ? "firstName" : undefined}
          value={values.firstName}
          onChange={(e) => set("firstName", e.target.value)}
          required={named}
          maxLength={80}
          disabled={disabled}
          className={fieldInputClass}
        />
      </FieldRow>

      <FieldRow label="Last name" htmlFor={`${idPrefix}-last-name`}>
        <input
          id={`${idPrefix}-last-name`}
          name={named ? "lastName" : undefined}
          value={values.lastName}
          onChange={(e) => set("lastName", e.target.value)}
          maxLength={80}
          disabled={disabled}
          className={fieldInputClass}
        />
      </FieldRow>

      <FieldRow label="Email" htmlFor={`${idPrefix}-email`}>
        <input
          id={`${idPrefix}-email`}
          name={named ? "email" : undefined}
          type="email"
          value={values.email}
          onChange={(e) => set("email", e.target.value)}
          disabled={disabled}
          className={fieldInputClass}
        />
      </FieldRow>

      <FieldRow label="Phone" htmlFor={`${idPrefix}-phone`}>
        <PhoneField
          id={`${idPrefix}-phone`}
          name={named ? "phone" : undefined}
          value={values.phone}
          onChange={(phone) => set("phone", phone)}
          defaultCountry={defaultCountry}
          disabled={disabled}
        />
      </FieldRow>

      <FieldRow label="Position" htmlFor={`${idPrefix}-position`} className="sm:col-span-2">
        <input
          id={`${idPrefix}-position`}
          name={named ? "position" : undefined}
          value={values.position}
          onChange={(e) => set("position", e.target.value)}
          maxLength={80}
          disabled={disabled}
          className={fieldInputClass}
        />
      </FieldRow>
    </div>
  );
}
