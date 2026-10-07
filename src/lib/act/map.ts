import { normalizeCountryInput } from "@/lib/countries";
import { companyKey } from "@/lib/act/company-key";
import { contactPhone } from "@/lib/act/phone";
import {
  ACTIVE_STATUSES,
  ACT_FIELD,
  type ActContact,
  type MapResult,
} from "@/lib/act/types";

// One ACT! contact to the shapes PathQuote stores, or a reason it was skipped.
//
// Pure on purpose: the skip rules and the field choices are the part of this
// integration most likely to be wrong, and they are the part that can be
// tested without a database or a network.

const ACTIVE = new Set<string>(ACTIVE_STATUSES);

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function custom(contact: ActContact, key: string): string | null {
  return text(contact.customFields?.[key]);
}

/**
 * Map one contact.
 *
 * `resolveIndustry` is passed in rather than imported so this stays pure and
 * the caller builds the alias index once for the whole run.
 */
export function mapContact(
  contact: ActContact,
  resolveIndustry: (raw: string | null | undefined) => string | null,
): MapResult {
  if (text(contact.contactType) !== "Contact") {
    return { kind: "skipped", reason: "not-a-contact" };
  }
  if (contact.isPrivate === true) {
    return { kind: "skipped", reason: "private" };
  }

  const status = text(contact.idStatus);

  // Personal contacts belong to the director and he shares them with nobody.
  // This is the ONLY barrier. client.ts sends no status filter -- its sole
  // $filter is `edited ge ...` -- so every Personal contact in the CRM reaches
  // this function. That is why it is a separate, explicit check and not left
  // to fall out of the active-status test below: widening ACTIVE_STATUSES
  // later must not be able to let them through, and they get a count of their
  // own in the run report.
  if (status === "Personal") {
    return { kind: "skipped", reason: "personal" };
  }
  if (!status || !ACTIVE.has(status)) {
    return { kind: "skipped", reason: "inactive-status" };
  }

  const first = text(contact.firstName);
  const last = text(contact.lastName);
  if (!first && !last) {
    return { kind: "skipped", reason: "no-name" };
  }

  const address = contact.businessAddress;
  const rawCountry = text(address?.country ?? null);
  const country = normalizeCountryInput(rawCountry);

  // PathQuote has one street field; ACT! has three lines and uses two.
  const street =
    [text(address?.line1 ?? null), text(address?.line2 ?? null), text(address?.line3 ?? null)]
      .filter(Boolean)
      .join(", ") || null;

  const companyName = text(contact.company);
  const email = text(contact.emailAddress);

  return {
    kind: "mapped",
    contact: {
      actContactId: contact.id,
      // PathQuote requires a first name; a mononym lands there rather than
      // being dropped for having no surname.
      firstName: first ?? (last as string),
      lastName: first ? last : null,
      email: email ? email.toLowerCase() : null,
      phone: contactPhone(contact.businessPhone, contact.mobilePhone, rawCountry),
      position: text(contact.jobTitle),
      actAccountMgr: custom(contact, ACT_FIELD.accountMgr),
      actEditedAt: new Date(contact.edited),
      snapshot: contact,
    },
    company: {
      actCompanyKey: companyName ? companyKey(companyName, country) : null,
      // The API returns "" rather than null for an unlinked contact.
      actCompanyId: text(contact.companyID),
      name: companyName ?? "",
      street,
      city: text(address?.city ?? null),
      state: text(address?.state ?? null),
      postcode: text(address?.postalCode ?? null),
      country,
      website: text(contact.website),
      industry: resolveIndustry(custom(contact, ACT_FIELD.industry)),
      actStatus: status,
      actRecordManagerId: text(contact.recordManagerID),
    },
  };
}
