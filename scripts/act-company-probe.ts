/**
 * Probe how ACT! handles companies, before the company write-back is built
 * (docs/superpowers/specs/2026-10-15-act-write-back-companies.md, section 3,
 * "Unverified"). Prints what ACT! answers, raw, and decides nothing.
 *
 *   npm run act:company-probe                      # read-only
 *   npm run act:company-probe -- --write <quote>   # also writes, see below
 *
 * READ-ONLY PART (always):
 *   1. GET /api/companies with $filter=name eq '...' for a company PathQuote
 *      knows is in ACT! (a Company with actCompanyId), the same name in
 *      upper case, and a name that cannot exist -- is the filter honoured,
 *      and is it case-insensitive? Plus an unfiltered page, for scale.
 *   2. That company's record, raw: how addresses and country come back,
 *      and which fields are numbers.
 *   3. A contact ACT! has LINKED to that company: its `company`,
 *      `companyID`, and its associated-companies -- what a link looks like.
 *
 * WRITE PART (--write <quote number or document id>), for the quote's
 * company and contact. Writes to ACT! exactly what the feature would:
 *   4. Looks the company up by name. If ACT! has none, POSTs it with the
 *      PathQuote main address as `address` and the delivery address as
 *      `shippingAddress`, then reads it back.
 *   5. If the quote's ACT! contact has no associated company, PUTs the
 *      association (contacts/{id}/associated-companies/{companyId}) -- how
 *      ACT!'s own linked contacts hold their company -- and reads it back.
 *   6. If the quote has an ACT! opportunity, PUTs the company association on
 *      it and reads its associated companies back.
 * Nothing is stored in PathQuote: the feature, once built, finds the company
 * through the contact's link. Nothing is deleted.
 *
 * Run on the VPS (the ACT! API only answers that address). Environment:
 * ACT_BASE, ACT_DB, ACT_USER, ACT_PASS, DATABASE_URL.
 */
import "dotenv/config";
import { COUNTRIES_PICKLIST_ID, actClientFromEnv } from "../src/lib/act/client";
import { actCountryValue } from "../src/lib/act/country-picklist";
import { npmSwallowedFlag } from "../src/lib/npm-swallowed-flags";

const BASE = (process.env.ACT_BASE ?? "").replace(/\/$/, "");
const DATABASE = process.env.ACT_DB ?? "";
let token = "";

async function login(): Promise<void> {
  const basic = Buffer.from(`${process.env.ACT_USER}:${process.env.ACT_PASS}`).toString("base64");
  const res = await fetch(`${BASE}/authorize`, {
    headers: { Authorization: `Basic ${basic}`, "Act-Database-Name": DATABASE },
    redirect: "manual",
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`authorize ${res.status}: ${body.slice(0, 300)}`);
  token = body.replace(/^"|"$/g, "");
}

type Answer = { status: number; json: unknown; text: string };

async function call(method: string, path: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Act-Database-Name": DATABASE,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  console.log(`  ${method} ${path} -> ${res.status}`);
  return { status: res.status, json, text };
}

function rows(answer: Answer): Record<string, unknown>[] {
  const j = answer.json as unknown;
  if (Array.isArray(j)) return j as Record<string, unknown>[];
  if (j && typeof j === "object" && Array.isArray((j as { value?: unknown }).value)) {
    return (j as { value: Record<string, unknown>[] }).value;
  }
  return [];
}

function filterQuery(name: string, top = 50): string {
  const q = new URLSearchParams({ $filter: `name eq '${name.replace(/'/g, "''")}'`, $top: String(top) });
  return q.toString();
}

function brief(company: Record<string, unknown>): string {
  const address = company.address as Record<string, unknown> | null | undefined;
  return `${company.id}  "${company.name}"  ${address?.city ?? "-"} / ${address?.country ?? "-"}`;
}

function print(label: string, value: unknown): void {
  console.log(`  ${label}: ${JSON.stringify(value)}`);
}

function typesOf(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

async function readOnly(db: typeof import("../src/lib/db").db): Promise<void> {
  const known = await db.company.findFirst({
    where: { actCompanyId: { not: null }, contacts: { some: { actContactId: { not: null } } } },
    include: { contacts: { where: { actContactId: { not: null } }, take: 1 } },
  });
  if (!known?.actCompanyId) {
    console.log("No PathQuote company with an ACT! company id and an ACT! contact: read-only part skipped.");
    return;
  }

  console.log(`\n1. The name filter, on "${known.name}" (ACT! id ${known.actCompanyId})`);
  const record = await call("GET", `/api/companies/${known.actCompanyId}`);
  const company = (record.json ?? {}) as Record<string, unknown>;
  const actName = typeof company.name === "string" ? company.name : known.name;
  const exact = rows(await call("GET", `/api/companies?${filterQuery(actName)}`));
  console.log(`  exact name: ${exact.length} row(s); includes the known id: ${exact.some((r) => r.id === known.actCompanyId)}`);
  for (const r of exact.slice(0, 5)) console.log(`    ${brief(r)}`);
  const upper = rows(await call("GET", `/api/companies?${filterQuery(actName.toUpperCase())}`));
  console.log(`  UPPER CASE: ${upper.length} row(s) -> case-insensitive: ${upper.length === exact.length && exact.length > 0}`);
  const nonsense = rows(await call("GET", `/api/companies?${filterQuery("zz PathQuote probe no such company zz")}`));
  console.log(`  nonsense name: ${nonsense.length} row(s) (0 = filter honoured)`);
  const page = rows(await call("GET", `/api/companies?$top=5`));
  console.log(`  unfiltered $top=5: ${page.length} row(s)`);
  // PathQuote's name is often not ACT!'s exactly ("Flynt Amtex Inc" vs "Flynt Amtex Inc."):
  // can a lookup be wider than eq?
  const words = actName.split(/\s+/).filter(Boolean);
  const prefix = words.slice(0, Math.min(2, words.length)).join(" ");
  for (const expr of [`startswith(name,'${prefix.replace(/'/g, "''")}')`, `contains(name,'${(words[1] ?? words[0]).replace(/'/g, "''")}')`]) {
    const q = new URLSearchParams({ $filter: expr, $top: "50" });
    const got = await call("GET", `/api/companies?${q.toString()}`);
    const list = rows(got);
    console.log(`  ${expr}: ${got.status === 200 ? `${list.length} row(s); includes the known id: ${list.some((r) => r.id === known.actCompanyId)}` : got.text.slice(0, 200)}`);
    for (const r of list.slice(0, 5)) console.log(`    ${brief(r)}`);
  }

  console.log("\n2. The company record, raw");
  print("address", company.address);
  print("shippingAddress", company.shippingAddress);
  print("billingAddress", company.billingAddress);
  print("recordManagerID", company.recordManagerID);
  console.log(`  number-valued fields: ${typesOf(company) || "(none)"}`);
  console.log(`  every field: ${Object.keys(company).sort().join(", ")}`);

  const contactId = known.contacts[0]?.actContactId;
  if (contactId) {
    console.log(`\n3. A contact of that company (${contactId})`);
    const contact = ((await call("GET", `/api/contacts/${contactId}`)).json ?? {}) as Record<string, unknown>;
    print("company", contact.company);
    print("companyID", contact.companyID);
    print("companies", contact.companies);
    const assoc = await call("GET", `/api/contacts/${contactId}/associated-companies`);
    console.log(`  associated-companies: ${rows(assoc).map(brief).join(" | ") || assoc.text.slice(0, 200)}`);
  }
}

async function write(db: typeof import("../src/lib/db").db, key: string): Promise<void> {
  const doc = await db.document.findFirst({
    where: { OR: [{ id: key }, { number: key }] },
    include: { company: true, contact: true },
  });
  if (!doc?.company) throw new Error(`no quote ${key}, or it has no company`);
  const pq = doc.company;
  const items = await actClientFromEnv().picklistItems(COUNTRIES_PICKLIST_ID);
  const address = (street: string | null, city: string | null, state: string | null, postcode: string | null, country: string | null) => {
    const lines = (street ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const actCountry = actCountryValue(country, items);
    return {
      ...(lines[0] ? { line1: lines[0] } : {}),
      ...(lines[1] ? { line2: lines[1] } : {}),
      ...(lines.length > 2 ? { line3: lines.slice(2).join(", ") } : {}),
      ...(city ? { city } : {}),
      ...(state ? { state } : {}),
      ...(postcode ? { postalCode: postcode } : {}),
      ...(actCountry ? { country: actCountry } : {}),
    };
  };
  const business = address(pq.street, pq.city, pq.state, pq.postcode, pq.country);
  const shipping = pq.deliverySameAsMain
    ? business
    : address(pq.deliveryStreet, pq.deliveryCity, pq.deliveryState, pq.deliveryPostcode, pq.deliveryCountry);

  console.log(`\n4. Company "${pq.name}"`);
  print("PathQuote business ->", business);
  print("PathQuote shipping ->", shipping);
  const found = rows(await call("GET", `/api/companies?${filterQuery(pq.name)}`));
  console.log(`  found by name: ${found.length}`);
  for (const r of found) console.log(`    ${brief(r)}`);
  let companyId: string;
  if (found.length === 0) {
    const created = await call("POST", "/api/companies", { name: pq.name, address: business, shippingAddress: shipping });
    console.log(`  POST answered: ${created.text.slice(0, 400)}`);
    const id = (created.json as { id?: unknown } | null)?.id;
    if (typeof id !== "string") throw new Error("the create did not answer an id; stopping");
    companyId = id;
  } else if (found.length === 1) {
    companyId = String(found[0].id);
    console.log("  one found: using it, not creating");
  } else {
    throw new Error("several found: stopping, nothing written");
  }
  const back = ((await call("GET", `/api/companies/${companyId}`)).json ?? {}) as Record<string, unknown>;
  print("read back address", back.address);
  print("read back shippingAddress", back.shippingAddress);

  const contactId = doc.contact?.actContactId;
  if (contactId) {
    console.log(`\n5. Contact ${contactId}`);
    const before = ((await call("GET", `/api/contacts/${contactId}`)).json ?? {}) as Record<string, unknown>;
    print("before company / companyID", [before.company, before.companyID]);
    // ACT!'s imported contacts show their company as an ASSOCIATION, with
    // companyID empty (read-only part, 2026-10-16), so that is what is written.
    const existing = rows(await call("GET", `/api/contacts/${contactId}/associated-companies`));
    console.log(`  associated before: ${existing.map(brief).join(" | ") || "(none)"}`);
    if (existing.length > 0) {
      console.log("  already associated with a company: left alone");
    } else {
      const put = await call("PUT", `/api/contacts/${contactId}/associated-companies/${companyId}`);
      if (put.status >= 300) console.log(`  PUT answered: ${put.text.slice(0, 400)}`);
      const after = ((await call("GET", `/api/contacts/${contactId}`)).json ?? {}) as Record<string, unknown>;
      print("after company / companyID", [after.company, after.companyID]);
      const assoc = rows(await call("GET", `/api/contacts/${contactId}/associated-companies`));
      console.log(`  associated after: ${assoc.map(brief).join(" | ") || "(none)"}`);
    }
  }

  if (doc.actOpportunityId) {
    console.log(`\n6. Opportunity ${doc.actOpportunityId}`);
    const put = await call("PUT", `/api/opportunities/${doc.actOpportunityId}/associated-companies/${companyId}`);
    if (put.status >= 300) console.log(`  PUT answered: ${put.text.slice(0, 400)}`);
    const assoc = await call("GET", `/api/opportunities/${doc.actOpportunityId}/associated-companies`);
    console.log(`  associated-companies: ${rows(assoc).map(brief).join(" | ") || assoc.text.slice(0, 200)}`);
  }
}

async function main(): Promise<number> {
  if (npmSwallowedFlag(process.env, "--write")) {
    console.error("npm kept --write: run it as npm run act:company-probe -- --write <quote>");
    return 2;
  }
  const args = process.argv.slice(2);
  const writeAt = args.indexOf("--write");
  const target = writeAt >= 0 ? args[writeAt + 1] : undefined;
  if (writeAt >= 0 && !target) {
    console.error("usage: npm run act:company-probe -- --write <quote number or document id>");
    return 2;
  }
  const { db } = await import("../src/lib/db");
  try {
    await login();
    await readOnly(db);
    if (target) await write(db, target);
    return 0;
  } finally {
    await db.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
