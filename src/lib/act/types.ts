// The subset of the Act! Web API payloads this integration reads, and the
// PathQuote-shaped output the mapper produces.
//
// Field names here are the API's, which are NOT the names Act! shows a user:
// Industry is customFields/user6, Account Mgr is customFields/rep, and Stage
// lives in the stock messengerID field. See docs/act-integration-reference.md
// section 4 for the full table and resolve anything new through
// GET /api/metadata/contact/fields rather than guessing.

/** An address object as the API nests it under a contact or company. */
export type ActAddress = {
  line1: string | null;
  line2: string | null;
  line3: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

/** One contact, trimmed to the fields the sync reads. */
export type ActContact = {
  id: string;
  /** Empty string, not null, when the contact is linked to no company. */
  companyID: string | null;
  idStatus: string | null;
  contactType: string | null;
  isPrivate: boolean | null;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  emailAddress: string | null;
  businessPhone: string | null;
  mobilePhone: string | null;
  /** Free text. For 97.5% of contacts this is the only company there is. */
  company: string | null;
  website: string | null;
  businessAddress: ActAddress | null;
  recordManagerID: string | null;
  recordManager: string | null;
  customFields: Record<string, string | number | boolean | null> | null;
  created: string;
  edited: string;
};

/** Custom-field keys the sync reads, by their API name. */
export const ACT_FIELD = {
  /** Displayed as "Industry". A renamed stock user slot. */
  industry: "user6",
  /** Displayed as "Account Mgr". Visibility is decided on this. */
  accountMgr: "rep",
} as const;

/** What the mapper produces for one contact. */
export type MappedContact = {
  actContactId: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  /** E.164, or null when no spelling in the record could be resolved. */
  phone: string | null;
  position: string | null;
  actAccountMgr: string | null;
  actEditedAt: Date;
  snapshot: ActContact;
};

/** What the mapper produces for the company a contact belongs to. */
export type MappedCompany = {
  /** Null when the contact carries no company name at all. */
  actCompanyKey: string | null;
  /** Set only for the ~2.5% of contacts linked to a real ACT! company. */
  actCompanyId: string | null;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  /** ISO 3166-1 alpha-2, or null when the free-text country did not resolve. */
  country: string | null;
  website: string | null;
  /** A canonical industry segment name, or null. */
  industry: string | null;
  actStatus: string | null;
  actRecordManagerId: string | null;
};

/** The contact details a nameless record carries, which belong to the company
 *  rather than to any person. */
export type GenericChannel = {
  email: string | null;
  /** E.164 where it resolved, as for a named contact. */
  phone: string | null;
};

/** One contact mapped, or the reason it was skipped. */
export type MapResult =
  | { kind: "mapped"; contact: MappedContact; company: MappedCompany }
  /** The contact carries no name, but its company is real and often nothing
   *  else brings that company in -- 652 of the 713 such contacts are the only
   *  source of their company. Import the company, invent no person. */
  | { kind: "company-only"; company: MappedCompany; channel: GenericChannel }
  | { kind: "skipped"; reason: SkipReason };

export type SkipReason =
  | "not-a-contact"
  | "private"
  | "personal"
  | "inactive-status"
  /** No first name, no last name, and no company name either: nothing to
   * import. A nameless contact that does carry a company is `company-only`. */
  | "no-name"
  /** Has a name but no company name. PathQuote's Contact requires a company,
   * so there is nothing to attach it to. Decided by the worker, not the
   * mapper. */
  | "no-company";

/**
 * Statuses the sync imports. Everything else stays in ACT!.
 *
 * Narrowed from four to two on Vadym's instruction: a quote goes to a customer
 * or to someone being quoted, and ACT! holds a lot that never reaches one.
 * `Suspect` is raw leads. `Prospect-Distributor` is a distributor, which does
 * get quoted -- that one was raised and excluded deliberately, so widening the
 * list again is a decision rather than a fix.
 *
 * Widening it is also the one change that can leak the director's private
 * contacts, which is why map.ts refuses `Personal` separately instead of
 * relying on this list.
 */
export const ACTIVE_STATUSES = ["Customer", "Prospect"] as const;
