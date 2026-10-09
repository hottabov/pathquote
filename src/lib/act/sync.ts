import { Prisma, type PrismaClient, type Company } from "@prisma/client";
import { createPrismaClient, db } from "@/lib/db";
import { ActClient } from "@/lib/act/client";
import { chooseCompany } from "@/lib/act/company-identity";
import { buildIndustryLookup } from "@/lib/act/industries";
import { formatGenericChannel, mapContact } from "@/lib/act/map";
import { fillOnlyEmpty } from "@/lib/act/merge";
import type { GenericChannel, MappedCompany, SkipReason } from "@/lib/act/types";

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

// An advisory lock rather than a `locked` column, because the lock belongs to
// the database session and Postgres drops it when the session ends. A run that
// is killed or crashes closes its socket on the way out, and the lock goes with
// it; a column set to true stays set, and wedges every later run until a person
// clears it by hand.
//
// The case that is not instant is a host that vanishes without closing the
// socket -- a yanked cable, a box hard-powered-off. It sends no FIN, so
// Postgres keeps the session, and the lock, until it notices the socket is
// dead. What decides when is the server's own `tcp_keepalives_idle`, nothing
// this code can set, and the default is two hours. So: still a window, but one
// that closes by itself rather than waiting for a person to find it.
//
// The number is arbitrary and only has to stay fixed. It is a bare key in a
// namespace shared with the whole database, carrying nothing that says what it
// is for, and this line is the only record of it -- so a second feature wanting
// a lock picks a different number and writes it down next to this one.
const SYNC_LOCK_KEY = 8_472_001;

/** Thrown when another sync holds the lock. Not a failure of this run: the
 * work is already being done by somebody else. */
export class SyncAlreadyRunningError extends Error {
  constructor() {
    super("A sync is already running. Wait for it to finish and try again.");
    this.name = "SyncAlreadyRunningError";
  }
}

export type SyncResult = {
  scanned: number;
  contactsCreated: number;
  contactsUpdated: number;
  companiesCreated: number;
  /**
   * Nameless ACT! contacts whose company was imported (or refreshed) with no
   * contact attached. Counts records, not distinct companies: two nameless
   * contacts at one firm count twice. A dry run counts every one whose company
   * is usable, since it cannot tell a new company from a known one.
   */
  companiesFromNamelessContacts: number;
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
  /**
   * Raw industry values the alias table has no entry for, deduplicated. A value
   * the table maps to null on purpose (not an industry) is not listed.
   */
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
  // A company needs a name as well as an identity. A contact linked to an ACT!
  // company but carrying blank company text has an identity and no name, and
  // creating a company called "" would put an unnamed row in the client
  // picker. The real name is on ACT!'s own Company record, which phase 1 does
  // not fetch, so the contact stays in ACT! where someone can see it.
  if (!company.name) return null;

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

/**
 * Record a nameless contact's generic mailbox and phone on its company's notes.
 *
 * Fill-only-empty like everything else the sync writes: a note a person wrote is
 * never replaced, and once the sync has written one it is not rewritten when
 * ACT! changes. Runs for a company that was just created and for one that was
 * already there alike -- it reads the notes back rather than assuming blank.
 */
async function recordGenericChannel(companyId: string, channel: GenericChannel): Promise<void> {
  const line = formatGenericChannel(channel);
  if (!line) return;

  const current = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { notes: true },
  });
  const patch = fillOnlyEmpty(current, { notes: line }, ["notes"]);
  if (patch.notes === undefined) return;
  await db.company.update({ where: { id: companyId }, data: patch });
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

/**
 * Open a connection of the sync's own, for the advisory lock to sit on.
 *
 * A session advisory lock belongs to the connection that took it, and `db` is a
 * pool: outside a transaction every query takes whichever connection is free
 * and hands it back at once, so the lock would end up on a connection that
 * later queries reuse and that `pg-pool` reaps after it has sat idle for ten
 * seconds -- dropping the lock part way through a ten-minute run. Nothing here
 * issues an unlock: release is the session ending, which is why the session has
 * to be one this run owns.
 *
 * So: the app's own client, a pool of one, idle reaping off. That keeps one
 * connection for the run in the ordinary case, not by guarantee -- a Postgres
 * restart or a dropped connection ends the session, and the lock with it, after
 * which `pg-pool` opens a replacement and the rest of the run is unlocked. The
 * adapter attaches its own `error` listener to the pool it creates
 * (@prisma/adapter-pg 7.10.0, `dist/index.js` line 817), so a connection dying
 * under us is reported rather than left as an unhandled `error` event, which on
 * a pg pool would end the process. Losing the lock mid-run means two runs can
 * overlap, which is the situation that existed before this lock and which the
 * unique indexes on `Contact.actContactId` and `Company.actCompanyKey` already
 * survive. This lock is here to stop two runs wasting ten minutes each, not to
 * be airtight.
 *
 * Wrapping the run in `db.$transaction` would pin a connection too, but it
 * would make the whole sync one transaction, and the per-page cursor
 * checkpoints would stop being durable until it committed -- which is the
 * resume-after-interruption property described at the top of this file.
 */
function openLockConnection(): PrismaClient {
  // This connection has to reach Postgres directly. A *session* advisory lock
  // means nothing through a transaction-mode pooler (PgBouncer and the like):
  // the lock would stick to a server backend that goes back into the pooler's
  // pool still holding it, with nothing left that can release it. There is no
  // pooler in front of this database, and putting one there would break this.
  return createPrismaClient({
    // One connection beyond the main pool's 10, per process that syncs, and a
    // caller that loses the race still opens one and closes it again. Worst
    // case here: the nightly job's 10 + 1, the web server's 10, and a button
    // click plus a second impatient click = 2, so 23 against the server's
    // default `max_connections` of 100. 77 spare.
    max: 1,
    // Never reap this connection while it is idle: holding the session open is
    // the whole point, and the run is mostly waiting on ACT! rather than
    // querying.
    idleTimeoutMillis: 0,
    // Guards the opposite direction to the note at SYNC_LOCK_KEY: node-postgres
    // leaves TCP keepalive off, so if the database host or the network goes away
    // mid-run, this socket waits on an answer that is never coming. With
    // keepalive the kernel probes, the connection fails, and the adapter's pool
    // listener reports it rather than the run hanging. It does nothing for a
    // vanished *app* host -- that takes its probes with it, and only the
    // server's keepalive settings end the session still holding the lock.
    keepAlive: true,
  });
}

export async function syncContacts(
  client: ActClient,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const lock = openLockConnection();
  try {
    // pg_try_advisory_lock, not pg_advisory_lock: the blocking form would queue
    // the Sync now button behind a ten-minute import and leave the admin
    // watching a spinner with nothing to read. Failing at once lets the caller
    // say that somebody else is already syncing.
    //
    // Taken before the `dryRun` branch on purpose. A dry run during a live sync
    // would be counting a database that is being rewritten underneath it, so
    // its report -- the whole output of a dry run -- would be fiction.
    const [{ locked }] = await lock.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${SYNC_LOCK_KEY}) AS locked
    `;
    if (!locked) {
      throw new SyncAlreadyRunningError();
    }

    const { resolve: resolveIndustry, isKnown: isKnownIndustry } = buildIndustryLookup();
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
      companiesFromNamelessContacts: 0,
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
    //
    // A limited run never checkpoints either. `--limit` reads the oldest records
    // first, so the newest `edited` it sees is older than a stored cursor, and
    // saving it would rewind the cursor and make the next delta run re-read
    // everything in between. A limited run is a sample, not a sync.
    async function checkpoint(): Promise<void> {
      if (options.dryRun || options.limit || result.failed > 0 || !newestEdited) return;
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
        // Only a spelling the table has no opinion on is a gap. One it maps to
        // null ("NIL", "Poor info") is a decision already made, and reporting it
        // would teach the reader to ignore the list.
        if (
          typeof rawIndustry === "string" &&
          rawIndustry.trim() &&
          !isKnownIndustry(rawIndustry)
        ) {
          unknownIndustries.add(rawIndustry.trim());
        }
        // Counts contacts imported; a company-only record imports none.
        if (mapped.kind === "mapped" && !mapped.contact.phone) result.unresolvedPhones += 1;

        // A company-only record has no contact to carry the timestamp, but it is
        // stored all the same, so it moves the cursor like any other.
        const editedAt =
          mapped.kind === "mapped" ? mapped.contact.actEditedAt : new Date(raw.edited);
        if (!newestEdited || editedAt > newestEdited) {
          newestEdited = editedAt;
        }

        // PathQuote's Contact requires a company, and creating one needs both a
        // name and an identity to group on. Decided from the mapped value with no
        // lookups, so a dry run can report it.
        const companyUsable =
          Boolean(mapped.company.name) && chooseCompany(mapped.company, null, null).kind !== "skip";

        if (options.dryRun) {
          // A dry run cannot know whether a contact already exists, so it counts
          // what a first import would skip -- which is the number worth comparing
          // against the measured export. A real incremental run counts only
          // genuinely new contacts here, because an existing one keeps the
          // company it already has and is refreshed either way.
          if (!companyUsable) result.skipped["no-company"] += 1;
          else if (mapped.kind === "company-only") result.companiesFromNamelessContacts += 1;
          continue;
        }

        try {
          const industryId = mapped.company.industry
            ? industryIdByName.get(mapped.company.industry) ?? null
            : null;

          if (mapped.kind === "company-only") {
            // No person to create: the company goes through the same identity
            // decision a named contact's would, and the generic mailbox and phone
            // are kept on it.
            if (!companyUsable) {
              result.skipped["no-company"] += 1;
              continue;
            }
            const companyId = await resolveCompany(mapped.company, industryId, result);
            if (!companyId) {
              result.skipped["no-company"] += 1;
              continue;
            }
            await recordGenericChannel(companyId, mapped.channel);
            result.companiesFromNamelessContacts += 1;
            continue;
          }

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
            if (!companyUsable) {
              result.skipped["no-company"] += 1;
              continue;
            }
            const companyId = await resolveCompany(mapped.company, industryId, result);
            if (!companyId) {
              // Belt and braces: companyUsable asks chooseCompany the same
              // question, so this should not fire. Kept so the two can never
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
            result.firstFailureActContactId = raw.id;
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
  } finally {
    // Closing the connection ends the session, and Postgres releases the
    // session's advisory locks with it. Deliberately the only release path, so
    // the mechanism every normal run exercises is the one a `kill -9` depends
    // on, rather than a second mechanism that has to be kept working. The cost
    // of that choice: if this disconnect fails there is nothing else to release
    // the lock, and it is held until this connection dies by other means.
    //
    // Swallowed either way. A run that got through 12,000 contacts has to
    // report what it did, and a run that threw has to report why -- neither is
    // improved by being replaced with how the cleanup went.
    await lock.$disconnect().catch((error: unknown) => {
      console.error("act: sync lock not released; held until this connection dies", error);
    });
  }
}
