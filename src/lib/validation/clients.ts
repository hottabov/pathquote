// Pure zod validation for the clients editors (companies and contacts). No
// imports from `@/lib/db` or any Prisma types — this module must be safely
// importable from a plain unit test and from the server actions that call
// it. Mirrors the style of src/lib/validation/catalog.ts.
import { z } from "zod";
import { isValidCountryCode } from "@/lib/countries";
import { validatePhone } from "@/lib/phone";

// --- shared field pieces -----------------------------------------------

const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(200, "Name must be at most 200 characters");

/** Optional free text that collapses missing/blank input to `undefined`. */
function optionalText(max: number, label: string) {
  return z.preprocess(
    (value) =>
      value === null || value === undefined || (typeof value === "string" && value.trim() === "")
        ? undefined
        : value,
    z.string().max(max, `${label} must be at most ${max} characters`).optional()
  );
}

const streetSchema = optionalText(120, "Street");
const citySchema = optionalText(120, "City");
const stateSchema = optionalText(120, "State");
const postcodeSchema = optionalText(20, "Postcode");
const taxIdSchema = optionalText(50, "Tax ID");
const notesSchema = optionalText(2000, "Notes");

/** Optional ISO 3166-1 alpha-2 country code — the `CountrySelect` picker
 * (src/components/ui-kit/country-select.tsx) only ever submits a valid code
 * or an empty string, but this still validates server-side (never trust the
 * client) against `src/lib/countries.ts`'s registry. Missing/blank input
 * collapses to `undefined`, same as every other optional address field. */
function optionalCountryCode(label: string) {
  return z.preprocess(
    (value) =>
      value === null || value === undefined || (typeof value === "string" && value.trim() === "")
        ? undefined
        : value,
    z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .refine((value) => isValidCountryCode(value), { message: `${label} must be a valid country` })
      .optional()
  );
}

const countrySchema = optionalCountryCode("Country");

/** Optional phone number, validated with `google-libphonenumber` (see
 * src/lib/phone.ts) rather than just capped by length — an invalid number
 * is rejected outright with a message safe to show the user directly (the
 * owner's explicit call: reject rather than silently keep unparseable raw
 * text). A parseable number is normalized to E.164 for storage so every
 * phone field in the database is in one consistent, dialable format. */
function optionalPhone(label: string) {
  return z.preprocess(
    (value) =>
      value === null || value === undefined || (typeof value === "string" && value.trim() === "")
        ? undefined
        : value,
    z
      .string()
      .max(40, `${label} must be at most 40 characters`)
      .transform((value, ctx) => {
        const result = validatePhone(value);
        if (!result.ok) {
          ctx.addIssue({ code: "custom", message: result.reason });
          return z.NEVER;
        }
        // `result.e164` is only ever null when `value` was blank, which
        // can't happen here — the preprocess above already filtered that
        // out — but fall back to the original value defensively either way.
        return result.e164 ?? value;
      })
      .optional()
  );
}

// Website URL: optional, normalized to https:// if no protocol
const websiteSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z
    .string()
    .trim()
    .refine((value) => {
      // Match either https?://... OR bare domain
      const protocolRegex = /^https?:\/\/\S+/i;
      const domainRegex = /^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i;
      return protocolRegex.test(value) || domainRegex.test(value);
    }, "Website must be a valid URL or domain")
    .transform((value) => {
      // Normalize: if no protocol, prepend https://
      if (!value.match(/^https?:\/\//i)) {
        return `https://${value}`;
      }
      return value;
    })
    .refine(
      (value) => value.length <= 200,
      "Website must be at most 200 characters after normalization"
    )
    .optional()
);

// A company carries NO region. It is a client of the whole business, not of
// one office: a director in the Australian head office quotes a European
// buyer without either of them changing hands. Region lives on the User (who
// may write catalogue prices), on the Document (which fixes the currency,
// tax and discount caps of one quote) and on the Price itself — never on the
// counterparty. `country` is the only geography a company has.


// --- delivery address ------------------------------------------------------
//
// Owner: "client office is not always the manufacturing site; delivery
// address matters" — a company optionally carries a second, distinct
// delivery address. `deliverySameAsMain` gates whether the delivery* fields
// below are required: when true (the default — see `deliverySameAsMainSchema`)
// they're all optional free text, same as the main address; when false, the
// street/city/postcode/country become required (enforced by the
// `companySchema.superRefine` below) so a document can never end up with a
// "different delivery address" flag set but no usable address, while the
// contact name/phone stay optional-but-recommended.

/**
 * Coerces the "Same as main address" checkbox to a boolean, defaulting to
 * `true` (same as main) when the field is missing entirely — unlike
 * `isPrimarySchema` below (where a native checkbox's *absence* on submit
 * always means "unchecked"), this field is always paired with a hidden
 * fallback input in the actual form (see `company-form.tsx`) precisely so
 * "unchecked" submits an explicit `"false"` rather than nothing; true
 * absence only happens for a caller that doesn't send the field at all
 * (e.g. a future non-delivery-aware call site), where "same as main, no
 * delivery fields required" is the safe default — it matches the column's
 * DB default (`Company.deliverySameAsMain @default(true)`).
 */
const deliverySameAsMainSchema = z.preprocess((value) => {
  if (value === undefined || value === null) return true;
  return value === "on" || value === true || value === "true" || value === "1";
}, z.boolean());

const deliveryStreetSchema = optionalText(120, "Delivery street");
const deliveryCitySchema = optionalText(120, "Delivery city");
const deliveryStateSchema = optionalText(120, "Delivery state");
const deliveryPostcodeSchema = optionalText(20, "Delivery postcode");
const deliveryCountrySchema = optionalCountryCode("Delivery country");
const deliveryContactNameSchema = optionalText(160, "Delivery contact name");
const deliveryPhoneSchema = optionalPhone("Delivery phone");
const deliveryNotesSchema = optionalText(500, "Delivery notes");

// --- company -------------------------------------------------------------

const baseCompanySchema = z.object({
  name: nameSchema,
  street: streetSchema,
  city: citySchema,
  state: stateSchema,
  postcode: postcodeSchema,
  country: countrySchema,
  website: websiteSchema,
  taxId: taxIdSchema,
  notes: notesSchema,
  deliverySameAsMain: deliverySameAsMainSchema,
  deliveryStreet: deliveryStreetSchema,
  deliveryCity: deliveryCitySchema,
  deliveryState: deliveryStateSchema,
  deliveryPostcode: deliveryPostcodeSchema,
  deliveryCountry: deliveryCountrySchema,
  deliveryContactName: deliveryContactNameSchema,
  deliveryPhone: deliveryPhoneSchema,
  deliveryNotes: deliveryNotesSchema,
});

const DELIVERY_REQUIRED_MESSAGE = "Required when the delivery address is different from the main address";

export const companySchema = baseCompanySchema.superRefine((data, ctx) => {
  if (data.deliverySameAsMain) return;
  if (!data.deliveryStreet) {
    ctx.addIssue({ code: "custom", path: ["deliveryStreet"], message: `Delivery street: ${DELIVERY_REQUIRED_MESSAGE}` });
  }
  if (!data.deliveryCity) {
    ctx.addIssue({ code: "custom", path: ["deliveryCity"], message: `Delivery city: ${DELIVERY_REQUIRED_MESSAGE}` });
  }
  if (!data.deliveryPostcode) {
    ctx.addIssue({ code: "custom", path: ["deliveryPostcode"], message: `Delivery postcode: ${DELIVERY_REQUIRED_MESSAGE}` });
  }
  if (!data.deliveryCountry) {
    ctx.addIssue({ code: "custom", path: ["deliveryCountry"], message: `Delivery country: ${DELIVERY_REQUIRED_MESSAGE}` });
  }
});

export type CompanyInput = z.infer<typeof companySchema>;

// --- contact ---------------------------------------------------------------

const firstNameSchema = z
  .string()
  .trim()
  .min(1, "First name is required")
  .max(80, "First name must be at most 80 characters");

const lastNameSchema = optionalText(80, "Last name");

/** Optional email: missing/blank collapses to `undefined`; otherwise must
 * be a valid email address. */
const emailSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.email("Must be a valid email address").optional()
);

const phoneSchema = optionalPhone("Phone");
const positionSchema = optionalText(80, "Position");

const isPrimarySchema = z.preprocess(
  (value) => value === "on" || value === true || value === "true" || value === "1",
  z.boolean()
);

export const contactSchema = z.object({
  firstName: firstNameSchema,
  lastName: lastNameSchema,
  email: emailSchema,
  phone: phoneSchema,
  position: positionSchema,
  isPrimary: isPrimarySchema,
});

export type ContactInput = z.infer<typeof contactSchema>;
