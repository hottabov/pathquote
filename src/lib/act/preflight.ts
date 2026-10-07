import { normalizeCountryInput } from "@/lib/countries";
import { companyKey, isNoCountryKey } from "@/lib/act/company-key";

// Reconcile the companies PathQuote already has with the identity the ACT!
// sync will look them up by.
//
// Every Company row that existed before the actCompanyKey column was added has
// that column null. The sync finds a company by key and creates one when it
// misses, so without this step every contact at an already-known client would
// create a SECOND copy of that client: the quotes stay on the old row, the
// picker offers two. This module decides, for each existing row, whether it is
// safe to write the key the sync would have computed.
//
// Pure on purpose, like the rest of this directory. Which rows get written to
// production is the whole risk of the script, so that decision is the part that
// can be tested without a database. The script around it only reads rows in and
// prints and writes the answer out.
//
// The key is computed by the same companyKey() the sync uses, from the same
// inputs, so a row that would match here is exactly a row the sync will match.
// Nothing in this file reimplements normalisation.

/** The subset of a Company row, with its related counts, the plan needs. */
export type CompanyRow = {
  id: string;
  name: string;
  /** As stored. ISO-2 for recent rows, free text ("Australia", "USA") for old ones. */
  country: string | null;
  actCompanyId: string | null;
  actCompanyKey: string | null;
  contactCount: number;
  /** Quotes and other documents. A company with these is one not to get wrong. */
  documentCount: number;
};

/** A company that can safely be given its key. */
export type BackfillItem = {
  company: CompanyRow;
  key: string;
};

/** Two or more companies that compute to the same key. */
export type AmbiguousGroup = {
  key: string;
  candidates: CompanyRow[];
  /** A different row that already holds this key, if there is one as well. */
  heldBy: CompanyRow | null;
};

/**
 * Unkeyed companies whose stored country did not resolve, so their key ends in
 * the `|??` placeholder. One group per key, so that two different companies
 * computing to the same key are listed as two rows under one key, never merged
 * into one line. A group of one is the common case; two or more is the same
 * ambiguity as AmbiguousGroup, and is shown as such.
 */
export type NoCountryGroup = {
  key: string;
  candidates: CompanyRow[];
  /** A different row that already holds this key, if there is one as well. */
  heldBy: CompanyRow | null;
};

/** A company whose computed key already belongs to another row. */
export type TakenItem = {
  company: CompanyRow;
  key: string;
  heldBy: CompanyRow;
};

export type BackfillPlan = {
  /**
   * Every company read. Always equals alreadyKeyed + unambiguous +
   * ambiguousCompanyCount + noCountryCompanyCount + taken + noKey.
   */
  total: number;
  /** Rows that already had a key. Never recomputed and never touched. */
  alreadyKeyed: number;
  /** The only group `--apply` writes. */
  unambiguous: BackfillItem[];
  ambiguous: AmbiguousGroup[];
  /** Reported, never written: a `|??` key is sticky and matches nothing. */
  noCountry: NoCountryGroup[];
  taken: TakenItem[];
  /** Names that normalise to nothing. */
  noKey: CompanyRow[];
};

function byName(a: CompanyRow, b: CompanyRow): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function byKey<T extends { key: string }>(a: T, b: T): number {
  return a.key.localeCompare(b.key);
}

/**
 * Sort every company into one of the groups the script reports.
 *
 * Only rows with `actCompanyKey === null` are considered for a key; a row that
 * already has one is counted and left alone, but its key still counts as
 * occupied, because the column is unique.
 *
 * The country given to companyKey() is the stored one run through
 * normalizeCountryInput(), which is what the sync does to ACT!'s free-text
 * country (map.ts). Without it a legacy row holding "USA" would compute
 * "acme|USA", a key the sync can never produce, and writing it would look like
 * a fix while changing nothing.
 *
 *  - unambiguous: exactly one unkeyed company computes to the key, and no other
 *    row holds it.
 *  - ambiguous: two or more unkeyed companies compute to the same key. Which
 *    one the ACT! contacts belong to is a guess, so none is chosen.
 *  - noCountry: the computed key ends in the `|??` placeholder, because the
 *    stored country is missing or does not resolve. Held back, whatever else is
 *    true of the key. An ACT! contact that has a country computes `name|AU`,
 *    never `name|??`, so the sync cannot find such a row and the client is
 *    duplicated either way. Writing the key would add nothing and would make
 *    the row permanent: a keyed row is never looked at again, so setting its
 *    country afterwards would not re-key it. Left null, the row is re-examined
 *    on the next run. Ambiguity still shows within the group: two companies
 *    computing to the same `|??` key are two entries under one key.
 *  - taken: one unkeyed company, but another row already holds its key.
 *  - noKey: companyKey() returned null.
 *
 * A key with two or more candidates is ambiguous whether or not a holder also
 * exists; the holder is attached to the group so a person sees it.
 */
export function planBackfill(rows: readonly CompanyRow[]): BackfillPlan {
  const holders = new Map<string, CompanyRow>();
  for (const row of rows) {
    if (row.actCompanyKey && !holders.has(row.actCompanyKey)) {
      holders.set(row.actCompanyKey, row);
    }
  }

  const candidatesByKey = new Map<string, CompanyRow[]>();
  const noCountryByKey = new Map<string, CompanyRow[]>();
  const noKey: CompanyRow[] = [];
  let alreadyKeyed = 0;

  for (const row of rows) {
    if (row.actCompanyKey !== null) {
      alreadyKeyed += 1;
      continue;
    }
    const key = companyKey(row.name, normalizeCountryInput(row.country));
    if (key === null) {
      noKey.push(row);
      continue;
    }
    const target = isNoCountryKey(key) ? noCountryByKey : candidatesByKey;
    const group = target.get(key);
    if (group) group.push(row);
    else target.set(key, [row]);
  }

  const unambiguous: BackfillItem[] = [];
  const ambiguous: AmbiguousGroup[] = [];
  const noCountry: NoCountryGroup[] = [];
  const taken: TakenItem[] = [];

  for (const [key, candidates] of candidatesByKey) {
    const holder = holders.get(key) ?? null;
    if (candidates.length >= 2) {
      ambiguous.push({ key, candidates: [...candidates].sort(byName), heldBy: holder });
    } else if (holder) {
      taken.push({ company: candidates[0], key, heldBy: holder });
    } else {
      unambiguous.push({ company: candidates[0], key });
    }
  }

  for (const [key, candidates] of noCountryByKey) {
    noCountry.push({
      key,
      candidates: [...candidates].sort(byName),
      heldBy: holders.get(key) ?? null,
    });
  }

  return {
    total: rows.length,
    alreadyKeyed,
    unambiguous: unambiguous.sort(byKey),
    ambiguous: ambiguous.sort(byKey),
    noCountry: noCountry.sort(byKey),
    taken: taken.sort(byKey),
    noKey: noKey.sort(byName),
  };
}

/** Companies, not keys: an ambiguous group of three is three rows. */
export function ambiguousCompanyCount(plan: BackfillPlan): number {
  return plan.ambiguous.reduce((sum, group) => sum + group.candidates.length, 0);
}

/** Companies, not keys: two companies sharing one `|??` key are two rows. */
export function noCountryCompanyCount(plan: BackfillPlan): number {
  return plan.noCountry.reduce((sum, group) => sum + group.candidates.length, 0);
}

function describe(company: CompanyRow): string {
  const country = company.country ? company.country : "no country";
  const linked = company.actCompanyId ? "  linked to ACT! company" : "";
  return (
    `${company.id}  ${JSON.stringify(company.name)}  ${country}` +
    `  contacts ${company.contactCount}  documents ${company.documentCount}${linked}`
  );
}

/**
 * The report, one string per line. Identical for a report-only run and for
 * `--apply` up to this point: the script adds what it wrote after it.
 */
export function formatReport(plan: BackfillPlan): string[] {
  const out: string[] = [];
  const ambiguousCompanies = ambiguousCompanyCount(plan);
  const noCountryCompanies = noCountryCompanyCount(plan);

  out.push(
    `UNAMBIGUOUS: ${plan.unambiguous.length} -- one company computes to the key and nothing else holds it`,
  );
  if (plan.unambiguous.length === 0) out.push("  none");
  for (const { company, key } of plan.unambiguous) {
    out.push(`  ${key}`);
    out.push(`      ${describe(company)}`);
  }

  out.push("");
  out.push(
    `NO COUNTRY: ${plan.noCountry.length} key(s), ${noCountryCompanies} companies -- left alone, never written`,
  );
  if (plan.noCountry.length === 0) out.push("  none");
  for (const group of plan.noCountry) {
    const shared =
      group.candidates.length >= 2
        ? `  -- ${group.candidates.length} companies compute to this key`
        : "";
    out.push(`  ${group.key}${shared}`);
    for (const company of group.candidates) out.push(`      ${describe(company)}`);
    if (group.heldBy) out.push(`      already holds this key: ${describe(group.heldBy)}`);
  }
  if (plan.noCountry.length > 0) {
    out.push("");
    out.push("  !! The country on these companies is missing or does not resolve to an ISO");
    out.push("  !! code, so their key would end in |??. An ACT! contact that HAS a country");
    out.push("  !! computes a different key, so the sync will not find these rows and will");
    out.push("  !! create a second copy of each client until the country is fixed.");
    out.push("  !! Writing a |?? key would not help, and would make it worse: a row that holds");
    out.push("  !! a key is never looked at again, so correcting its country afterwards would");
    out.push("  !! not re-key it.");
    out.push("  !! To fix: set the company's country, then re-run this preflight. The row is");
    out.push("  !! then keyed from its real country (or listed as ambiguous or taken, if that");
    out.push("  !! key is shared).");
  }

  out.push("");
  out.push(
    `AMBIGUOUS: ${plan.ambiguous.length} key(s), ${ambiguousCompanies} companies -- left alone`,
  );
  if (plan.ambiguous.length === 0) out.push("  none");
  for (const group of plan.ambiguous) {
    out.push(`  ${group.key}`);
    for (const company of group.candidates) out.push(`      ${describe(company)}`);
    if (group.heldBy) out.push(`      already holds this key: ${describe(group.heldBy)}`);
  }
  if (plan.ambiguous.length > 0) {
    out.push("");
    out.push("  !! Leaving these alone is not neutral. None of these rows will hold the key,");
    out.push("  !! so the first act:sync will not find any of them and will create a NEW");
    out.push("  !! company for each key. Decide before the sync, not after.");
  }

  out.push("");
  out.push(`ALREADY TAKEN: ${plan.taken.length} -- the key is held by a different company; left alone`);
  if (plan.taken.length === 0) out.push("  none");
  for (const { company, key, heldBy } of plan.taken) {
    out.push(`  ${key}`);
    out.push(`      ${describe(company)}`);
    out.push(`      held by: ${describe(heldBy)}`);
  }

  out.push("");
  out.push(`NO KEY: ${plan.noKey.length} -- the name normalises to nothing; left alone`);
  if (plan.noKey.length === 0) out.push("  none");
  for (const company of plan.noKey) out.push(`  ${describe(company)}`);

  out.push("");
  out.push("SUMMARY");
  const line = (label: string, value: number, note = "") =>
    out.push(`  ${label.padEnd(30)}${String(value).padStart(6)}${note}`);
  line("companies in the database", plan.total);
  line("already have a key", plan.alreadyKeyed);
  line("would be backfilled", plan.unambiguous.length);
  line("ambiguous", ambiguousCompanies, `   (${plan.ambiguous.length} key(s))`);
  line("no country", noCountryCompanies, `   (${plan.noCountry.length} key(s))`);
  line("already taken", plan.taken.length);
  line("no key", plan.noKey.length);

  return out;
}
