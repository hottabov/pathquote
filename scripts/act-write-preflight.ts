/**
 * Check, before sending to ACT! is switched on, everything about the live
 * ACT! the write-back depends on and nobody has seen yet -- and list the
 * quotes switching it on would send.
 *
 *   npm run act:write-preflight
 *
 * On the VPS, from /opt/pathquote (the ACT! API answers no other address),
 * with TAG set as for every tools run (docs/runbook.md section 4c says why it
 * is not optional):
 *
 *   TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:write-preflight
 *
 * STRICTLY READ-ONLY, AGAINST BOTH. Against ACT! it holds an ActReader
 * (actReaderFromEnv in src/lib/act/client.ts), never an ActClient: an object
 * whose every function sends a GET -- the login too -- with no path from it to
 * any method that POSTs or PATCHes. Against PathQuote it reads inside one
 * transaction made READ ONLY before its first query, and refuses to go on if
 * Postgres does not say so. It takes no arguments.
 *
 * The checks, each PASS, WARN, FAIL or INFO with a line saying why and, for
 * WARN and FAIL, what to do -- the rules are in src/lib/act/write-preflight.ts:
 *
 *    1  the service account (ACT_USER) is found, Active, role Manager
 *    2  PathQuote users mapped to ACT! users
 *    3  every Account Mgr value is on the Rep picklist
 *    4  the Countries picklist covers the countries PathQuote's companies are in
 *    5  ACT! applies the opportunity lookup's name filter
 *    6  product lines carry itemNumber
 *    7  ACT! applies the History lookup's regarding filter
 *    8  the switch, and every quote switching it on would send
 *    9  the 15-minute drain's timer (INFO: look on the host)
 *   10  the stage ids, the opportunity name's length and the two picklist ids,
 *       transcribed by hand, against what ACT! says now
 *
 * Exit status: 0 nothing FAILed; 1 a check FAILed, or the run threw; 2 it
 * could not start -- an argument given, no identifiable DATABASE_URL, or an
 * ACT_* variable missing.
 *
 * Environment: ACT_BASE, ACT_DB, ACT_USER, ACT_PASS and DATABASE_URL, as for
 * act:sync (see its header).
 */
import "dotenv/config";
import { COUNTRIES_PICKLIST_ID, REP_PICKLIST_ID, actReaderFromEnv, historyRegardingFilter, lookupQuery, opportunityNameFilter, type ActReader } from "../src/lib/act/client";
import { describeDatabase } from "../src/lib/act/cli-args";
import { actWriteEnabled, ACT_WRITE_SWITCH_KEY } from "../src/lib/act/write-switch";
import {
  HISTORY_SAMPLE_SIZE,
  NONSENSE_NAME,
  NONSENSE_REGARDING,
  OPPORTUNITY_SAMPLE_SIZE,
  backlogCheck,
  countriesCheck,
  drainTimerCheck,
  formatPreflightReport,
  historyFilterCheck,
  historyProbeContacts,
  notAsked,
  opportunityFilterCheck,
  preflightExitStatus,
  productLinesCheck,
  productProbeCandidates,
  readFailure,
  repPicklistCheck,
  sampleOpportunity,
  serviceAccountCheck,
  transcribedCheck,
  usersMappedCheck,
  type BacklogRow,
  type Check,
  type CompanyCountry,
  type PathQuoteUser,
  type ProductProbe,
  type Read,
  type Row,
} from "../src/lib/act/write-preflight";
import { formatWritePreflightBanner, parseWritePreflightArgs } from "../src/lib/act/write-preflight-args";

/** One read of ACT!, its error kept rather than thrown: every check reports its own. */
async function read<T>(request: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await request() };
  } catch (error) {
    return { ok: false, failure: readFailure(error) };
  }
}

/** Everything read from PathQuote, in one READ ONLY transaction. */
type PathQuoteFacts = {
  users: PathQuoteUser[];
  countries: CompanyCountry[];
  sendingOn: boolean;
  backlog: BacklogRow[];
};

async function readPathQuote(): Promise<PathQuoteFacts> {
  // Imported here, not at module scope, for act-sync-preflight.ts's reason:
  // src/lib/db.ts throws on import without DATABASE_URL, and the checks above
  // must end in their own message and exit 2 first.
  const { db } = await import("../src/lib/db");
  try {
    return await db.$transaction(
      async (tx) => {
        // Before any other statement, which is the only place Postgres takes
        // it; and then asked back, so a transaction that is not read-only is
        // a refusal to go on rather than an assumption.
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const [mode] = await tx.$queryRaw<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
        if (mode?.transaction_read_only !== "on") {
          throw new Error(`the transaction is not read-only (transaction_read_only = ${mode?.transaction_read_only}); refusing to read PathQuote in it`);
        }

        const users = await tx.user.findMany({
          select: { email: true, role: true, active: true, actUserId: true, actAccountMgr: true },
          orderBy: { email: "asc" },
        });
        const countries = await tx.$queryRaw<CompanyCountry[]>`
          SELECT c.country,
                 COUNT(DISTINCT c.id)::int AS companies,
                 (COUNT(ct.id) FILTER (WHERE ct."actContactId" IS NULL))::int AS "contactsNotInAct"
          FROM "Company" c LEFT JOIN "Contact" ct ON ct."companyId" = c.id
          GROUP BY c.country`;
        const setting = await tx.setting.findUnique({ where: { key: ACT_WRITE_SWITCH_KEY } });
        const rows = await tx.actOutbox.findMany({
          where: { completedAt: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            documentId: true,
            createdAt: true,
            nextAttemptAt: true,
            attempts: true,
            blockedReason: true,
            blockedBy: true,
            document: {
              select: { number: true, status: true, company: { select: { name: true } }, author: { select: { email: true } } },
            },
          },
        });
        return {
          users: users.map((user) => ({ ...user, role: String(user.role) })),
          countries,
          sendingOn: actWriteEnabled(setting),
          backlog: rows.map((row) => ({
            documentId: row.documentId,
            number: row.document.number,
            status: String(row.document.status),
            companyName: row.document.company?.name ?? null,
            authorEmail: row.document.author.email,
            createdAt: row.createdAt,
            nextAttemptAt: row.nextAttemptAt,
            attempts: row.attempts,
            blockedReason: row.blockedReason,
            blockedBy: row.blockedBy,
          })),
        };
      },
      { timeout: 60_000 },
    );
  } finally {
    await db.$disconnect();
  }
}

/** Checks 1 and 3 to 7 and 10: everything asked of ACT!, in order, GETs only. */
async function checkAct(act: ActReader, users: PathQuoteUser[], countries: CompanyCountry[]): Promise<Check[]> {
  const actUsers = await read(() => act.users());
  const check1 = serviceAccountCheck(actUsers, act.loginName);
  if (!actUsers.ok) {
    // ACT! did not answer the first request, or turned it away: asking the
    // rest would wait out the same failure once a request, for nothing.
    return [
      check1,
      notAsked(3, "Account Mgr values on the Rep picklist"),
      notAsked(4, "Countries picklist"),
      notAsked(5, "Opportunity name filter"),
      notAsked(6, "Product lines carry itemNumber"),
      notAsked(7, "History regarding filter"),
      notAsked(10, "Transcribed from ACT! by hand"),
    ];
  }

  const rep = await read(() => act.picklistItems(REP_PICKLIST_ID));
  const countryItems = await read(() => act.picklistItems(COUNTRIES_PICKLIST_ID));

  // 5: the drain's own lookup request, for a name nobody has; a page of real
  // opportunities; the lookup again for one real name off that page.
  const nonsense = await read(() => act.rows("/api/opportunities", lookupQuery(opportunityNameFilter(NONSENSE_NAME))));
  const page = await read(() => act.rows("/api/opportunities", new URLSearchParams({ $top: String(OPPORTUNITY_SAMPLE_SIZE) })));
  const pageRows: Row[] = page.ok ? page.value : [];
  const opportunity = sampleOpportunity(pageRows);
  const sample = opportunity
    ? {
        opportunity,
        rows: await read(() => act.rows("/api/opportunities", lookupQuery(opportunityNameFilter(opportunity.name)))),
      }
    : null;

  // 6: products of the page's opportunities, until one has a line -- with the
  // request listProductLines makes.
  const probes: ProductProbe[] = [];
  for (const candidate of productProbeCandidates(pageRows)) {
    const lines = await read(() =>
      act.rows(`/api/opportunities/${encodeURIComponent(candidate.id)}/products`, lookupQuery()),
    );
    probes.push({ opportunity: candidate, lines });
    if (lines.ok && lines.value.length > 0) break;
  }

  // 7: a contact off those opportunities that has History, then the drain's
  // own History lookup on them, for a regarding nobody has.
  const historyProbes: { contactId: string; history: Read<Row[]> }[] = [];
  let filtered: Read<Row[]> | null = null;
  for (const contactId of historyProbeContacts(pageRows)) {
    const path = `/api/contacts/${encodeURIComponent(contactId)}/history`;
    const history = await read(() => act.rows(path, new URLSearchParams({ $top: String(HISTORY_SAMPLE_SIZE) })));
    historyProbes.push({ contactId, history });
    if (history.ok && history.value.length > 0) {
      filtered = await read(() => act.rows(path, lookupQuery(historyRegardingFilter(NONSENSE_REGARDING))));
      break;
    }
  }

  const stages = await read(() => act.rows("/api/opportunities/stages"));
  const fields = await read(() => act.rows("/api/metadata/fields"));

  return [
    check1,
    repPicklistCheck(rep, users),
    countriesCheck(countryItems, countries),
    opportunityFilterCheck({ nonsense, page, sample }),
    productLinesCheck(page, probes),
    historyFilterCheck({ page, probes: historyProbes, filtered }),
    transcribedCheck(stages, fields),
  ];
}

async function main(): Promise<void> {
  const parsed = parseWritePreflightArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(`act:write-preflight: ${parsed.error}`);
    process.exit(2);
  }

  const database = describeDatabase(process.env.DATABASE_URL);
  if (!database) {
    console.error(
      "act:write-preflight: DATABASE_URL is missing or is not a postgres URL with a host and a database name, so the run cannot say which database it would read. Refusing to start.",
    );
    process.exit(2);
  }

  let act: ActReader;
  try {
    act = actReaderFromEnv();
  } catch (error) {
    console.error(`act:write-preflight: ${error instanceof Error ? error.message : String(error)}. Refusing to start.`);
    process.exit(2);
  }

  console.log(formatWritePreflightBanner(database, { base: process.env.ACT_BASE ?? "", login: act.loginName }));
  console.log("");

  const pathQuote = await readPathQuote();
  const now = new Date();
  const fromAct = await checkAct(act, pathQuote.users, pathQuote.countries);
  const checks = [
    ...fromAct,
    usersMappedCheck(pathQuote.users),
    backlogCheck(pathQuote.sendingOn, pathQuote.backlog, now),
    drainTimerCheck(),
  ].sort((a, b) => a.number - b.number);

  for (const line of formatPreflightReport(checks)) console.log(line);
  process.exitCode = preflightExitStatus(checks);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
