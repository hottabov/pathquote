/**
 * Fill the LOCAL dev database with realistic volume for performance testing.
 *
 * Deep-copies one existing FINAL quote (document + items + lines + the
 * revision-0 row, JSON snapshots and money columns verbatim) into N new
 * documents, 70% FINAL / 30% DRAFT, spread over the last 18 months and
 * round-robined across the active users of the template's region. Also
 * creates M companies ("PERF Company 0001" ...) with 1-4 contacts each and
 * attaches every copied document to one of them.
 *
 * Every row it creates is recognisable, so `--clean` can take them all out:
 *   Company.name      starts with "PERF "        (contacts cascade)
 *   Document.number   starts with "PERF-"        (FINAL copies)
 *   Document.notes    contains  "[PERF]"         (DRAFT copies have no number)
 * Items, lines and revisions cascade from their document.
 *
 * Idempotent: a second run tops up to the requested counts instead of
 * doubling them. The real NumberSequence table is never touched -- PERF
 * numbers carry their own prefix, so finalizing a real quote still yields
 * the next real `Q-AU-2026-NNN`.
 *
 * Usage:
 *   npx tsx docs/technical-audit/scripts/seed-volume.ts                       # 600 docs, 400 companies
 *   npx tsx docs/technical-audit/scripts/seed-volume.ts --documents 600 --companies 400
 *   npx tsx docs/technical-audit/scripts/seed-volume.ts --template <documentId>
 *   npx tsx docs/technical-audit/scripts/seed-volume.ts --clean               # remove every PERF row
 *
 * LOCAL ONLY. Refuses to run unless DATABASE_URL points at localhost
 * (same guard as scripts/purge-quotes.ts; production is live, docs/runbook.md).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../../../src/lib/db";

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

function assertLocalDatabase(): void {
  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    // Unparseable is not provably local.
  }
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(
      `Refusing to seed: DATABASE_URL host is "${host || "(unset)"}", not localhost/127.0.0.1.`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_TEMPLATE_ID = "cmunfdu710000hn9km8a0km55"; // Q-AU-2026-001
const COMPANY_PREFIX = "PERF ";
const NUMBER_PREFIX = "PERF-";
const NOTES_MARKER = "[PERF]";
const BATCH = 50;
const MONTHS_BACK = 18;

function intArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${flag} expects a non-negative integer, got "${process.argv[i + 1]}"`);
    process.exit(1);
  }
  return n;
}
function strArg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const CLEAN = process.argv.includes("--clean");
const WANT_DOCS = intArg("--documents", 600);
const WANT_COMPANIES = intArg("--companies", 400);
const TEMPLATE_ID = strArg("--template", DEFAULT_TEMPLATE_ID);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** cuid-shaped id (25 chars, "c" + base36 time + random). Uniqueness is all
 * the schema needs; the shape just keeps PERF ids visually like the rest. */
function cuid(): string {
  const t = Date.now().toString(36);
  const r = randomBytes(12).toString("hex");
  return ("c" + t + r).slice(0, 25);
}

/** Deterministic PRNG so two runs with the same counts produce the same
 * spread of dates/statuses (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261016);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

/** Prisma rejects a bare `null` for a Json column on write; DB NULL must be
 * spelled Prisma.DbNull. */
function json(v: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue);
}

const DAY = 24 * 60 * 60 * 1000;

const PLACES: ReadonlyArray<{ city: string; state: string | null; country: string }> = [
  { city: "Melbourne", state: "VIC", country: "AU" },
  { city: "Sydney", state: "NSW", country: "AU" },
  { city: "Brisbane", state: "QLD", country: "AU" },
  { city: "Perth", state: "WA", country: "AU" },
  { city: "Adelaide", state: "SA", country: "AU" },
  { city: "Auckland", state: null, country: "NZ" },
  { city: "Christchurch", state: null, country: "NZ" },
  { city: "Singapore", state: null, country: "SG" },
  { city: "Kuala Lumpur", state: null, country: "MY" },
  { city: "Jakarta", state: null, country: "ID" },
  { city: "Los Angeles", state: "CA", country: "US" },
  { city: "Dallas", state: "TX", country: "US" },
  { city: "Chicago", state: "IL", country: "US" },
  { city: "Toronto", state: "ON", country: "CA" },
  { city: "London", state: null, country: "GB" },
  { city: "Manchester", state: null, country: "GB" },
  { city: "Dublin", state: null, country: "IE" },
  { city: "Monterrey", state: "NL", country: "MX" },
  { city: "Mexico City", state: "CDMX", country: "MX" },
  { city: "Cape Town", state: null, country: "ZA" },
];
const FIRST = ["Alex", "Sam", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Jamie", "Dana", "Lee", "Priya", "Wei", "Carlos", "Fatima", "Noah", "Olivia", "Liam", "Emma", "Mateo", "Sofia"];
const LAST = ["Nguyen", "Smith", "Patel", "Garcia", "Jones", "Kim", "Brown", "Singh", "Martin", "Lopez", "Wilson", "Chen", "Taylor", "Anderson", "Thomas", "Moore", "Jackson", "White", "Harris", "Clark"];
const POSITIONS = ["Production Manager", "Owner", "Purchasing", "Operations Director", "Plant Manager", "CFO", "Engineering Lead", null];
const SUFFIX = ["Textiles", "Composites", "Marine", "Upholstery", "Industries", "Fabrication", "Interiors", "Manufacturing", "Sails", "Canvas"];

// ---------------------------------------------------------------------------
// --clean
// ---------------------------------------------------------------------------

const perfDocumentWhere: Prisma.DocumentWhereInput = {
  OR: [
    { number: { startsWith: NUMBER_PREFIX } },
    { notes: { contains: NOTES_MARKER } },
    { company: { name: { startsWith: COMPANY_PREFIX } } },
  ],
};
const perfCompanyWhere: Prisma.CompanyWhereInput = { name: { startsWith: COMPANY_PREFIX } };

async function clean() {
  // Documents first: Company -> Document is ON DELETE RESTRICT. Items, lines,
  // revisions cascade from Document; contacts cascade from Company.
  const docs = await db.document.deleteMany({ where: perfDocumentWhere });
  const companies = await db.company.deleteMany({ where: perfCompanyWhere });
  console.log(`Removed ${docs.count} PERF documents (items/lines/revisions cascaded)`);
  console.log(`Removed ${companies.count} PERF companies (contacts cascaded)`);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seedCompanies(ownerIds: string[]) {
  const existing = await db.company.count({ where: perfCompanyWhere });
  const toCreate = Math.max(0, WANT_COMPANIES - existing);
  if (toCreate === 0) {
    console.log(`Companies: ${existing} PERF companies already present, nothing to add`);
    return;
  }
  const industries = await db.industry.findMany({ select: { id: true } });
  const now = Date.now();

  const companies: Prisma.CompanyCreateManyInput[] = [];
  const contacts: Prisma.ContactCreateManyInput[] = [];
  for (let n = existing + 1; n <= existing + toCreate; n++) {
    const id = cuid();
    const place = pick(PLACES);
    const seq = String(n).padStart(4, "0");
    companies.push({
      id,
      name: `${COMPANY_PREFIX}Company ${seq} ${pick(SUFFIX)}`,
      street: `${randInt(1, 999)} ${pick(LAST)} Street`,
      city: place.city,
      state: place.state,
      postcode: String(randInt(1000, 99999)),
      country: place.country,
      website: `https://perf-${seq}.example.test`,
      ownerId: pick(ownerIds),
      industryId: industries.length ? pick(industries).id : null,
      createdAt: new Date(now - rand() * MONTHS_BACK * 30 * DAY),
    });
    const k = randInt(1, 4);
    for (let c = 0; c < k; c++) {
      const first = pick(FIRST);
      const last = pick(LAST);
      contacts.push({
        id: cuid(),
        companyId: id,
        firstName: first,
        lastName: last,
        email: `${first}.${last}.${c}@perf-${seq}.example.test`.toLowerCase(),
        phone: `+61 4${randInt(10, 99)} ${randInt(100, 999)} ${randInt(100, 999)}`,
        position: pick(POSITIONS),
        isPrimary: c === 0,
      });
    }
  }
  await db.$transaction([
    db.company.createMany({ data: companies }),
    db.contact.createMany({ data: contacts }),
  ]);
  console.log(`Companies: created ${companies.length} (+${contacts.length} contacts), total PERF ${existing + toCreate}`);
}

async function seedDocuments() {
  const template = await db.document.findUnique({
    where: { id: TEMPLATE_ID },
    include: {
      region: { select: { code: true } },
      items: { orderBy: { sortOrder: "asc" } },
      lines: { orderBy: { sortOrder: "asc" } },
      revisions: { where: { revision: 0 } },
    },
  });
  if (!template) {
    console.error(`Template document ${TEMPLATE_ID} not found (pass --template <id>)`);
    process.exit(1);
  }
  if (template.status !== "FINAL") {
    console.error(`Template ${TEMPLATE_ID} is ${template.status}; a FINAL quote is required`);
    process.exit(1);
  }
  const templateRevision = template.revisions[0] ?? null;

  // Authors: active users of the template's region, so Document.regionId ==
  // author.regionId holds for every copy (pricing region likewise, since the
  // money columns are the template's own).
  const users = await db.user.findMany({
    where: { active: true, regionId: template.regionId },
    select: { id: true },
    orderBy: { email: "asc" },
  });
  if (users.length === 0) {
    console.error(`No active users in region ${template.regionId}`);
    process.exit(1);
  }

  const companies = await db.company.findMany({
    where: perfCompanyWhere,
    select: { id: true, contacts: { select: { id: true, isPrimary: true } } },
  });
  if (companies.length === 0) {
    console.error("No PERF companies to attach documents to (run without --companies 0 first)");
    process.exit(1);
  }

  const existing = await db.document.count({ where: perfDocumentWhere });
  const toCreate = Math.max(0, WANT_DOCS - existing);
  if (toCreate === 0) {
    console.log(`Documents: ${existing} PERF documents already present, nothing to add`);
    return;
  }

  // Per-year counters continue from whatever PERF numbers already exist.
  const counters = new Map<number, number>();
  const numbered = await db.document.findMany({
    where: { number: { startsWith: NUMBER_PREFIX } },
    select: { number: true },
  });
  for (const { number } of numbered) {
    const m = /^PERF-Q-[A-Z]+-(\d{4})-(\d+)$/.exec(number ?? "");
    if (!m) continue;
    const y = Number(m[1]);
    counters.set(y, Math.max(counters.get(y) ?? 0, Number(m[2])));
  }
  const nextNumber = (year: number) => {
    const n = (counters.get(year) ?? 0) + 1;
    counters.set(year, n);
    return `${NUMBER_PREFIX}Q-${template.region.code}-${year}-${String(n).padStart(3, "0")}`;
  };

  const now = Date.now();
  let created = 0;
  let finals = 0;

  for (let start = 0; start < toCreate; start += BATCH) {
    const size = Math.min(BATCH, toCreate - start);
    const docs: Prisma.DocumentCreateManyInput[] = [];
    const items: Prisma.DocumentItemCreateManyInput[] = [];
    const lines: Prisma.DocumentLineCreateManyInput[] = [];
    const revisions: Prisma.QuoteRevisionCreateManyInput[] = [];

    for (let k = 0; k < size; k++) {
      const i = existing + start + k;
      const isFinal = i % 10 < 7; // exactly 70/30
      const author = users[i % users.length]!;
      const company = pick(companies);
      const contact = company.contacts.length ? pick(company.contacts) : null;

      const createdAt = new Date(now - rand() * MONTHS_BACK * 30 * DAY);
      const updatedAt = new Date(Math.min(now, createdAt.getTime() + rand() * 14 * DAY));
      const docId = cuid();

      let signingStatus: "NOT_SENT" | "SENT" | "VIEWED" = "NOT_SENT";
      if (isFinal) {
        const r = rand();
        signingStatus = r < 0.6 ? "NOT_SENT" : r < 0.85 ? "SENT" : "VIEWED";
      }
      const sent = signingStatus !== "NOT_SENT";

      docs.push({
        id: docId,
        status: isFinal ? "FINAL" : "DRAFT",
        number: isFinal ? nextNumber(updatedAt.getFullYear()) : null,
        companyId: company.id,
        contactId: contact?.id ?? null,
        authorId: author.id,
        regionId: template.regionId,
        issueDate: isFinal ? updatedAt : createdAt,
        validityDays: template.validityDays,
        currency: template.currency,
        currencySymbol: template.currencySymbol,
        taxName: template.taxName,
        taxRate: template.taxRate,
        incoterm: template.incoterm,
        taxTreatment: template.taxTreatment,
        taxOverridden: template.taxOverridden,
        taxNote: template.taxNote,
        entitySnapshot: isFinal ? json(template.entitySnapshot) : Prisma.DbNull,
        discountMode: template.discountMode,
        discountValue: template.discountValue,
        subtotal: template.subtotal,
        taxAmount: template.taxAmount,
        total: template.total,
        notes: `<p>${NOTES_MARKER} performance seed copy of ${template.number}</p>`,
        showItemPrices: template.showItemPrices,
        showOptionPrices: template.showOptionPrices,
        commissionAmount: isFinal ? template.commissionAmount : null,
        commissionRatePct: isFinal ? template.commissionRatePct : null,
        commissionBase: isFinal ? template.commissionBase : null,
        signingStatus,
        heroImageUrl: template.heroImageUrl,
        deliveryWeeks: template.deliveryWeeks,
        installationDays: template.installationDays,
        trainingDays: template.trainingDays,
        warrantyMonths: template.warrantyMonths,
        documentsSnapshot: isFinal ? json(template.documentsSnapshot) : Prisma.DbNull,
        revision: isFinal ? 0 : null,
        finalizedAt: isFinal ? updatedAt : null,
        finalizedById: isFinal ? author.id : null,
        sentAt: sent ? updatedAt : null,
        hasUnsentChanges: false,
        createdAt,
        updatedAt,
      });

      const itemIds = new Map<string, string>();
      for (const it of template.items) {
        const id = cuid();
        itemIds.set(it.id, id);
        items.push({
          id,
          documentId: docId,
          productId: it.productId,
          sortOrder: it.sortOrder,
          code: it.code,
          name: it.name,
          description: it.description,
          unitPrice: it.unitPrice,
          listPrice: it.listPrice,
          discountMode: it.discountMode,
          discountValue: it.discountValue,
          serialNumber: it.serialNumber,
          showImage: it.showImage,
          productionSpec: json(it.productionSpec),
          imageUrl: it.imageUrl,
        });
      }

      // Parents before children so the self-referential parentLineId FK can
      // never see a child first, whatever order the template rows came back.
      const lineIds = new Map<string, string>();
      for (const ln of template.lines) lineIds.set(ln.id, cuid());
      const ordered = [...template.lines].sort(
        (a, b) => Number(a.parentLineId !== null) - Number(b.parentLineId !== null)
      );
      for (const ln of ordered) {
        lines.push({
          id: lineIds.get(ln.id)!,
          documentId: docId,
          itemId: ln.itemId ? (itemIds.get(ln.itemId) ?? null) : null,
          kind: ln.kind,
          refId: ln.refId,
          code: ln.code,
          name: ln.name,
          description: ln.description,
          qty: ln.qty,
          unitPrice: ln.unitPrice,
          listPrice: ln.listPrice,
          attributes: json(ln.attributes),
          parentLineId: ln.parentLineId ? (lineIds.get(ln.parentLineId) ?? null) : null,
          showImage: ln.showImage,
          imageUrl: ln.imageUrl,
          sortOrder: ln.sortOrder,
        });
      }

      if (isFinal && templateRevision) {
        const number = docs[docs.length - 1]!.number!;
        revisions.push({
          id: cuid(),
          documentId: docId,
          revision: 0,
          label: number,
          // QuoteRevision.snapshot is a required Json column, so a null here
          // would have to be Prisma.JsonNull; the template is FINAL and always
          // carries one, hence the narrowing cast.
          snapshot: json(templateRevision.snapshot) as Prisma.InputJsonValue,
          snapshotHash: templateRevision.snapshotHash,
          pdfPath: null,
          signedPdfPath: null,
          total: templateRevision.total,
          createdAt: updatedAt,
          createdById: author.id,
        });
        finals++;
      } else if (isFinal) {
        finals++;
      }
    }

    await db.$transaction([
      db.document.createMany({ data: docs }),
      db.documentItem.createMany({ data: items }),
      db.documentLine.createMany({ data: lines }),
      db.quoteRevision.createMany({ data: revisions }),
    ]);
    created += docs.length;
    process.stdout.write(`  documents ${created}/${toCreate}\r`);
  }
  console.log(
    `\nDocuments: created ${created} (${finals} FINAL, ${created - finals} DRAFT) from template ${template.number}, total PERF ${existing + toCreate}`
  );
}

async function report() {
  const [byStatus, items, lines, revisions, companies, contacts] = await Promise.all([
    db.document.groupBy({ by: ["status"], where: perfDocumentWhere, _count: { _all: true } }),
    db.documentItem.count({ where: { document: perfDocumentWhere } }),
    db.documentLine.count({ where: { document: perfDocumentWhere } }),
    db.quoteRevision.count({ where: { document: perfDocumentWhere } }),
    db.company.count({ where: perfCompanyWhere }),
    db.contact.count({ where: { company: perfCompanyWhere } }),
  ]);
  console.log("\nPERF rows now in the database:");
  for (const row of byStatus) console.log(`  Document ${row.status.padEnd(6)} ${row._count._all}`);
  console.log(`  DocumentItem    ${items}`);
  console.log(`  DocumentLine    ${lines}`);
  console.log(`  QuoteRevision   ${revisions}`);
  console.log(`  Company         ${companies}`);
  console.log(`  Contact         ${contacts}`);
}

async function main() {
  assertLocalDatabase();
  if (CLEAN) {
    await clean();
    await report();
    return;
  }
  const owners = await db.user.findMany({ where: { active: true }, select: { id: true } });
  await seedCompanies(owners.map((u) => u.id));
  await seedDocuments();
  await report();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
