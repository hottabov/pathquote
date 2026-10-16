// What `npm run act:write-preflight` decides: every check's PASS, WARN, FAIL
// or INFO, the arithmetic behind it, and the report's wording.
//
// The preflight checks what the write-back into ACT! depends on and nobody
// has yet seen on the live box -- the service account's role, the filters the
// drain's duplicate lookups send, the picklists a contact create is held to,
// the stage ids transcribed by hand -- and the queue that switching sending on
// would release. It runs on the VPS, the one address ACT! answers
// (docs/act-integration-reference.md section 11), before the switch
// (src/lib/act/write-switch.ts) goes on, and again whenever ACT! changes.
//
// READ-ONLY, BOTH WAYS. The script (scripts/act-write-preflight.ts) holds an
// ActReader, never an ActClient (src/lib/act/client.ts): an object whose every
// function sends a GET. And it reads PathQuote in a transaction it has made
// READ ONLY before its first query. Nothing here does I/O at all: the script
// reads, hands this module plain values, and prints what comes back.
//
// THE RULE FOR A READ THAT FAILED: FAIL, "could not be checked". A preflight
// that could not ask has not done its job, and the request it could not make
// is, for checks 5 to 7, the very request the drain makes before a create.
// A read that worked and found nothing to test against -- no opportunity
// with products, no contact with History -- is WARN, "inconclusive": nothing
// is wrong that anyone can see, and nothing is proved either.
//
// THE CHECKS, numbered as the report and the runbook (docs/runbook.md, the
// write-back section) number them:
//
//    1  the service account: found by ACT_USER as the drain finds it, Active,
//       role Manager
//    2  PathQuote users mapped to ACT! users
//    3  Account Mgr values on the "Rep" picklist
//    4  the "Countries" picklist against the countries PathQuote's companies
//       are in
//    5  the opportunity lookup's `name` filter
//    6  product lines carry `itemNumber`
//    7  the History lookup's `regarding` filter
//    8  the switch, and the quotes switching it on would send
//    9  the 15-minute drain's timer (not visible from the container: INFO)
//   10  what is transcribed from ACT! by hand: the stage ids, the
//       opportunity name's length and the two picklist ids
//
// Pure, for the suite (vitest.config.ts): no database, no network, `now` a
// parameter.

import {
  ActApiError,
  COUNTRIES_PICKLIST_ID,
  LOOKUP_TOP,
  REP_PICKLIST_ID,
  filterRefused,
} from "@/lib/act/client";
import { actCountryValue } from "@/lib/act/country-picklist";
import { serviceAccountUserId } from "@/lib/act/drain-rules";
import { transcribedStages } from "@/lib/act/opportunity-stages";
import { sameRecordId } from "@/lib/act/record-write";
import { OPPORTUNITY_NAME_MAX } from "@/lib/act/write-payloads";
import { countryName, normalizeCountryInput } from "@/lib/countries";
import { formatCount, plural } from "@/lib/plural";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "INFO";

export type Check = {
  number: number;
  title: string;
  status: CheckStatus;
  /** One line: why this status. */
  reason: string;
  /** Supporting lines: what was read, what is listed. */
  details: string[];
  /** What to do. Empty for PASS and INFO. */
  todo: string[];
};

/** Why a read of ACT! failed, as the checks need it. */
export type ReadFailure = {
  message: string;
  /** The HTTP status ACT! answered with, or null for no answer at all. */
  status: number | null;
  /** filterRefused in src/lib/act/client.ts: a 4xx (not 401) the lookup falls back on. */
  filterRefused: boolean;
};

/** A read of ACT!: its rows, or why it failed. */
export type Read<T> = { ok: true; value: T } | { ok: false; failure: ReadFailure };

/** What the script hands over for an error thrown by an ActReader call. */
export function readFailure(error: unknown): ReadFailure {
  return {
    message: error instanceof Error ? error.message : String(error),
    status: error instanceof ActApiError ? error.status : null,
    filterRefused: filterRefused(error),
  };
}

/** A row of an ACT! answer, as it came: every field unknown until looked at. */
export type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function couldNotRead(number: number, title: string, what: string, failure: ReadFailure, extra: string[] = []): Check {
  return {
    number,
    title,
    status: "FAIL",
    reason: `could not be checked: ${what} failed -- ${failure.message}`,
    details: [],
    todo: [
      ...extra,
      "Run the preflight again. If it fails the same way, the drain will meet the same failure: find out why before switching sending on.",
    ],
  };
}

/** Every ACT! check's result when the first request to ACT! failed, so nothing else was asked. */
export function notAsked(number: number, title: string): Check {
  return {
    number,
    title,
    status: "FAIL",
    reason: "not checked: the first request to ACT! (check 1) failed, so nothing else was asked",
    details: [],
    todo: ["Fix what check 1 reports, then run the preflight again."],
  };
}

// --- 1 the service account ---------------------------------------------------

/**
 * The service account's id as docs/act-integration-reference.md section 2
 * records it, confirmed live 2026-10-12. Compared only to say so when ACT_USER
 * now finds another user; the drain never uses it.
 */
export const DOCUMENTED_SERVICE_ACCOUNT_ID = "d90f208e-e1fd-4835-8811-541b0c4b81b9";

const TITLE_1 = "Service account";

/**
 * The user ACT_USER logs in as, found the way the drain finds it
 * (serviceAccountUserId in src/lib/act/drain-rules.ts): exactly one user
 * whose `username` matches, trimmed and without regard to case. Then:
 *
 *   Active, role Manager      PASS
 *   role Administrator        WARN: writes work, but the reference keeps the
 *                             account at Manager on purpose (section 2)
 *   role Browse or Standard   FAIL: Browse is read-only, and Standard has only
 *                             the "My" permissions, so a write to anybody
 *                             else's record is refused
 *   any other role            WARN: not one this was written for
 *   not Active                FAIL
 *   none, or more than one    FAIL: the drain stops every pass
 */
export function serviceAccountCheck(users: Read<readonly Row[]>, login: string): Check {
  if (!users.ok) {
    const { status } = users.failure;
    const why =
      status === 401
        ? "Check ACT_USER (the ACT! display name, not a login id), ACT_PASS and ACT_DB in /opt/pathquote/.env."
        : status === 403
          ? "A 403 here is IIS refusing this address (the allow-list, docs/act-integration-reference.md section 11) or the account missing Web API Access. Run the preflight on the VPS, nowhere else."
          : status === null
            ? "ACT! did not answer: check ACT_BASE in /opt/pathquote/.env and that the ACT! server is up."
            : "ACT! answered, but not with its users.";
    return couldNotRead(1, TITLE_1, "GET /api/users", users.failure, [why]);
  }

  const id = serviceAccountUserId(users.value, login);
  const wanted = login.trim().toLowerCase();
  const matching = users.value.filter((user) => text(user.username)?.trim().toLowerCase() === wanted);
  if (!id) {
    return {
      number: 1,
      title: TITLE_1,
      status: "FAIL",
      reason:
        matching.length === 0
          ? `no ACT! user has the login "${login}" (ACT_USER): the drain would stop every pass, with no record manager for a quote whose author has no ACT! user`
          : `${formatCount(matching.length)} ACT! users have the login "${login}" (ACT_USER), and the drain will not guess between them: it would stop every pass`,
      details: users.value.map(
        (user) => `${text(user.username) ?? "(no username)"} -- ${text(user.role) ?? "no role"}, ${text(user.status) ?? "no status"}`,
      ),
      todo: ["Set ACT_USER in /opt/pathquote/.env to the service account's username exactly as listed above."],
    };
  }

  const user = matching[0];
  const status = text(user.status)?.trim() ?? "";
  const role = text(user.role)?.trim() ?? "";
  const named = `${text(user.username)?.trim() ?? login} (${id})`;
  const details = [`id ${id}, role ${role || "(none)"}, status ${status || "(none)"}`];
  if (!sameRecordId(id, DOCUMENTED_SERVICE_ACCOUNT_ID)) {
    details.push(
      `Not the id docs/act-integration-reference.md section 2 records (${DOCUMENTED_SERVICE_ACCOUNT_ID}); if the account was changed on purpose, update the reference.`,
    );
  }

  if (status.toLowerCase() !== "active") {
    return {
      number: 1,
      title: TITLE_1,
      status: "FAIL",
      reason: `${named} is ${status || "of no status"}, not Active`,
      details,
      todo: ["Have the ACT! administrator make the account Active (Tools, Manage Users)."],
    };
  }

  switch (role.toLowerCase()) {
    case "manager":
      return { number: 1, title: TITLE_1, status: "PASS", reason: `${named} is Active, role Manager`, details, todo: [] };
    case "administrator":
      return {
        number: 1,
        title: TITLE_1,
        status: "WARN",
        reason: `${named} is Active, role Administrator: writes will work, but it is more than the write-back needs`,
        details,
        todo: [
          "docs/act-integration-reference.md section 2 keeps the service account at Manager on purpose: Administrator adds Manage Users, Define Fields and Delete Database. Have the ACT! administrator set it back to Manager.",
        ],
      };
    case "browse":
    case "standard":
      return {
        number: 1,
        title: TITLE_1,
        status: "FAIL",
        reason:
          role.toLowerCase() === "browse"
            ? `${named} has role Browse, which is read-only in ACT!: every write the drain sends would be refused (403)`
            : `${named} has role Standard, which has only the "My" permissions: a write to a record somebody else manages would be refused`,
        details,
        todo: ["Have the ACT! administrator give the account the Manager role (Tools, Manage Users), then run the preflight again."],
      };
    default:
      return {
        number: 1,
        title: TITLE_1,
        status: "WARN",
        reason: `${named} is Active, role ${role || "(none)"} -- not a role this check knows`,
        details,
        todo: ["Confirm in ACT! (Tools, Manage Users) that the role carries the Manager permissions listed in docs/act-integration-reference.md section 2."],
      };
  }
}

// --- 2 users mapped --------------------------------------------------------------

/** A PathQuote user, as checks 2 and 3 read it. */
export type PathQuoteUser = {
  email: string;
  role: string;
  active: boolean;
  actUserId: string | null;
  actAccountMgr: string | null;
};

const TITLE_2 = "PathQuote users mapped to ACT!";

/**
 * Active users with User.actUserId set, against all active users. An author
 * with none is not an error -- a distributor has no ACT! user -- but the
 * records the drain writes for their quotes are managed by the service
 * account (WHO OWNS WHAT IS WRITTEN in src/lib/act/write-payloads.ts), and
 * only a contact the drain creates carries a person, in Account Mgr, when
 * User.actAccountMgr is set. PASS when every active user is mapped, WARN
 * otherwise.
 */
export function usersMappedCheck(users: readonly PathQuoteUser[]): Check {
  const active = users.filter((user) => user.active);
  const unmapped = active.filter((user) => !user.actUserId);
  if (unmapped.length === 0) {
    return {
      number: 2,
      title: TITLE_2,
      status: "PASS",
      reason: `every active user (${formatCount(active.length)}) is mapped to an ACT! user`,
      details: [],
      todo: [],
    };
  }
  return {
    number: 2,
    title: TITLE_2,
    status: "WARN",
    reason: `${formatCount(unmapped.length)} of ${plural(active.length, "active user has", "active users have")} no ACT! user: what the drain writes for their quotes is managed by the service account`,
    details: unmapped.map(
      (user) =>
        `${user.email} (${user.role}) -- ${
          user.actAccountMgr
            ? `a contact created for their quote gets Account Mgr "${user.actAccountMgr}"`
            : "a contact created for their quote gets no Account Mgr"
        }`,
    ),
    todo: [
      "Run npm run act:map-users on the VPS, read its report, then run it again with -- --apply (runbook, the write-back section). It maps anyone whose email is an ACT! user's.",
      "A distributor with no ACT! login stays unmapped, and that is expected.",
    ],
  };
}

// --- 3 the Rep picklist ----------------------------------------------------------

const TITLE_3 = "Account Mgr values on the Rep picklist";

function staleListNote(failure: ReadFailure, constant: string): string[] {
  return failure.status === 404
    ? [`Both picklist paths answered 404: the list id pinned as ${constant} in src/lib/act/client.ts may be stale. Re-read it from GET /api/metadata/contact/fields.`]
    : [];
}

/**
 * Account Mgr (`customFields/rep`) is limited to the "Rep" picklist, so a
 * contact create carrying a value not on it is refused, and the quote is
 * held. Every user's User.actAccountMgr -- active or not: an inactive
 * author's quote can still be queued -- must be an item exactly (FAIL
 * otherwise). An active user with no ACT! user and no Account Mgr -- a
 * distributor nobody has given an item -- is listed, WARN: their contacts are
 * created with no Account Mgr. PASS otherwise.
 */
export function repPicklistCheck(items: Read<readonly { value: string | null }[]>, users: readonly PathQuoteUser[]): Check {
  if (!items.ok) {
    return couldNotRead(3, TITLE_3, "reading the Rep picklist", items.failure, staleListNote(items.failure, "REP_PICKLIST_ID"));
  }
  const values = new Set(items.value.map((item) => item.value).filter((value): value is string => typeof value === "string"));
  const withValue = users.filter((user) => user.actAccountMgr !== null && user.actAccountMgr !== "");
  const offList = withValue.filter((user) => !values.has(user.actAccountMgr as string));
  const without = users.filter((user) => user.active && !user.actUserId && !user.actAccountMgr);
  const details = [
    `${plural(items.value.length, "item", "items")} on the list; ${plural(withValue.length, "user has", "users have")} an Account Mgr value`,
  ];

  if (offList.length > 0) {
    return {
      number: 3,
      title: TITLE_3,
      status: "FAIL",
      reason: `${plural(offList.length, "user's Account Mgr is", "users' Account Mgr values are")} not on the Rep picklist: ACT! would refuse every contact created for their quotes`,
      details: [
        ...details,
        ...offList.map((user) => `${user.email}: "${user.actAccountMgr}"`),
        ...without.map((user) => `${user.email} (${user.role}): no ACT! user and no Account Mgr -- contacts created with none`),
      ],
      todo: [
        "Have the ACT! administrator add the value to the Rep picklist exactly as listed, or clear it in PathQuote, from /opt/pathquote, replacing <email>:",
        `docker compose exec -T postgres psql -U pathquote -d pathquote -c "UPDATE \\"User\\" SET \\"actAccountMgr\\" = NULL WHERE email = '<email>';"`,
        "npm run act:map-users -- --apply then sets it again for a user whose ACT! display name is an item exactly; anybody else's contacts are created with no Account Mgr.",
      ],
    };
  }
  if (without.length > 0) {
    return {
      number: 3,
      title: TITLE_3,
      status: "WARN",
      reason: `every Account Mgr value is on the list, but ${plural(without.length, "active user has", "active users have")} no ACT! user and no Account Mgr: contacts created for their quotes get none`,
      details: [
        ...details,
        ...without.map((user) => `${user.email} (${user.role})`),
      ],
      todo: [
        "Safe as it is: the contact is created without an Account Mgr. Nothing in PathQuote gives a user with no ACT! user one (npm run act:map-users sets it from an ACT! user's display name), so a distributor who should appear there is a decision for the developer.",
      ],
    };
  }
  return { number: 3, title: TITLE_3, status: "PASS", reason: "every Account Mgr value is on the Rep picklist", details, todo: [] };
}

// --- 4 the Countries picklist --------------------------------------------------

/** One Company.country value as stored, with what stands on it. */
export type CompanyCountry = {
  /** Company.country, as stored: ISO 3166-1 alpha-2, or a legacy free-text value, or null. */
  country: string | null;
  /** Companies with this value. */
  companies: number;
  /** Their contacts with no Contact.actContactId: the ones a quote would create in ACT!. */
  contactsNotInAct: number;
};

/** One country PathQuote has and the Countries list does not. */
export type CountryMiss = { iso: string; name: string; companies: number; contactsNotInAct: number };

/** Check 4's arithmetic, for the check and its test. */
export type CountryCoverage = {
  /** ISO codes on PathQuote's companies. */
  present: number;
  /** Of `present`, those an item of the list spells. */
  covered: number;
  /** The others, most companies first. */
  misses: CountryMiss[];
  /** Companies whose country PathQuote itself cannot read: no country is sent for any of them. */
  unreadable: { country: string | null; companies: number; contactsNotInAct: number }[];
};

/**
 * Which of the countries PathQuote's companies are in the Countries picklist
 * spells, by the drain's own function: actCountryValue
 * (src/lib/act/country-picklist.ts), given the value as stored, which is what
 * the drain hands it (Company.country of the contact's company). Grouped by
 * the ISO code that value reads as; a value no code reads from -- blank, or
 * free text countries.ts does not know -- is `unreadable`.
 */
export function countryCoverage(
  rows: readonly CompanyCountry[],
  items: readonly { value: string | null }[],
): CountryCoverage {
  const byIso = new Map<string, { companies: number; contactsNotInAct: number; covered: boolean }>();
  const unreadable: CountryCoverage["unreadable"] = [];
  for (const row of rows) {
    const iso = normalizeCountryInput(row.country);
    if (!iso) {
      unreadable.push({ country: row.country, companies: row.companies, contactsNotInAct: row.contactsNotInAct });
      continue;
    }
    const entry = byIso.get(iso) ?? { companies: 0, contactsNotInAct: 0, covered: actCountryValue(row.country, items) !== null };
    entry.companies += row.companies;
    entry.contactsNotInAct += row.contactsNotInAct;
    byIso.set(iso, entry);
  }
  const misses = [...byIso.entries()]
    .filter(([, entry]) => !entry.covered)
    .map(([iso, entry]) => ({ iso, name: countryName(iso) ?? iso, companies: entry.companies, contactsNotInAct: entry.contactsNotInAct }))
    .sort((a, b) => b.companies - a.companies || a.iso.localeCompare(b.iso));
  unreadable.sort((a, b) => b.companies - a.companies);
  return { present: byIso.size, covered: byIso.size - misses.length, misses, unreadable };
}

const TITLE_4 = "Countries picklist";

/**
 * A contact the drain creates carries its company's country only when an
 * item of the Countries list spells it; otherwise the contact is created
 * with none. ACT! marks the field isAllowBlank false; whether it enforces
 * that on an API create is unverified (THE ADDRESS, newContactBody in
 * src/lib/act/write-payloads.ts), and if it does, those creates are refused
 * and their quotes held. WARN for any country missed, or companies whose
 * country PathQuote cannot read, or an empty list; PASS otherwise.
 */
export function countriesCheck(items: Read<readonly { value: string | null }[]>, rows: readonly CompanyCountry[]): Check {
  if (!items.ok) {
    return couldNotRead(4, TITLE_4, "reading the Countries picklist", items.failure, staleListNote(items.failure, "COUNTRIES_PICKLIST_ID"));
  }
  const coverage = countryCoverage(rows, items.value);
  const unreadableCompanies = coverage.unreadable.reduce((sum, row) => sum + row.companies, 0);
  const details = [
    `${plural(items.value.length, "item", "items")} on the list; ${formatCount(coverage.covered)} of the ${plural(coverage.present, "country", "countries")} PathQuote's companies are in ${coverage.covered === 1 ? "has an item" : "have an item"}`,
    ...coverage.misses.map(
      (miss) => `missing ${miss.iso} ${miss.name}: ${plural(miss.companies, "company", "companies")}, ${plural(miss.contactsNotInAct, "contact", "contacts")} not yet in ACT!`,
    ),
    ...coverage.unreadable.map(
      (row) =>
        `country ${row.country === null ? "(none)" : JSON.stringify(row.country)} PathQuote cannot read: ${plural(row.companies, "company", "companies")}, ${plural(row.contactsNotInAct, "contact", "contacts")} not yet in ACT!`,
    ),
  ];
  const consequence =
    "A contact created at those companies goes to ACT! with no country; if ACT! enforces the field's isAllowBlank false on an API create, that create is refused and the quote is held.";

  if (items.value.length === 0) {
    return {
      number: 4,
      title: TITLE_4,
      status: "WARN",
      reason: "the Countries picklist came back empty: every contact the drain creates would have no country",
      details,
      todo: [
        "An empty list is more likely a wrong list than an empty one: check COUNTRIES_PICKLIST_ID in src/lib/act/client.ts against GET /api/metadata/contact/fields (businessAddress/country).",
        consequence,
      ],
    };
  }
  if (coverage.misses.length > 0 || unreadableCompanies > 0) {
    const parts = [
      ...(coverage.misses.length > 0
        ? [`${plural(coverage.misses.length, "country", "countries")} PathQuote's companies are in ${coverage.misses.length === 1 ? "has" : "have"} no item on the list`]
        : []),
      ...(unreadableCompanies > 0 ? [`${plural(unreadableCompanies, "company has", "companies have")} a country PathQuote cannot read`] : []),
    ];
    return {
      number: 4,
      title: TITLE_4,
      status: "WARN",
      reason: parts.join(", and "),
      details,
      todo: [
        consequence,
        "Have the ACT! administrator add each missing country to the Countries list, spelled as its English name above; fix an unreadable country on the company's page in PathQuote.",
      ],
    };
  }
  return {
    number: 4,
    title: TITLE_4,
    status: "PASS",
    reason: `every country PathQuote's companies are in (${formatCount(coverage.present)}) has an item on the list`,
    details,
    todo: [],
  };
}

// --- 5 the opportunity name filter -------------------------------------------

/** A name no opportunity has: what check 5 asks ACT! for first. */
export const NONSENSE_NAME = "PathQuote write preflight: no opportunity has this name";

/** A name History check 7 asks for: no History has it. */
export const NONSENSE_REGARDING = "PathQuote write preflight: no History is regarding this";

/** How many opportunities checks 5 to 7 read, unfiltered, to find real names, products and contacts. */
export const OPPORTUNITY_SAMPLE_SIZE = 50;

/** The first opportunity on the page with an id and a name: check 5's real name. */
export function sampleOpportunity(page: readonly Row[]): { id: string; name: string } | null {
  for (const row of page) {
    const id = text(row.id);
    const name = text(row.name);
    if (id && name && name.trim() !== "") return { id, name };
  }
  return null;
}

export type OpportunityFilterInput = {
  /** `GET /api/opportunities` with the lookup's query, for NONSENSE_NAME. */
  nonsense: Read<readonly Row[]>;
  /** An unfiltered page of OPPORTUNITY_SAMPLE_SIZE. */
  page: Read<readonly Row[]>;
  /** The lookup's query for sampleOpportunity's name; null when there was none to ask for. */
  sample: { opportunity: { id: string; name: string }; rows: Read<readonly Row[]> } | null;
};

const TITLE_5 = "Opportunity name filter";

/**
 * Before every opportunity create the drain asks ACT! for the opportunities
 * with the deal's name (opportunitiesNamed in src/lib/act/client.ts), with
 * `$top` LOOKUP_TOP, and compares names itself (opportunityLookup in
 * src/lib/act/write-payloads.ts). The filter has never been tried live.
 *
 *   nonsense answered with rows      FAIL: the filter is ignored. The drain
 *                                    then reads every opportunity before
 *                                    each create, and refuses the lookup --
 *                                    every create backing off for good --
 *                                    once there are LOOKUP_TOP of them
 *   nonsense refused (a 4xx)         WARN: the drain falls back to the
 *                                    contact's own opportunities, which
 *                                    cannot see one made under another
 *                                    contact
 *   a real name: rows of another     FAIL: the filter does not do what the
 *   name, or the opportunity asked   lookup needs -- a missed opportunity is
 *   for missing                      created again
 *   zero, then exactly the real      PASS (names that differ only in case
 *   name's rows                      are allowed: the drain compares exactly)
 *   no opportunity to try a real     WARN, inconclusive
 *   name on
 */
export function opportunityFilterCheck(input: OpportunityFilterInput): Check {
  const { nonsense } = input;
  if (!nonsense.ok) {
    if (nonsense.failure.filterRefused) {
      return {
        number: 5,
        title: TITLE_5,
        status: "WARN",
        reason: `ACT! refused the name filter (${nonsense.failure.status}): the drain falls back to the contact's own opportunities, which cannot see an opportunity made for the quote under another contact`,
        details: [nonsense.failure.message],
        todo: [
          "Sending can go on, with that blind spot (opportunityLookup in src/lib/act/write-payloads.ts). A quote whose contact is changed between a lost create and the next attempt would get a second opportunity.",
        ],
      };
    }
    return couldNotRead(5, TITLE_5, "the drain's opportunity lookup", nonsense.failure);
  }
  if (nonsense.value.length > 0) {
    const full = nonsense.value.length >= LOOKUP_TOP;
    return {
      number: 5,
      title: TITLE_5,
      status: "FAIL",
      reason: `ACT! ignored $filter on /api/opportunities: asked for a name no opportunity has, it answered with ${plural(nonsense.value.length, "opportunity", "opportunities")}`,
      details: [
        full
          ? `That is a full page of ${formatCount(LOOKUP_TOP)}, which the drain refuses as cut short: every opportunity create would fail its lookup and back off, for good.`
          : `The drain compares names itself, so today it would still find a deal's opportunity -- by reading every opportunity in ACT! before each create -- and from ${formatCount(LOOKUP_TOP)} opportunities on it would refuse every lookup as cut short.`,
      ],
      todo: [
        "Do not switch sending on. The opportunity lookup (opportunitiesNamed in src/lib/act/client.ts) needs another way to find a deal's opportunity first.",
      ],
    };
  }
  if (!input.page.ok) {
    return couldNotRead(5, TITLE_5, "reading a page of opportunities to try a real name", input.page.failure);
  }
  if (!input.sample) {
    return {
      number: 5,
      title: TITLE_5,
      status: "WARN",
      reason:
        "inconclusive: no rows for a name nobody has is what a working filter gives, but ACT! offered no named opportunity to try a real name on",
      details: [`${plural(input.page.value.length, "opportunity", "opportunities")} read unfiltered`],
      todo: ["Run the preflight again once ACT! holds an opportunity, or ask ACT! for one by name by hand."],
    };
  }
  const { opportunity, rows } = input.sample;
  if (!rows.ok) {
    return couldNotRead(5, TITLE_5, `the lookup for "${opportunity.name}"`, rows.failure);
  }
  const wanted = opportunity.name.toLowerCase();
  const others = rows.value.filter((row) => text(row.name)?.toLowerCase() !== wanted);
  const found = rows.value.some((row) => {
    const id = text(row.id);
    return id !== null && sameRecordId(id, opportunity.id);
  });
  const details = [`real name tried: "${opportunity.name}" (${opportunity.id}), answered with ${plural(rows.value.length, "row", "rows")}`];
  if (others.length > 0) {
    return {
      number: 5,
      title: TITLE_5,
      status: "FAIL",
      reason: `asked for "${opportunity.name}", ACT! also answered with ${plural(others.length, "opportunity", "opportunities")} of another name: the filter is not applied as the lookup needs`,
      details: [...details, ...others.slice(0, 5).map((row) => `other name: ${JSON.stringify(row.name)}`)],
      todo: ["Do not switch sending on until the opportunity lookup has been looked at again (opportunitiesNamed in src/lib/act/client.ts)."],
    };
  }
  if (!found) {
    return {
      number: 5,
      title: TITLE_5,
      status: "FAIL",
      reason: `asked for "${opportunity.name}", ACT! did not return that opportunity: the lookup would miss an opportunity the drain made, and create a second`,
      details,
      todo: ["Do not switch sending on until the opportunity lookup has been looked at again (opportunitiesNamed in src/lib/act/client.ts)."],
    };
  }
  const caseOnly = rows.value.filter((row) => text(row.name) !== opportunity.name).length;
  return {
    number: 5,
    title: TITLE_5,
    status: "PASS",
    reason: `ACT! applies the filter: nothing for a name nobody has, and only "${opportunity.name}" for a real one`,
    details:
      caseOnly > 0
        ? [...details, `${plural(caseOnly, "row differs", "rows differ")} from the name only in case, which ACT! matched and the drain's own exact comparison leaves out`]
        : details,
    todo: [],
  };
}

// --- 6 product lines carry itemNumber -----------------------------------------

/** How many opportunities check 6 asks for products before it gives up. */
export const PRODUCT_PROBES = 10;

/**
 * The opportunities check 6 asks for products, at most PRODUCT_PROBES: those
 * whose productTotal is above zero first -- an opportunity with products has
 * one, unless every line is at zero -- then the rest, in the page's order.
 */
export function productProbeCandidates(page: readonly Row[]): { id: string; name: string }[] {
  const named = page
    .map((row) => ({ id: text(row.id), name: text(row.name) ?? "(no name)", total: row.productTotal }))
    .filter((row): row is { id: string; name: string; total: unknown } => row.id !== null && row.id !== "");
  const priced = named.filter((row) => typeof row.total === "number" && row.total > 0);
  const rest = named.filter((row) => !priced.includes(row));
  return [...priced, ...rest].slice(0, PRODUCT_PROBES).map(({ id, name }) => ({ id, name }));
}

export type ProductProbe = { opportunity: { id: string; name: string }; lines: Read<readonly Row[]> };

const TITLE_6 = "Product lines carry itemNumber";

/**
 * The drain finds the deal's own product line by `itemNumber` -- the quote
 * number -- before every line create (productLineLookup in
 * src/lib/act/write-payloads.ts). A line answered without the property at
 * all never matches, so the lookup would always say "create", and a lost
 * answer would become a second line: the deal's amount doubled. The
 * property must be there; empty is fine (a hand-made line has none).
 *
 * `page` is check 5's unfiltered page; `probes` the opportunities asked,
 * in order, the last of them the first that had lines.
 */
export function productLinesCheck(page: Read<readonly Row[]>, probes: readonly ProductProbe[]): Check {
  if (!page.ok) return couldNotRead(6, TITLE_6, "reading a page of opportunities", page.failure);
  const found = probes.find((probe) => probe.lines.ok && probe.lines.value.length > 0);
  if (found && found.lines.ok) {
    const lines = found.lines.value;
    const without = lines.filter((line) => !Object.hasOwn(line, "itemNumber"));
    const details = [
      `"${found.opportunity.name}" (${found.opportunity.id}): ${plural(lines.length, "line", "lines")}`,
      ...lines.slice(0, 5).map((line) => `line ${text(line.id) ?? "(no id)"}: itemNumber ${Object.hasOwn(line, "itemNumber") ? JSON.stringify(line.itemNumber) : "absent"}`),
    ];
    if (without.length > 0) {
      return {
        number: 6,
        title: TITLE_6,
        status: "FAIL",
        reason: `${plural(without.length, "product line", "product lines")} came back with no itemNumber property: the drain could never find its own line again, and a lost answer would create a second one, doubling the deal's amount`,
        details,
        todo: ["Do not switch sending on. The line lookup (productLineLookup in src/lib/act/write-payloads.ts) needs another key first."],
      };
    }
    return {
      number: 6,
      title: TITLE_6,
      status: "PASS",
      reason: `every product line on "${found.opportunity.name}" carries itemNumber`,
      details,
      todo: [],
    };
  }
  const failed = probes.filter((probe) => !probe.lines.ok);
  const firstFailure = failed[0]?.lines;
  if (firstFailure && !firstFailure.ok) {
    return couldNotRead(
      6,
      TITLE_6,
      `reading the products of ${plural(failed.length, "opportunity", "opportunities")} (the first, "${failed[0].opportunity.name}")`,
      firstFailure.failure,
    );
  }
  return {
    number: 6,
    title: TITLE_6,
    status: "WARN",
    reason: `inconclusive: none of the ${plural(probes.length, "opportunity", "opportunities")} asked has a product line`,
    details: [],
    todo: ["Before switching on, add a product line to any opportunity by hand in ACT! and run the preflight again, or confirm itemNumber on the first line the drain writes."],
  };
}

// --- 7 the History regarding filter -------------------------------------------

/** How many contacts, off the opportunity page, check 7 tries for one with History. */
export const HISTORY_PROBES = 5;

/** How many History rows check 7 asks for, unfiltered, to see that a contact has any. */
export const HISTORY_SAMPLE_SIZE = 5;

/** The contacts named on the opportunities read, each once, at most HISTORY_PROBES. */
export function historyProbeContacts(page: readonly Row[]): string[] {
  const ids: string[] = [];
  for (const row of page) {
    const contacts = Array.isArray(row.contacts) ? row.contacts : [];
    for (const contact of contacts) {
      const id = contact && typeof contact === "object" ? text((contact as Row).id) : null;
      if (id && !ids.some((seen) => sameRecordId(seen, id))) ids.push(id);
      if (ids.length >= HISTORY_PROBES) return ids;
    }
  }
  return ids;
}

export type HistoryFilterInput = {
  page: Read<readonly Row[]>;
  /** Each contact tried, with its unfiltered History sample, in order. */
  probes: readonly { contactId: string; history: Read<readonly Row[]> }[];
  /** The lookup's query for NONSENSE_REGARDING on the first contact that has History; null when none had any. */
  filtered: Read<readonly Row[]> | null;
};

const TITLE_7 = "History regarding filter";

/**
 * Before every History create the drain asks for the contact's Histories
 * with the revision's `regarding` (contactHistories in
 * src/lib/act/client.ts), and matches exactly itself (historyLookup in
 * src/lib/act/write-payloads.ts). Ignored, or refused -- when it falls back
 * to the contact's whole History -- the answer is still right, but it is the
 * contact's whole History, and a contact with LOOKUP_TOP or more is a full
 * page, which the lookup refuses: that quote's History step fails and backs
 * off, again and again, and the deal events after it wait with it. So WARN,
 * not FAIL: it costs only contacts with that much History.
 */
export function historyFilterCheck(input: HistoryFilterInput): Check {
  if (!input.page.ok) return couldNotRead(7, TITLE_7, "reading a page of opportunities", input.page.failure);
  const chosen = input.probes.find((probe) => probe.history.ok && probe.history.value.length > 0);
  const consequence = `The drain still finds a revision's History, from the contact's whole History, but for a contact with ${formatCount(LOOKUP_TOP)} or more that is a full page, which it refuses: that quote's History, and the win and promotion after it, wait, retried at each backoff, until somebody looks.`;
  if (!chosen) {
    const failed = input.probes.find((probe) => !probe.history.ok);
    if (failed && !failed.history.ok) {
      return couldNotRead(7, TITLE_7, `reading the History of contact ${failed.contactId}`, failed.history.failure);
    }
    return {
      number: 7,
      title: TITLE_7,
      status: "WARN",
      reason: `inconclusive: none of the ${plural(input.probes.length, "contact", "contacts")} on the opportunities read has any History`,
      details: [],
      todo: ["Run the preflight again once an opportunity's contact has History in ACT!."],
    };
  }
  const details = [`contact tried: ${chosen.contactId}`];
  const filtered = input.filtered;
  if (!filtered) {
    // The script asks whenever a contact was chosen; reaching here is a script that did not.
    return couldNotRead(7, TITLE_7, "the drain's History lookup", { message: "it was never sent", status: null, filterRefused: false });
  }
  if (!filtered.ok) {
    if (filtered.failure.filterRefused) {
      return {
        number: 7,
        title: TITLE_7,
        status: "WARN",
        reason: `ACT! refused the regarding filter (${filtered.failure.status}): the drain falls back to the contact's whole History`,
        details: [...details, filtered.failure.message],
        todo: [consequence],
      };
    }
    return couldNotRead(7, TITLE_7, "the drain's History lookup", filtered.failure);
  }
  if (filtered.value.length > 0) {
    return {
      number: 7,
      title: TITLE_7,
      status: "WARN",
      reason: `ACT! ignored $filter on the contact's History: asked for a regarding no History has, it answered with ${plural(filtered.value.length, "record", "records")}`,
      details:
        filtered.value.length >= LOOKUP_TOP ? [...details, "That contact already has a full page: a quote on them would wait as below."] : details,
      todo: [consequence],
    };
  }
  return {
    number: 7,
    title: TITLE_7,
    status: "PASS",
    reason: "ACT! applies the filter: nothing for a regarding no History has, on a contact that has History",
    details,
    todo: [],
  };
}

// --- 8 the switch and the backlog -----------------------------------------------

/** An unfinished ActOutbox row, as check 8 lists it. */
export type BacklogRow = {
  documentId: string;
  number: string | null;
  /** Document.status: a quote unfinalised since it was queued reads DRAFT, and its row is still sent. */
  status: string;
  companyName: string | null;
  authorEmail: string;
  createdAt: Date;
  nextAttemptAt: Date;
  attempts: number;
  blockedReason: string | null;
  blockedBy: string | null;
};

/** Where an unfinished row stands, as check 8 sorts it. */
export type BacklogState = "due" | "backing off" | "held by PathQuote" | "held for its contact" | "held, duplicates in ACT!" | "held, ACT! refused" | "held, unreadable revision" | "held";

export function backlogState(row: Pick<BacklogRow, "blockedReason" | "blockedBy" | "nextAttemptAt">, now: Date): BacklogState {
  if (row.blockedReason === null) return row.nextAttemptAt.getTime() <= now.getTime() ? "due" : "backing off";
  switch (row.blockedBy) {
    case null:
      return "held by PathQuote";
    case "contact":
      return "held for its contact";
    case "drain":
      return "held, duplicates in ACT!";
    case "act":
      return "held, ACT! refused";
    case "revision":
      return "held, unreadable revision";
    default:
      return "held";
  }
}

/** Rows a pass sends on its own: due now, or once their backoff runs out. */
function sendsOnItsOwn(state: BacklogState): boolean {
  return state === "due" || state === "backing off";
}

const TITLE_8 = "The switch, and what switching on sends";

/**
 * Whether sending is on (act.write.enabled), and every unfinished row. The
 * rows a pass sends on its own -- due, and backing off -- are what switching
 * on releases at the next pass; held rows wait for what holds them, and the
 * planner's and the contact's are re-planned every pass, so they go too once
 * that is fixed. Each is listed by number, so test quotes can be taken out
 * ("Don't send this quote to ACT!" on the quote's page) before the switch.
 *
 *   off, nothing queued     PASS
 *   off, rows queued        WARN: review them first
 *   on, a row held          WARN: somebody has to act on it
 *   on, nothing held        PASS
 */
export function backlogCheck(sendingOn: boolean, rows: readonly BacklogRow[], now: Date): Check {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const states = sorted.map((row) => ({ row, state: backlogState(row, now) }));
  const counts = new Map<BacklogState, number>();
  for (const { state } of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  const sends = states.filter(({ state }) => sendsOnItsOwn(state));
  const held = states.filter(({ state }) => !sendsOnItsOwn(state));
  const line = ({ row, state }: { row: BacklogRow; state: BacklogState }) =>
    `${row.number ?? "(no number)"}  ${row.status}  ${row.companyName ?? "(no company)"}  by ${row.authorEmail}  queued ${row.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC  ${state}${row.attempts > 0 ? `, ${plural(row.attempts, "failed attempt", "failed attempts")}` : ""}  /quotes/${row.documentId}`;
  const details = [
    `sending is ${sendingOn ? "ON" : "OFF"} (Setting act.write.enabled)`,
    `${plural(rows.length, "unfinished row", "unfinished rows")}${
      rows.length > 0 ? `: ${[...counts.entries()].map(([state, count]) => `${formatCount(count)} ${state}`).join(", ")}` : ""
    }`,
    ...(sends.length > 0
      ? [
          sendingOn
            ? "Going on their own (a row backing off at the first pass after its wait):"
            : "Sent on their own once switched on -- a due row at the next pass, a row backing off at the first pass after its wait:",
          ...sends.map(line),
        ]
      : []),
    ...(held.length > 0 ? ["Held, sent once what holds them is settled:", ...held.map(line)] : []),
  ];

  if (!sendingOn) {
    if (rows.length === 0) {
      return { number: 8, title: TITLE_8, status: "PASS", reason: "sending is off, and nothing is queued", details, todo: [] };
    }
    return {
      number: 8,
      title: TITLE_8,
      status: "WARN",
      reason: `sending is off, and ${plural(rows.length, "quote is", "quotes are")} queued: switching it on sends ${
        sends.length === rows.length ? (rows.length === 1 ? "it" : "them") : `${formatCount(sends.length)} on ${sends.length === 1 ? "its" : "their"} own, and ${formatCount(held.length)} once what holds ${held.length === 1 ? "it" : "them"} is settled`
      }`,
      details,
      todo: [
        "Open each quote above that must not reach ACT! -- a test quote, a demo -- and press Don't send this quote to ACT! on its ACT! card (an administrator's button). Then run the preflight again: the list should hold only real quotes.",
      ],
    };
  }
  if (held.length > 0) {
    return {
      number: 8,
      title: TITLE_8,
      status: "WARN",
      reason: `sending is on; ${plural(held.length, "quote is", "quotes are")} held back from ACT!`,
      details,
      todo: ["Open each held quote and act on its ACT! card (runbook, the write-back section, When something is stuck)."],
    };
  }
  return {
    number: 8,
    title: TITLE_8,
    status: "PASS",
    reason: rows.length === 0 ? "sending is on, and nothing is queued" : `sending is on, and ${plural(rows.length, "quote goes", "quotes go")} on ${rows.length === 1 ? "its" : "their"} own`,
    details,
    todo: [],
  };
}

// --- 9 the drain timer -------------------------------------------------------------

/**
 * The timer runs on the host, and this runs in the `tools` container, which
 * mounts neither systemd nor /var/log (docker-compose.yml): what it last did
 * cannot be seen from here, so it is INFO, with where to look.
 */
export function drainTimerCheck(): Check {
  return {
    number: 9,
    title: "The five-minute drain",
    status: "INFO",
    reason: "not visible from inside the tools container: check it on the host",
    details: [
      "systemctl list-timers 'pq-act-*'",
      "tail -20 /var/log/pq-act-drain.log",
    ],
    todo: [],
  };
}

// --- 10 transcribed by hand ---------------------------------------------------------

const TITLE_10 = "Transcribed from ACT! by hand";

/** A field of `GET /api/metadata/fields`, by its record type and API name. */
function field(fields: readonly Row[], recordType: string, name: string): Row | undefined {
  return fields.find((row) => text(row.recordType)?.toLowerCase() === recordType && text(row.name) === name);
}

/**
 * What src/lib/act/opportunity-stages.ts, write-payloads.ts and client.ts
 * copied from ACT! and nothing reads back at runtime:
 *
 *   each transcribed stage, by id, in `GET /api/opportunities/stages`:
 *     missing, or in another process     FAIL: a write would send a stage
 *                                        ACT! does not have there
 *     a different name, number or        WARN: the forward-only rule orders
 *     probability                        by the transcribed number
 *   in `GET /api/metadata/fields`, the capture these were first read from:
 *     the Opportunity `name` field's     WARN when it is not
 *     length                             OPPORTUNITY_NAME_MAX
 *     the picklist ids of Contact        WARN when either is not the id
 *     `customFields/rep` and             pinned as REP_PICKLIST_ID or
 *     `businessAddress/country`          COUNTRIES_PICKLIST_ID (checks 3 and
 *                                        4 read the lists by the pinned ids)
 *     a field not there, or the read     WARN: nothing to compare
 *     failed
 *
 * On any difference the details carry what ACT! has now, for the file to be
 * brought into line with.
 */
export function transcribedCheck(stages: Read<readonly Row[]>, fields: Read<readonly Row[]>): Check {
  if (!stages.ok) return couldNotRead(10, TITLE_10, "GET /api/opportunities/stages", stages.failure);
  const fails: string[] = [];
  const warns: string[] = [];
  const details: string[] = [];
  const transcribed = transcribedStages();
  for (const stage of transcribed) {
    const live = stages.value.find((row) => {
      const id = text(row.id);
      return id !== null && sameRecordId(id, stage.id);
    });
    if (!live) {
      fails.push(`stage ${stage.name} (${stage.id}) is not in ACT!`);
      continue;
    }
    const process = live.process && typeof live.process === "object" ? text((live.process as Row).id) : null;
    if (process === null || !sameRecordId(process, stage.processId)) {
      fails.push(`stage ${stage.name} (${stage.id}) is in process ${process ?? "(none)"}, not ${stage.processId}`);
      continue;
    }
    const differences = [
      ...(text(live.name) !== stage.name ? [`name ${JSON.stringify(live.name)}`] : []),
      ...(live.number !== stage.number ? [`number ${JSON.stringify(live.number)}`] : []),
      ...(live.probability !== stage.probability ? [`probability ${JSON.stringify(live.probability)}`] : []),
    ];
    if (differences.length > 0) {
      warns.push(`stage ${stage.name} (${stage.id}) now has ${differences.join(", ")}`);
    } else {
      details.push(`stage ${stage.name} (${stage.id}): as transcribed`);
    }
  }
  if (fails.length > 0 || warns.length > 0) {
    // Every stage ACT! has in the transcribed processes, for the table in
    // opportunity-stages.ts to be copied from.
    const processes = new Set(transcribed.map((stage) => stage.processId.toLowerCase()));
    details.push("ACT!'s stages in those processes now:");
    for (const row of stages.value) {
      const process = row.process && typeof row.process === "object" ? text((row.process as Row).id) : null;
      if (process === null || !processes.has(process.toLowerCase())) continue;
      details.push(
        `  process ${process}: stage ${JSON.stringify(row.name)} id ${JSON.stringify(row.id)}, number ${JSON.stringify(row.number)}, probability ${JSON.stringify(row.probability)}`,
      );
    }
  }

  if (!fields.ok) {
    warns.push(`could not read GET /api/metadata/fields, so the name length and the picklist ids were not compared: ${fields.failure.message}`);
  } else {
    const nameField = field(fields.value, "opportunity", "name");
    if (!nameField || typeof nameField.length !== "number") {
      warns.push("GET /api/metadata/fields has no Opportunity field `name` with a length");
    } else if (nameField.length !== OPPORTUNITY_NAME_MAX) {
      warns.push(`the Opportunity Name field is now ${nameField.length} characters, not ${OPPORTUNITY_NAME_MAX} (OPPORTUNITY_NAME_MAX in src/lib/act/write-payloads.ts)`);
    } else {
      details.push(`Opportunity Name: ${OPPORTUNITY_NAME_MAX} characters, as transcribed`);
    }
    for (const [name, pinned, constant] of [
      ["customFields/rep", REP_PICKLIST_ID, "REP_PICKLIST_ID"],
      ["businessAddress/country", COUNTRIES_PICKLIST_ID, "COUNTRIES_PICKLIST_ID"],
    ] as const) {
      const entry = field(fields.value, "contact", name);
      const picklist = entry?.picklist && typeof entry.picklist === "object" ? (entry.picklist as Row) : null;
      const id = picklist ? text(picklist.id) : null;
      if (id === null) {
        warns.push(`GET /api/metadata/fields has no Contact field ${name} with a picklist id`);
      } else if (!sameRecordId(id, pinned)) {
        warns.push(`Contact ${name} now names picklist ${id} (${JSON.stringify(picklist?.name)}), not ${pinned} (${constant} in src/lib/act/client.ts)`);
      } else {
        details.push(`${name}: picklist ${pinned}, as pinned`);
      }
    }
  }

  const todo = [
    "Change the file named to match ACT! -- src/lib/act/opportunity-stages.ts for a stage, write-payloads.ts for the name length, client.ts for a picklist id -- never ACT! to match the file, and deploy before switching sending on.",
  ];
  if (fails.length > 0) {
    return { number: 10, title: TITLE_10, status: "FAIL", reason: fails.join("; "), details: [...warns, ...details], todo };
  }
  if (warns.length > 0) {
    return { number: 10, title: TITLE_10, status: "WARN", reason: warns.join("; "), details, todo };
  }
  return {
    number: 10,
    title: TITLE_10,
    status: "PASS",
    reason: "the stage ids, the opportunity name's length and the two picklist ids match ACT!",
    details,
    todo: [],
  };
}

// --- the report ---------------------------------------------------------------------

/** 0 when no check FAILed, 1 otherwise. (2, for a run that could not start, is the script's.) */
export function preflightExitStatus(checks: readonly Check[]): 0 | 1 {
  return checks.some((check) => check.status === "FAIL") ? 1 : 0;
}

/** The report, a line at a time. */
export function formatPreflightReport(checks: readonly Check[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`[${check.status}] ${check.number}. ${check.title}: ${check.reason}`);
    for (const detail of check.details) lines.push(`         ${detail}`);
    for (const step of check.todo) lines.push(`       do: ${step}`);
    lines.push("");
  }
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  lines.push(`${count("PASS")} PASS, ${count("WARN")} WARN, ${count("FAIL")} FAIL, ${count("INFO")} INFO`);
  lines.push(
    count("FAIL") > 0
      ? `Not ready: resolve every FAIL above, then run npm run act:write-preflight again.`
      : count("WARN") > 0
        ? "Nothing FAILed. Read every WARN above before switching sending on."
        : "Nothing FAILed and nothing WARNed.",
  );
  lines.push("Nothing was written to ACT! or to PathQuote.");
  return lines;
}
