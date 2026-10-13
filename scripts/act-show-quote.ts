/**
 * Show one quote as PathQuote holds it and as ACT! holds it, side by side.
 * Read-only: never writes to the database or to ACT!.
 *
 *   npm run act:show-quote -- <document id | quote number>
 *
 * For testing the write-back by hand (docs/runbook.md section 4d): what the
 * outbox row says, which ACT! ids the quote stored, and then -- read back from
 * ACT! itself -- the opportunity (stage, status, totals, close dates), every
 * product line on it, and the contact (company field, linked companies, ID/
 * Status, Acc Mgr). A field ACT! leaves at 0 or empty shows here exactly as
 * ACT! returned it, which is the point: the screen in ACT! can be stale, this
 * cannot.
 *
 * Run it on the VPS: the ACT! API only answers to that address.
 * Environment: ACT_BASE, ACT_DB, ACT_USER, ACT_PASS and DATABASE_URL.
 */
import "dotenv/config";
import { actClientFromEnv } from "../src/lib/act/client";

function show(label: string, value: unknown): void {
  const text = value === null || value === undefined || value === "" ? "-" : typeof value === "object" ? JSON.stringify(value) : String(value);
  console.log(`  ${label.padEnd(26)}${text}`);
}

function pick(record: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) show(key, record[key]);
}

async function main(): Promise<number> {
  const key = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  if (!key) {
    console.error("usage: npm run act:show-quote -- <document id | quote number>");
    return 2;
  }
  const { db } = await import("../src/lib/db");
  try {
    const doc = await db.document.findFirst({
      where: { OR: [{ id: key }, { number: key }] },
      include: { contact: true, company: true, region: true },
    });
    if (!doc) {
      console.error(`no quote with id or number ${key}`);
      return 1;
    }

    console.log(`PathQuote: ${doc.number ?? "(no number)"}  ${doc.id}`);
    show("status", doc.status);
    show("region", doc.region?.code);
    show("total / tax", `${doc.currency} ${doc.total} / ${doc.taxAmount} (ex tax ${Number(doc.total) - Number(doc.taxAmount)})`);
    show("signing / accepted", `${doc.signingStatus ?? "-"} / ${doc.acceptedAt?.toISOString() ?? "-"}`);
    show("company", `${doc.company?.name ?? "-"}  actCompanyId=${doc.company?.actCompanyId ?? "-"}`);
    show(
      "contact",
      doc.contact
        ? `${doc.contact.firstName} ${doc.contact.lastName ?? ""}  actContactId=${doc.contact.actContactId ?? "-"}`
        : "-",
    );
    show("actOpportunityId", doc.actOpportunityId);
    show("actProductLineId", doc.actProductLineId);
    show("actProductLineRevision", doc.actProductLineRevision);
    show("actOpportunityWonAt", doc.actOpportunityWonAt?.toISOString());
    show("actContactPromotedForId", doc.actContactPromotedForId);

    const rows = await db.actOutbox.findMany({ where: { documentId: doc.id }, orderBy: { createdAt: "asc" } });
    console.log(`\nOutbox rows: ${rows.length}`);
    for (const row of rows) {
      console.log(
        `  ${row.createdAt.toISOString()}  ${row.completedAt ? `done ${row.completedAt.toISOString()}` : "OPEN"}` +
          `  attempts=${row.attempts}  blockedBy=${row.blockedBy ?? "-"}`,
      );
      if (row.blockedReason) console.log(`    held: ${row.blockedReason}`);
      if (row.lastError) console.log(`    last error: ${row.lastError}`);
    }

    const act = actClientFromEnv();
    if (doc.actOpportunityId) {
      console.log("\nACT! opportunity");
      const opp = (await act.getOpportunity(doc.actOpportunityId)) as unknown as Record<string, unknown>;
      pick(opp, ["name", "status", "probability", "productTotal", "weightedTotal", "grossMargin", "openDate", "estimatedCloseDate", "actualCloseDate", "recordManagerID"]);
      const stage = opp.stage as Record<string, unknown> | undefined;
      show("stage", stage ? `${stage.name} (${stage.number}, ${stage.probability}%)` : "-");
      show("companies", (opp.companies as unknown[] | undefined)?.length ?? 0);
      const lines = (await act.listProductLines(doc.actOpportunityId)) as unknown as Record<string, unknown>[];
      console.log(`\nACT! product lines: ${lines.length}`);
      for (const line of lines) {
        pick(line, ["id", "name", "itemNumber", "quantity", "price", "discount", "discountPrice", "total"]);
        console.log("");
      }
    } else {
      console.log("\nACT! opportunity: none stored");
    }

    if (doc.contact?.actContactId) {
      console.log("ACT! contact");
      const contact = (await act.getContact(doc.contact.actContactId)) as unknown as Record<string, unknown>;
      pick(contact, ["fullName", "company", "companyID", "idStatus", "emailAddress", "recordManagerID"]);
      show("companies", contact.companies);
      show("customFields.rep", (contact.customFields as Record<string, unknown> | undefined)?.rep);
    }
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
