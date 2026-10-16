"use client";

import { useEffect, useState } from "react";
import { COUNTRIES } from "@/lib/countries";
import { dialCodeFor, regionForDialCode, DIAL_CODES } from "@/lib/phone-regions";
import { fieldInputClass } from "./field-row";
import { cn } from "@/lib/utils";

/** Only the countries that have a telephone numbering plan of their own —
 * see `DIAL_CODES`' doc comment for the handful this leaves out. Sorted by
 * name, like `COUNTRIES` itself. */
const DIALLABLE = COUNTRIES.filter((c) => DIAL_CODES[c.code] !== undefined);

/**
 * The regional-indicator flag emoji for an ISO alpha-2 code: each letter
 * maps to its indicator symbol (A -> U+1F1E6), and a pair of them renders as
 * one flag. No image assets, no icon library, and it inherits the text
 * colour and size of whatever it sits in.
 */
function flagOf(code: string): string {
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((letter) => 0x1f1a5 + letter.charCodeAt(0))
  );
}

/** Everything but the digits, dropped — what the national part is really
 * made of, whatever spacing or punctuation was typed or pasted around it. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Splits a stored value into the country and the national digits the field
 * edits separately.
 *
 * A stored number is E.164 (`+61393383471`) — what the schema normalises to
 * — so the country comes from the longest dialling-code prefix that matches,
 * rather than from the phone library, which has not loaded at first render.
 * Longest wins because +2 is a prefix of +20 and +7 of +76.
 *
 * A dialling code does not identify a country on its own: twenty-odd of them
 * dial +1. `regionForDialCode` settles that, preferring `fallbackCountry`
 * when the company is itself one of the sharers, and otherwise naming the
 * country the code principally belongs to. It matters only for the flag and
 * for how the digits are grouped — every sharer of a code produces the same
 * E.164 either way.
 *
 * `fallbackCountry` also covers the empty value (a new contact) and a legacy
 * row holding something that was never E.164.
 */
export function splitNumber(
  value: string,
  fallbackCountry: string
): { country: string; national: string } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("+")) {
    return { country: fallbackCountry, national: digitsOf(trimmed) };
  }

  const digits = digitsOf(trimmed);
  let best: { dial: number; length: number } | null = null;
  for (const dial of Object.values(DIAL_CODES)) {
    const prefix = String(dial);
    if (!digits.startsWith(prefix)) continue;
    if (!best || prefix.length > best.length) best = { dial, length: prefix.length };
  }

  if (!best) return { country: fallbackCountry, national: digits };
  return {
    country: regionForDialCode(best.dial, fallbackCountry) ?? fallbackCountry,
    national: digits.slice(best.length),
  };
}

type PhoneLib = typeof import("google-libphonenumber");

/**
 * A phone number entered as a country plus a national number, rather than as
 * one free-text string.
 *
 * The owner's requirement was that every manager records every number the
 * same way. Asking them to type "+61 3 9338 3471" and rejecting "03 9338
 * 3471" achieves that only in the sense that a locked door achieves tidiness
 * — so the country is a picker (flag and dialling code, defaulted from the
 * company), and the national part is formatted as it is typed, in that
 * country's own convention. What reaches the server is always E.164, in a
 * hidden input under `name`, so nothing downstream has to know this field
 * exists.
 *
 * `google-libphonenumber` does the formatting and the validity check, but it
 * is ~570KB and this field appears on three screens, so it is imported
 * lazily on mount. Until it lands the field is a plain digits input that
 * still assembles a correct E.164 value from `DIAL_CODES` — nothing is
 * blocked, the digits simply are not grouped yet.
 */
export function PhoneField({
  id,
  name,
  value,
  onChange,
  defaultCountry = "AU",
  placeholder,
  disabled,
  className,
}: {
  id?: string;
  name?: string;
  /** E.164, or "" for no number. */
  value: string;
  /** Receives E.164, or "" once the national part is cleared. */
  onChange: (value: string) => void;
  /** Preselected country for an empty field — the company's own country,
   * where one is known. Falls back to Australia, where Pathfinder is. */
  defaultCountry?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [lib, setLib] = useState<PhoneLib | null>(null);
  // Seeded once from the incoming value: after mount the two halves are what
  // the manager is editing, and `value` is downstream of them. A lazy
  // initializer rather than a plain call so the split isn't recomputed on
  // every keystroke.
  const [country, setCountry] = useState(() => splitNumber(value, defaultCountry).country);
  const [national, setNational] = useState(() => splitNumber(value, defaultCountry).national);

  // The formatting library (google-libphonenumber, ~580 KB of JavaScript)
  // is fetched the first time the field is touched -- focus, or a value
  // already present on mount that is worth grouping -- not on every mount:
  // the client card, the new-client form and the builder's "+ New company"
  // panel all render this field, and most visits never type a phone number
  // (audit 2026-10-16, PERF-08). Until it arrives the field works ungrouped.
  const [wanted, setWanted] = useState(() => value !== "");

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    import("google-libphonenumber").then((loaded) => {
      // A CommonJS package. Whether the bundler's interop puts its exports
      // on the namespace object or only under `default` varies, so take
      // whichever one actually carries them — and if neither does, leave
      // `lib` null rather than throwing on every keystroke: the field still
      // works, it just doesn't group the digits.
      const namespaced = loaded as unknown as { default?: PhoneLib };
      const mod = namespaced.default?.AsYouTypeFormatter ? namespaced.default : loaded;
      if (live && mod?.AsYouTypeFormatter) setLib(mod);
    });
    return () => {
      live = false;
    };
  }, [wanted]);

  const dial = dialCodeFor(country) ?? 0;

  /** E.164 for a country + national digits, or "" when there are none. A
   * value is submitted whether or not it is *valid*: the schema is the one
   * authority on that (`optionalPhone`, src/lib/validation/clients.ts), and
   * silently dropping a number the manager typed would be worse than showing
   * them the rejection. */
  function compose(nextCountry: string, nextNational: string): string {
    const digits = digitsOf(nextNational);
    if (digits === "") return "";
    return `+${dialCodeFor(nextCountry) ?? ""}${digits}`;
  }

  /** The national number grouped the way this country writes it. Returns the
   * raw digits unchanged while the library is still loading, and for a
   * partial number the formatter cannot place. */
  function format(digits: string): string {
    if (!lib || digits === "") return digits;
    try {
      const formatter = new lib.AsYouTypeFormatter(country);
      let formatted = "";
      for (const digit of digits) formatted = formatter.inputDigit(digit);
      // The formatter echoes the international prefix back once it decides a
      // number is international; this field shows the national part only,
      // and the country picker beside it says the rest.
      return formatted.replace(/^\+\d+\s*/, "");
    } catch {
      return digits;
    }
  }

  /** Whether what is typed so far is a real number in this country. `null`
   * while the field is empty or the library has not loaded — neither is a
   * verdict, and neither should show a tick or a warning. */
  function validity(): boolean | null {
    const digits = digitsOf(national);
    if (!lib || digits === "") return null;
    try {
      const util = lib.PhoneNumberUtil.getInstance();
      return util.isValidNumber(util.parse(`+${dial}${digits}`, country));
    } catch {
      return false;
    }
  }

  function handleCountry(next: string) {
    setCountry(next);
    onChange(compose(next, national));
  }

  function handleNational(raw: string) {
    const digits = digitsOf(raw);
    setNational(digits);
    onChange(compose(country, digits));
  }

  const valid = validity();

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex gap-2">
        <select
          aria-label="Country calling code"
          value={country}
          onChange={(e) => handleCountry(e.target.value)}
          onFocus={() => setWanted(true)}
          disabled={disabled}
          autoComplete="off"
          className={cn(fieldInputClass, "w-[7.5rem] shrink-0 pr-1")}
        >
          {DIALLABLE.map((c) => (
            <option key={c.code} value={c.code}>
              {flagOf(c.code)} +{DIAL_CODES[c.code]} {c.name}
            </option>
          ))}
        </select>

        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={format(national)}
          onChange={(e) => handleNational(e.target.value)}
          onFocus={() => setWanted(true)}
          disabled={disabled}
          placeholder={placeholder}
          maxLength={24}
          className={cn(fieldInputClass, "flex-1")}
        />
      </div>

      {/* What actually gets submitted. The two controls above are pure UI and
          carry no `name` of their own, so a server action keeps reading one
          field exactly as it did when this was a text input. */}
      {name ? <input type="hidden" name={name} value={compose(country, national)} /> : null}

      {valid === false ? (
        <p className="text-xs text-amber-700">
          Not a valid {DIALLABLE.find((c) => c.code === country)?.name ?? country} number yet.
        </p>
      ) : null}
    </div>
  );
}
