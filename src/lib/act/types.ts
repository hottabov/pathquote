// The subset of the Act! Web API payloads this integration reads, and the
// PathQuote-shaped output the mapper produces.
//
// Field names here are the API's, which are NOT the names Act! shows a user:
// Industry is customFields/user6, Account Mgr is customFields/rep, and Stage
// lives in the stock messengerID field. See docs/act-integration-reference.md
// section 4 for the full table and resolve anything new through
// GET /api/metadata/contact/fields rather than guessing.

import type { ContactStatus } from "@/lib/act/write-payloads";

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

/** One contact, trimmed to the fields the sync reads. A contact the client
 *  returns from a read or a write carries every field ACT! sent, beyond these. */
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

/**
 * One history record (`act.web.api.models.Histories.History` in swagger.json),
 * trimmed to the fields the weekly report reads.
 *
 * `startTime` is the Date column of Act!'s History tab -- when the call or
 * meeting happened -- and `recordManagerID` the uuid of the user it belongs to.
 * `historyTypeID` is one of the 71 types in RAW/ACT/meta/history_types.json.
 */
export type ActHistory = {
  id: string;
  historyTypeID: number;
  historyType: { id: number; name: string | null } | null;
  recordManagerID: string | null;
  recordManager: string | null;
  startTime: string | null;
  created: string | null;
  isPrivate: boolean | null;
};

/** A record named inside another one: a History's contacts, an opportunity's companies. */
export type ActEmbeddedRef = {
  id: string;
  /** EmbeddedContact's `displayName`; EmbeddedCompany and EmbeddedOpportunity carry `name`. */
  displayName?: string | null;
  name?: string | null;
};

/**
 * A History record as `POST /api/History` answers with it: the whole
 * `act.web.api.models.Histories.History`, where ActHistory is the subset the
 * weekly report reads. Every added field is nullable for the reason ActUser's
 * are: swagger marks no field of the model required.
 */
export type ActHistoryRecord = ActHistory & {
  regarding: string | null;
  details: string | null;
  endTime: string | null;
  edited: string | null;
  contacts: ActEmbeddedRef[] | null;
  companies: ActEmbeddedRef[] | null;
  opportunities: ActEmbeddedRef[] | null;
};

/**
 * An opportunity's stage as ACT! returns it
 * (`act.web.api.models.Opportunities.Stage`). `process` is the sales process
 * the stage belongs to; its `id` and the stage's `number` are what the
 * forward-only rule compares (StagePosition in
 * src/lib/act/opportunity-stages.ts).
 */
export type ActStage = {
  id: string;
  name: string | null;
  description: string | null;
  probability: number | null;
  number: number | null;
  process: { id: string; name: string | null } | null;
};

/**
 * One opportunity (`act.web.api.models.Opportunities.Opportunity` in swagger),
 * trimmed to the fields the write-back reads or sends. The object at runtime
 * carries every field ACT! sent -- `weightedTotal`, `daysOpen` and the rest --
 * which is what the drain (Task 7) is to store as the snapshot, and what an
 * update sends back less the fields ACT! computes (writableOpportunity in
 * src/lib/act/record-write.ts). `productTotal` is read, never written: ACT!
 * computes it from the products.
 *
 * `status` is not narrowed to OPPORTUNITY_STATUS: what ACT! says is not ours
 * to assume (OpportunityNow in src/lib/act/write-payloads.ts).
 */
export type ActOpportunity = {
  id: string;
  name: string | null;
  status: string | null;
  stage: ActStage | null;
  probability: number | null;
  productTotal: number | null;
  openDate: string | null;
  stageStartDate: string | null;
  actualCloseDate: string | null;
  estimatedCloseDate: string | null;
  reason: string | null;
  isPrivate: boolean | null;
  recordManagerID: string | null;
  recordManager: string | null;
  contacts: ActEmbeddedRef[] | null;
  companies: ActEmbeddedRef[] | null;
  customFields: Record<string, string | number | boolean | null> | null;
  created: string | null;
  edited: string | null;
};

/**
 * One product line of an opportunity
 * (`act.web.api.models.Opportunities.OpportunityProduct` in swagger), trimmed
 * to the fields the write-back sends or reads. PathQuote keeps exactly one per
 * deal, carrying its amount (summaryProductBody in
 * src/lib/act/write-payloads.ts). `id` is the line's own id -- what
 * Document.actProductLineId holds and the path of a PATCH names -- not
 * `productID`, which would be an ACT! catalogue product and is not set.
 * Nullable for the reason ActUser's fields are.
 */
export type ActProductLine = {
  id: string;
  opportunityID: string | null;
  name: string | null;
  /** "Item #": the quote number on PathQuote's line, which is how it is found again. */
  itemNumber: string | null;
  quantity: number | null;
  price: number | null;
  discountPrice: number | null;
  total: number | null;
  created: string | null;
  edited: string | null;
};

/**
 * The fields of a contact an update may change: `idStatus`, which promotion
 * changes (contactPromotion in src/lib/act/write-payloads.ts), and
 * `customFields`, naming only the custom fields to change, which are merged
 * key by key so that naming one cannot blank the rest. Nothing else: nothing
 * else is changed today, and the design spec's write
 * whitelist (docs/superpowers/specs/2026-09-08-act-integration-design.md)
 * sends only the fields PathQuote displays and edits, naming `recordManager`
 * among those never sent. (It named `idStatus` too; the plan's addendum of
 * 2026-10-12 made promotion the one exception.) `companyID` and
 * `contactType` are not PathQuote's to change on an existing contact
 * either. Nor is an address: one built from ActAddress would drop the
 * `latitude` and `longitude` ACT! keeps beside it, and a nested object in a
 * patch replaces the record's whole (mergeForWrite in
 * src/lib/act/record-write.ts, which also says how this is laid over the
 * record). Widening this is a decision, not a type fix.
 */
export type ActContactPatch = {
  idStatus?: ContactStatus;
  customFields?: Record<string, string | number | boolean | null>;
};

/**
 * One Act! user, trimmed to the fields the mapping reads.
 *
 * `id` is the uuid, which is the stable half of Record Manager: a contact
 * carries both `recordManagerID` (this uuid) and `recordManager` (the display
 * name), and only the uuid can be relied on. It is what User.actUserId holds.
 *
 * Everything but `id` is typed nullable because the swagger definition
 * (act.web.api.models.Users.UserInfo) marks no field required, so any of them
 * can be absent from the JSON. In the 20 users read on 2026-10-02
 * (RAW/ACT/meta/users.json) each had a display name, a role and a status, 17
 * of 20 had an email, and several had no lastLogOnDate.
 */
export type ActUser = {
  id: string;
  username: string | null;
  displayName: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** `Active` or `Inactive` in the live data. */
  status: string | null;
  /** `Standard`, `Browse` or `Administrator` in the live data. A `Browse`
   *  licence is read-only in Act!, which may matter to whoever writes records
   *  as these users; it is reported, never matched on. */
  role: string | null;
  /** ISO 8601 with an offset, or null for a user who has never signed in. */
  lastLogOnDate: string | null;
};

/**
 * One item of an Act! picklist, as the items endpoint returns it.
 *
 * `value` is the string a field limited to the list will accept -- the whole
 * point of reading these. `description` is free text an administrator may have
 * typed beside the item; the `Rep` picklist's items had it empty. The shape is
 * swagger's `act.web.api.models.MetaData.Picklists.DropDownPickListItem`,
 * which declares exactly these three fields.
 *
 * `value` is typed nullable for the same reason every ActUser field is: swagger
 * marks no field required, so a null is representable and the pure modules
 * must cope rather than assume.
 */
export type ActPicklistItem = {
  id: string;
  value: string | null;
  description: string | null;
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
