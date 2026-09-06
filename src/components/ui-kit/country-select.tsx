import { COUNTRIES } from "@/lib/countries";
import { fieldInputClass } from "./field-row";
import { cn } from "@/lib/utils";

/**
 * A plain native `<select>` over the full ISO 3166-1 country list (see
 * `src/lib/countries.ts`), styled with `fieldInputClass` to match
 * every other field control. Deliberately a native select rather than a
 * custom combobox — owner constraint was "no free typing (typos)", not
 * "must be searchable"; a native select is keyboard-searchable by typing a
 * letter (every browser does this for free), 44px-tall, and needs zero
 * client-side JS, which matters here since this same component renders both
 * inside server-rendered forms (company-form.tsx) and client forms
 * (client-section.tsx). `value`/`defaultValue` is always an ISO alpha-2
 * code or `""` (no selection); an unrecognized legacy value is still
 * rendered as its own selectable option (see `isKnown` below) rather than
 * silently reverting to blank, so opening a pre-migration company never
 * looks like data loss.
 */
export function CountrySelect({
  id,
  name,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  name?: string;
  /** Controlled value — pass together with `onChange`. */
  value?: string;
  /** Uncontrolled default — pass for a plain `<form action>` submission. */
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const current = value ?? defaultValue ?? "";
  const isKnown = current === "" || COUNTRIES.some((c) => c.code === current);

  return (
    <select
      id={id}
      name={name}
      aria-label={ariaLabel}
      value={value}
      defaultValue={value === undefined ? defaultValue : undefined}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      required={required}
      disabled={disabled}
      autoComplete="off"
      className={cn(fieldInputClass, className)}
    >
      <option value="">Select a country…</option>
      {!isKnown ? (
        <option value={current}>{current} (unrecognized)</option>
      ) : null}
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
