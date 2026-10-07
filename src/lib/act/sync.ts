import { Prisma, type Company } from "@prisma/client";
import { db } from "@/lib/db";
import { ActClient } from "@/lib/act/client";
import { chooseCompany } from "@/lib/act/company-identity";
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
// stored, kept in Setting. It is checkpointed after every fully processed page,
// so a run interrupted late resumes near where it stopped instead of from zero.
// Pages arrive oldest-first and the filter is `ge`, so the boundary record is
// simply re-read, which fill-only-empty makes harmless.
//
// It stops advancing the moment any contact fails. A failed record sits at or
// after the cursor in that same oldest-first order, so moving past it would
// skip it forever; holding the cursor makes the next run try it again.

const CURSOR_KEY = "act.sync.cursor";

export type SyncResult = {
  scanned: number;
  contactsCreated: number;
  contactsUpdated: number;
  companiesCreated: number;
  /**
   * Companies created with no actCompanyKey because another company already
   * holds it: two different ACT! companies whose names normalise to the same
   * key. Anything above zero means two firms may be sharing a name and a
   * person should look.
   */
  companiesKeyCollisions: number;
  skipped: Record<SkipReason, number>;
  /** Contacts imported with no usable phone number. */
  unresolvedPhones: number;
  /** Raw industry values with no entry in the alias table, deduplicated. */
  unknownIndustries: string[];
  /** Contacts whose database work threw. The run carries on past them. */
  failed: number;
  /** The first failure only: enough to start looking, without a flood. */
  firstFailureActContactId: string | null;
  firstFailureMessage: string | null;
  cursorFrom: Date | null;
  /**
   * Where the stored cursor stands after the run. Held back once `failed` is
   * above zero, so it can be older than the newest record read. For a dry run,
   * where it is not stored, it is where a real run would have moved it.
   */
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

/** The fields a sync may fill on a company that is already there. */
const COMPANY_FILL_FIELDS = [
  "street",
  "city",
  "state",
  "postcode",
  "country",
  "website",
  "industryId",
] as const;

/**
 * Refresh a company the sync already knows: fill blanks, never overwrite, then
 * update the ACT! bookkeeping and the snapshot. `actCompanyId` is set only when
 * the identity decision adopted the row.
 */
async function refreshCompany(
  existing: Company,
  company: MappedCompany,
  industryId: string | null,
  adoptActCompanyId?: string,
): Promise<void> {
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
    COMPANY_FILL_FIELDS,
  );

  await db.company.update({
    where: { id: existing.id },
    data: {
      ...patch,
      ...(adoptActCompanyId ? { actCompanyId: adoptActCompanyId } : {}),
      actStatus: company.actStatus,
      actRecordManagerId: company.actRecordManagerId,
      actSyncedAt: new Date(),
    },
  });
  await writeSnapshot({ companyId: existing.id }, company);
}

/**
 * Find or create the PathQuote company for a NEW contact. A contact that
 * already exists keeps the company it is on and never comes through here.
 *
 * Does the two lookups and acts on the answer; which company the contact
 * belongs to is decided by chooseCompany, not here. Returns null when nothing
 * identifies the company, and the caller counts the contact as `no-company`.
 */
async function resolveCompany(
  company: MappedCompany,
  industryId: string | null,
  counters: Pick<SyncResult, "companiesCreated" | "companiesKeyCollisions">,
): Promise<string | null> {
  const byId = company.actCompanyId
    ? await db.company.findUnique({ where: { actCompanyId: company.actCompanyId } })
    : null;
  const byKey = company.actCompanyKey
    ? await db.company.findUnique({ where: { actCompanyKey: company.actCompanyKey } })
    : null;

  const decision = chooseCompany(company, byId, byKey);

  switch (decision.kind) {
    case "skip":
      return null;

    case "use":
    case "adopt": {
      const existing = byId?.id === decision.id ? byId : byKey;
      if (!existing) throw new Error(`chooseCompany returned unknown company ${decision.id}`);
      await refreshCompany(
        existing,
        company,
        industryId,
        decision.kind === "adopt" ? decision.actCompanyId : undefined,
      );
      return existing.id;
    }

    case "create": {
      // The decision's identifiers, not the incoming ones: a key collision
      // deliberately drops the key.
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
          actCompanyId: decision.actCompanyId,
          actCompanyKey: decision.actCompanyKey,
          actStatus: company.actStatus,
          actRecordManagerId: company.actRecordManagerId,
          actSyncedAt: new Date(),
        },
      });
      await writeSnapshot({ companyId: created.id }, company);
      counters.companiesCreated += 1;
      if (company.actCompanyKey && !decision.actCompanyKey) counters.companiesKeyCollisions += 1;
      return created.id;
    }
  }
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
    companiesKeyCollisions: 0,
    skipped: emptySkips(),
    unresolvedPhones: 0,
    unknownIndustries: [],
    failed: 0,
    firstFailureActContactId: null,
    firstFailureMessage: null,
    cursorFrom: since,
    cursorTo: null,
  };
  const unknownIndustries = new Set<string>();
  let newestEdited: Date | null = null;
  let checkpointed: Date | null = null;

  // Called after each fully processed page. Never once a contact has failed:
  // see the note at the top of this file.
  async function checkpoint(): Promise<void> {
    if (options.dryRun || result.failed > 0 || !newestEdited) return;
    if (checkpointed && newestEdited <= checkpointed) return;
    await writeCursor(newestEdited);
    checkpointed = newestEdited;
  }

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

      // PathQuote's Contact requires a company, and a contact whose company
      // carries no identity at all has nothing to attach to. Decided from the
      // mapped value, with no lookups, so a dry run reports the same count a
      // real run does.
      if (chooseCompany(mapped.company, null, null).kind === "skip") {
        result.skipped["no-company"] += 1;
        continue;
      }

      if (options.dryRun) continue;

      try {
        const industryId = mapped.company.industry
          ? industryIdByName.get(mapped.company.industry) ?? null
          : null;

        const existing = await db.contact.findUnique({
          where: { actContactId: mapped.contact.actContactId },
        });

        if (existing) {
          // A contact already in PathQuote keeps the company it is on, even if
          // the ACT! text has since changed: resolving it again could create a
          // second company and leave it empty. Refresh the one it has.
          const current = await db.company.findUniqueOrThrow({
            where: { id: existing.companyId },
          });
          await refreshCompany(current, mapped.company, industryId);

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
        } else {
          const companyId = await resolveCompany(mapped.company, industryId, result);
          if (!companyId) {
            // Unreachable while the check above runs first, since both ask
            // chooseCompany the same question. Kept so that the two can never
            // drift apart into silently dropping a contact.
            result.skipped["no-company"] += 1;
            continue;
          }

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
        }
      } catch (error) {
        // One bad record must not end a 12,000-contact run, and must not be
        // lost either: it is counted, the first is reported, and `failed`
        // freezes the cursor so the next run reaches it again.
        result.failed += 1;
        if (result.firstFailureActContactId === null) {
          result.firstFailureActContactId = mapped.contact.actContactId;
          result.firstFailureMessage = error instanceof Error ? error.message : String(error);
        }
      }

      options.onProgress?.(result.scanned);
    }

    await checkpoint();
    if (options.limit && result.scanned >= options.limit) break;
  }

  result.unknownIndustries = [...unknownIndustries].sort();
  result.cursorTo = options.dryRun ? newestEdited : checkpointed;

  return result;
}
