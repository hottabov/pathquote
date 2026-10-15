/**
 * Join PathQuote users to Act! users, so an Act! record PathQuote creates can
 * be attributed to the person who created it.
 *
 *   npm run act:map-users                                  # report, writes nothing
 *   npm run act:map-users -- --apply                       # writes User.actUserId
 *   npm run act:map-users -- --apply --include-inactive    # ... non-Active Act! users too
 *
 * The `--` matters. Without it npm keeps the flags for itself and the script
 * starts with none -- a report where a write was meant. The script detects that
 * and refuses with exit code 2 rather than guessing.
 *
 * WHERE TO RUN IT. On the VPS, in /opt/pathquote, the same way act:sync runs:
 *
 *   TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:map-users
 *   TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:map-users -- --apply
 *
 * The Act! Web API is IP-allowlisted to 74.208.106.34, the VPS
 * (docs/act-integration-reference.md section 11). From anywhere else it answers
 * 403 even with correct credentials, so this cannot be run from a laptop.
 *
 * WHY IT EXISTS. User.actUserId is the join between an Act! Record Manager and
 * a PathQuote user. This script populates it by email; an admin can also set
 * it by hand in Settings -> Users -> <user> -> ACT! (how distributors, whose
 * Act! users have no email, are linked -- src/lib/act/user-link.ts), and this
 * script never overwrites a value already stored.
 * Without it, every record PathQuote writes into Act! is owned by the
 * integration account (`Marketing`), so twelve managers' quotes would all
 * appear as one person's pipeline.
 *
 * WHAT IT WRITES. Two columns, on two different keys, and nothing else.
 *
 *   User.actUserId      the Act! user whose email is this person's. See HOW IT
 *                       MATCHES below.
 *   User.actAccountMgr  the Act! `Rep` picklist item whose value equals that
 *                       Act! user's display name exactly. Account Mgr is a
 *                       picklist-limited field and PathQuote decides client
 *                       visibility on it, so nothing but an exact item is
 *                       written: a near-match -- differing only in case or
 *                       whitespace -- is reported for a person to resolve, and
 *                       a display name with no item at all is reported as work
 *                       for the Act! administrator. The picklist is read from
 *                       the API every run, never hardcoded, because an
 *                       administrator edits it. See matchAccountMgr in
 *                       src/lib/act/user-map.ts.
 *
 * Neither column is ever overwritten. A row that already holds a value keeps
 * it, and the report names the ones whose stored Account Mgr differs from the
 * picklist item rather than repairing them.
 *
 * HOW IT MATCHES. On email, case-insensitively and trimmed, and on nothing
 * else. Every PathQuote user ends up in exactly one group, and only the first
 * is ever written:
 *   matched           one Act! user has that email, it is Active, its id is free
 *   already mapped    the stored id still resolves to this person -- a no-op,
 *                     which is what makes a second run idempotent
 *   not Active        the email joins but the Act! user is disabled. Held back
 *                     unless --include-inactive: a record owned by a disabled
 *                     user is a support call
 *   ambiguous         two Act! users on one email, or two PathQuote rows folding
 *                     to one email
 *   unmatched         no Act! user carries that email
 *   drift             a stored actUserId that is gone from Act!, or now belongs
 *                     to a different email, or is held by another PathQuote row
 *
 * `--apply` sets each column one statement at a time, and only where that
 * column is still null at the moment of the write. It never clears a value,
 * never re-points one, and never touches anything else on the row. Re-running
 * is safe, and a row mapped by a run from before actAccountMgr existed picks
 * up the second column on the next run without the first being rewritten.
 *
 * Arguments are strict: --apply, --include-inactive, or nothing. Anything else
 * is an error. A banner naming the mode and the target database (host:port/name,
 * never the password) is printed first.
 *
 * Exit status: 0 clean, 1 the run threw or some values failed to write, 2 bad
 * arguments or no identifiable database.
 *
 * Environment (see docs/act-integration-reference.md section 10):
 *   ACT_BASE=https://actapi.pathfindercut.com/act.web.api
 *   ACT_DB=Pathfinder
 *   ACT_USER='Marketing'     # the Act! display name, not a login id
 *   ACT_PASS=...
 *   DATABASE_URL=...         # shown in the banner as host:port/name only
 */
import "dotenv/config";
import { actClientFromEnv, REP_PICKLIST_ID } from "../src/lib/act/client";
import { describeDatabase } from "../src/lib/act/cli-args";
import {
  accountMgrWrites,
  entriesToWrite,
  formatReport,
  planUserMap,
  type ActUserRow,
  type PathQuoteUserRow,
  type RepPicklistItem,
} from "../src/lib/act/user-map";
import { formatUserMapBanner, parseUserMapArgs } from "../src/lib/act/user-map-args";

async function main() {
  const parsed = parseUserMapArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(`act:map-users: ${parsed.error}`);
    process.exit(2);
  }
  const { args } = parsed;

  // A run that cannot say which database it is about to touch does not start.
  const database = describeDatabase(process.env.DATABASE_URL);
  if (!database) {
    console.error(
      "act:map-users: DATABASE_URL is missing or is not a postgres URL with a host and a database name, so the run cannot say which database it would use. Refusing to start.",
    );
    process.exit(2);
  }

  console.log(formatUserMapBanner(args, database));
  console.log("");

  const client = actClientFromEnv();

  // Logged every run so an Act! upgrade is visible in our own output before it
  // is visible as a bug, exactly as act:sync does it.
  const system = await client.system();
  console.log(`Act! Web API ${system.apiVersion}, SDK ${system.sdkVersion}`);

  // `?? null` rather than a cast: the swagger definition marks none of these
  // fields required, so a field the API omits arrives as undefined, and
  // ActUserRow declares null. Normalising here means user-map.ts sees exactly
  // the type it says it takes.
  const actUsers: ActUserRow[] = (await client.users()).map((actUser) => ({
    id: actUser.id,
    displayName: actUser.displayName ?? null,
    email: actUser.email ?? null,
    status: actUser.status ?? null,
    role: actUser.role ?? null,
  }));
  console.log(`read ${actUsers.length} Act! users`);

  // The Rep picklist, which is the vocabulary Account Mgr is limited to. Read
  // every run and never cached or hardcoded: an administrator edits this list
  // in Act! -- distributor names are being added to it -- so a copy in the repo
  // would be wrong within the week.
  const repPicklist: RepPicklistItem[] = (await client.picklistItems(REP_PICKLIST_ID)).map(
    (item) => ({
      id: item.id,
      value: item.value ?? null,
      description: item.description ?? null,
    }),
  );
  console.log(`read ${repPicklist.length} items of the Act! "Rep" picklist (Account Mgr)`);
  console.log("");

  // Imported here, not at module scope, so the argument and DATABASE_URL checks
  // above end in their own message and exit code 2. src/lib/db.ts builds its
  // client on import and throws when DATABASE_URL is unset (Prisma 7 needs an
  // explicit driver adapter, see src/lib/db.ts), which at module scope would
  // surface as an uncaught stack trace before main() ran. Same reason as
  // scripts/act-sync-preflight.ts.
  const { db } = await import("../src/lib/db");

  try {
    const users = await db.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        actUserId: true,
        actAccountMgr: true,
      },
      orderBy: [{ email: "asc" }],
    });

    const rows: PathQuoteUserRow[] = users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active: user.active,
      actUserId: user.actUserId,
      actAccountMgr: user.actAccountMgr,
    }));

    const plan = planUserMap(actUsers, rows, repPicklist);
    for (const line of formatReport(plan, args)) console.log(line);
    console.log("");

    const writes = entriesToWrite(plan, args);
    const mgrWrites = accountMgrWrites(plan, args);

    if (!args.apply) {
      console.log("Report only. Nothing was written.");
      if (writes.length > 0 || mgrWrites.length > 0) {
        console.log(
          `To write the ${writes.length} actUserId and ${mgrWrites.length} actAccountMgr value(s) above: npm run act:map-users -- --apply`,
        );
      }
      if (!args.includeInactive && plan.inactiveMatched.length > 0) {
        console.log(
          `To include the ${plan.inactiveMatched.length} match(es) to a non-Active Act! user: npm run act:map-users -- --apply --include-inactive`,
        );
      }
      return;
    }

    // Two write passes, each one statement per row and one column. They are
    // separate passes rather than one update per row because the two columns
    // are not the same set of rows: a row mapped by an earlier run needs only
    // the second, and a row whose Act! user is not in the picklist gets only
    // the first.
    //
    // updateMany rather than update, in both, because Prisma's unique filter
    // cannot say `<column> IS NULL`, and the write must be conditional: if the
    // row gained a value since it was read, nothing is overwritten and the miss
    // is counted as a failure instead.
    type Failure = { email: string; message: string };

    const writeColumn = async <T extends { user: PathQuoteUserRow }>(
      entries: readonly T[],
      column: "actUserId" | "actAccountMgr",
      valueOf: (entry: T) => string,
    ): Promise<{ written: number; failures: Failure[] }> => {
      let written = 0;
      const failures: Failure[] = [];
      for (const entry of entries) {
        try {
          const { count } = await db.user.updateMany({
            where: { id: entry.user.id, [column]: null },
            data: { [column]: valueOf(entry) },
          });
          if (count !== 1) {
            throw new Error(`row no longer has a null ${column} (updated ${count})`);
          }
          written += 1;
        } catch (error) {
          failures.push({
            email: entry.user.email,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { written, failures };
    };

    const ids = await writeColumn(writes, "actUserId", (entry) => entry.actUser.id);
    const mgrs = await writeColumn(mgrWrites, "actAccountMgr", (entry) => entry.value);

    console.log(`actUserId      written ${ids.written} of ${writes.length}`);
    console.log(`actAccountMgr  written ${mgrs.written} of ${mgrWrites.length}`);

    const failures = [
      ...ids.failures.map((failure) => ({ column: "actUserId", ...failure })),
      ...mgrs.failures.map((failure) => ({ column: "actAccountMgr", ...failure })),
    ];
    if (failures.length > 0) {
      console.log("");
      console.log(`!! FAILED: ${failures.length} value(s) were not written.`);
      console.log("!! Typically the row gained that value, or another row took the Act! id, after");
      console.log("!! it was read -- actUserId is unique. Nothing else was modified. Re-run to see");
      console.log("!! where each stands.");
      console.log(`!! first failure: ${failures[0].email} (${failures[0].column})`);
      console.log(`!!   ${failures[0].message}`);
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
