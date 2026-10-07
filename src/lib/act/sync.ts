import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ActClient } from "@/lib/act/client";
import { buildIndustryResolver } from "@/lib/act/industries";
import { mapContact } from "@/lib/act/map";
import { fillOnlyEmpty } from "@/lib/act/merge";
import type { MappedCompany, SkipReason } from "@/lib/act/types";

// Pull contacts from ACT! into PathQuote.
//
// One operation serves both callers: the nightly job and the "Sync now"
// button. Both pass the cursor, so there is no separate full-import path to
// drift out of step with the incremental one.
//
// The cursor is the `edited` timestamp of the newest record successfully
// stored, kept in Setting. It only advances at the end of a clean run: a run
// that dies halfway leaves it alone and the next one re-reads the overlap,
// which fill-only-empty makes harmless.

const CURSOR_KEY = "act.sync.cursor";

export type SyncResult = {
  scanned: number;
  contactsCreated: number;
  contactsUpdated: number;
  companiesCreated: number;
  skipped: Record<SkipReason, number>;
  /** Contacts imported with no usable phone number. */
  unresolvedPhones: number;
  /** Raw industry values with no entry in the alias table, deduplicated. */
  unknownIndustries: string[];
  cursorFrom: Date | null;
  cursorTo: Date | null;
};

function emptySkips(): Record<SkipReason, number> {
  return {
    "not-a-contact": 0,
    private: 0,
    personal: 0,
    "inactive-status": 0,
    "no-name": 0,
    "no-company": 0,
  };
}

export async function readCursor(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: CURSOR_KEY } });
  const value = row?.value as { editedAt?: string } | null;
  return value?.editedAt ? new Date(value.editedAt) : null;
}

async function writeCursor(editedAt: Date): Promise<void> {
  await db.setting.upsert({
    where: { key: CURSOR_KEY },
    create: { key: CURSOR_KEY, value: { editedAt: editedAt.toISOString() } },
    update: { value: { editedAt: editedAt.toISOString() } },
  });
}

/**
 * Store the ACT! payload behind a row.
 *
 * It lives in its own table rather than as a column so that a query wanting a
 * company name never drags a full ACT! payload with it -- see the ActSnapshot
 * model's comment. Nothing in phase 1 reads it back.
 */
async function writeSnapshot(
  owner: { contactId: string } | { companyId: string },
  payload: unknown,
): Promise<void> {
  // Prisma's Json input is InputJsonValue, not object.
  const data = payload as Prisma.InputJsonValue;
  await db.actSnapshot.upsert({
    where: owner,
    create: { ...owner, payload: data },
    update: { payload: data },
  });
}

/**
 * Find or create the PathQuote company for a mapped contact.
 *
 * A contact linked to a real ACT! Company wins on `actCompanyId`; everyone
 * else groups on the derived name+country key. Both are unique columns, so two
 * contacts of the same client converge on one row rather than racing into two.
 */
async function resolveCompany(
  company: MappedCompany,
  industryId: string | null,
  counters: { companiesCreated: number },
): Promise<string | null> {
  if (!company.name) return null;

  const existing = company.actCompanyId
    ? await db.company.findUnique({ where: { actCompanyId: company.actCompanyId } })
    : company.actCompanyKey
      ? await db.company.findUnique({ where: { actCompanyKey: company.actCompanyKey } })
      : null;

  if (!existing) {
    const created = await db.company.create({
      data: {
        name: company.name,
        street: company.street,
        city: company.city,
        state: company.state,
        postcode: company.postcode,
        country: company.country,
        website: company.website,
        industryId,
        actCompanyId: company.actCompanyId,
        actCompanyKey: company.actCompanyKey,
        actStatus: company.actStatus,
        actRecordManagerId: company.actRecordManagerId,
        actSyncedAt: new Date(),
      },
    });
    await writeSnapshot({ companyId: created.id }, company);
    counters.companiesCreated += 1;
    return created.id;
  }

  const patch = fillOnlyEmpty(
    existing,
    {
      street: company.street,
      city: company.city,
      state: company.state,
      postcode: company.postcode,
      country: company.country,
      website: company.website,
      industryId,
    },
    ["street", "city", "state", "postcode", "country", "website", "industryId"],
  );

  await db.company.update({
    where: { id: existing.id },
    data: {
      ...patch,
      actStatus: company.actStatus,
      actRecordManagerId: company.actRecordManagerId,
      actSyncedAt: new Date(),
    },
  });
  await writeSnapshot({ companyId: existing.id }, company);
  return existing.id;
}

export type SyncOptions = {
  /** Ignore the stored cursor and read everything. */
  full?: boolean;
  /** Read and map, write nothing. */
  dryRun?: boolean;
  /** Stop after this many contacts. For a first careful run. */
  limit?: number;
  onProgress?: (scanned: number) => void;
};

export async function syncContacts(
  client: ActClient,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const resolveIndustry = buildIndustryResolver();
  const since = options.full ? null : await readCursor();

  // Industry is a small fixed table, so read it once rather than asking per
  // contact -- 12,000 lookups to answer at most 31 distinct questions.
  const industryIdByName = new Map(
    (await db.industry.findMany({ select: { id: true, name: true } })).map((row) => [
      row.name,
      row.id,
    ]),
  );

  const result: SyncResult = {
    scanned: 0,
    contactsCreated: 0,
    contactsUpdated: 0,
    companiesCreated: 0,
    skipped: emptySkips(),
    unresolvedPhones: 0,
    unknownIndustries: [],
    cursorFrom: since,
    cursorTo: null,
  };
  const unknownIndustries = new Set<string>();
  let newestEdited: Date | null = null;

  for await (const page of client.contactsEditedSince(since)) {
    for (const raw of page) {
      if (options.limit && result.scanned >= options.limit) break;
      result.scanned += 1;

      const mapped = mapContact(raw, resolveIndustry);
      if (mapped.kind === "skipped") {
        result.skipped[mapped.reason] += 1;
        continue;
      }

      const rawIndustry = raw.customFields?.user6;
      if (typeof rawIndustry === "string" && rawIndustry.trim() && !mapped.company.industry) {
        unknownIndustries.add(rawIndustry.trim());
      }
      if (!mapped.contact.phone) result.unresolvedPhones += 1;

      if (!newestEdited || mapped.contact.actEditedAt > newestEdited) {
        newestEdited = mapped.contact.actEditedAt;
      }

      // PathQuote's Contact requires a company, and a contact with no company
      // name is six records out of 12,094. Decided from the mapped value rather
      // than from resolveCompany returning null, so a dry run reports the same
      // count a real run does.
      if (!mapped.company.name) {
        result.skipped["no-company"] += 1;
        continue;
      }

      if (options.dryRun) continue;

      const industryId = mapped.company.industry
        ? industryIdByName.get(mapped.company.industry) ?? null
        : null;
      const companyId = await resolveCompany(mapped.company, industryId, result);
      if (!companyId) {
        // Unreachable today: the only null resolveCompany returns is for a
        // missing name, refused above. Kept so that giving resolveCompany a
        // second reason to decline cannot silently drop a contact instead.
        result.skipped["no-company"] += 1;
        continue;
      }

      const existing = await db.contact.findUnique({
        where: { actContactId: mapped.contact.actContactId },
      });

      if (!existing) {
        const created = await db.contact.create({
          data: {
            companyId,
            firstName: mapped.contact.firstName,
            lastName: mapped.contact.lastName,
            email: mapped.contact.email,
            phone: mapped.contact.phone,
            position: mapped.contact.position,
            actContactId: mapped.contact.actContactId,
            actAccountMgr: mapped.contact.actAccountMgr,
            actSyncState: "SYNCED",
            actSourceEditedAt: mapped.contact.actEditedAt,
            actSyncedAt: new Date(),
          },
        });
        await writeSnapshot({ contactId: created.id }, mapped.contact.snapshot);
        result.contactsCreated += 1;
      } else {
        const patch = fillOnlyEmpty(
          existing,
          {
            lastName: mapped.contact.lastName,
            email: mapped.contact.email,
            phone: mapped.contact.phone,
            position: mapped.contact.position,
          },
          ["lastName", "email", "phone", "position"],
        );
        await db.contact.update({
          where: { id: existing.id },
          data: {
            ...patch,
            actAccountMgr: mapped.contact.actAccountMgr,
            actSyncState: "SYNCED",
            actSourceEditedAt: mapped.contact.actEditedAt,
            actSyncedAt: new Date(),
          },
        });
        await writeSnapshot({ contactId: existing.id }, mapped.contact.snapshot);
        result.contactsUpdated += 1;
      }

      options.onProgress?.(result.scanned);
    }
    if (options.limit && result.scanned >= options.limit) break;
  }

  result.unknownIndustries = [...unknownIndustries].sort();
  result.cursorTo = newestEdited;

  // Only after everything above succeeded. A half-finished run leaves the
  // cursor where it was and the next run re-reads the overlap, which
  // fill-only-empty makes a no-op.
  if (!options.dryRun && newestEdited) {
    await writeCursor(newestEdited);
  }

  return result;
}
