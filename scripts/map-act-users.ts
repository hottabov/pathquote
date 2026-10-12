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
 * a PathQuote user and nothing populates it. Until something does, every record
 * PathQuote writes into Act! would be owned by the integration account
 * (`Marketing`), so twelve managers' quotes would all appear as one person's
 * pipeline.
 *
 * WHAT IT WRITES. User.actUserId, and nothing else. It never writes
 * User.actAccountMgr: Account Mgr is a picklist-limited field whose valid
 * values are not the Act! users' display names, and the report says so in full
 * -- see ACCOUNT_MGR_NOTE in src/lib/act/user-map.ts for the evidence.
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
 * `--apply` sets actUserId one statement at a time, and only where the column
 * is still null at the moment of the write. It never clears a mapping, never
 * re-points one, and never touches anything else on the row. Re-running is
 * safe.
 *
 * Arguments are strict: --apply, --include-inactive, or nothing. Anything else
 * is an error. A banner naming the mode and the target database (host:port/name,
 * never the password) is printed first.
 *
 * Exit status: 0 clean, 1 the run threw or some ids failed to write, 2 bad
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
import { actClientFromEnv } from "../src/lib/act/client";
import { describeDatabase } from "../src/lib/act/cli-args";
import {
  entriesToWrite,
  formatReport,
  planUserMap,
  type ActUserRow,
  type PathQuoteUserRow,
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
    }));

    const plan = planUserMap(actUsers, rows);
    for (const line of formatReport(plan, args)) console.log(line);
    console.log("");

    const writes = entriesToWrite(plan, args);

    if (!args.apply) {
      console.log("Report only. Nothing was written.");
      if (writes.length > 0) {
        console.log(`To write the ${writes.length} mapping(s) above: npm run act:map-users -- --apply`);
      }
      if (!args.includeInactive && plan.inactiveMatched.length > 0) {
        console.log(
          `To include the ${plan.inactiveMatched.length} match(es) to a non-Active Act! user: npm run act:map-users -- --apply --include-inactive`,
        );
      }
      return;
    }

    // The only write in this script: one statement per user, one column. It is
    // updateMany rather than update because Prisma's unique filter cannot say
    // `actUserId IS NULL`, and the write must be conditional: if the row gained
    // a mapping since it was read, nothing is overwritten and the miss is
    // counted as a failure instead.
    let written = 0;
    const failures: { email: string; message: string }[] = [];
    for (const { user, actUser } of writes) {
      try {
        const { count } = await db.user.updateMany({
          where: { id: user.id, actUserId: null },
          data: { actUserId: actUser.id },
        });
        if (count !== 1) {
          throw new Error(`row no longer has a null actUserId (updated ${count})`);
        }
        written += 1;
      } catch (error) {
        failures.push({
          email: user.email,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(`written ${written} of ${writes.length}`);
    if (failures.length > 0) {
      console.log("");
      console.log(`!! FAILED: ${failures.length} mapping(s) were not written.`);
      console.log("!! Typically the row was mapped, or another row took the Act! id, after it");
      console.log("!! was read -- actUserId is unique. Nothing else was modified. Re-run to see");
      console.log("!! where each stands.");
      console.log(`!! first failure: ${failures[0].email}`);
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
