// What `npm run act:sync` was asked to do, and what it should say before doing it.
//
// Pure on purpose, like the rest of this directory. The CLI's one real danger
// is a careful run that quietly becomes a full production write, so the
// argument rules are the part worth testing, and they can be tested without a
// database or a network.
//
// The rule throughout is that anything not understood is an error. A flag
// that is silently ignored is a flag that does not do what its author thinks.

import type { SyncTrigger } from "@/lib/act/run-record";

export type ActSyncArgs = {
  full: boolean;
  dryRun: boolean;
  limit: number | undefined;
  /**
   * Who the run is recorded as. The nightly timer passes `--trigger schedule`;
   * a person at a shell passes nothing and gets "manual", which is what they
   * are. See SyncOptions.trigger for why that is the safer default.
   */
  trigger: SyncTrigger;
};

export type ParseResult = { ok: true; args: ActSyncArgs } | { ok: false; error: string };

export const ACCEPTED_ARGS =
  "--full, --dry-run, --limit N (or --limit=N), --trigger schedule|manual (or --trigger=...)";

type Env = Readonly<Record<string, string | undefined>>;

function fail(message: string): ParseResult {
  return { ok: false, error: `${message}. Accepted: ${ACCEPTED_ARGS}` };
}

/** A positive whole number, written as digits and nothing else. */
function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * `argv` is `process.argv.slice(2)`. `env` is `process.env`, and is read for
 * exactly one reason.
 *
 * `npm run act:sync --dry-run` -- no `--` -- does not pass the flag to the
 * script. npm treats it as its own option (it has a real `--dry-run`) and the
 * script starts with no arguments at all, which is a full WRITE. npm leaves a
 * trace in the environment, so a flag it swallowed is detectable, and
 * refusing is the only safe answer.
 */
export function parseActSyncArgs(argv: readonly string[], env: Env = {}): ParseResult {
  let full = false;
  let dryRun = false;
  let limit: number | undefined;
  let limitSeen = false;
  let trigger: SyncTrigger = "manual";
  let triggerSeen = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--full") {
      full = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      if (limitSeen) return fail("--limit was given more than once");
      limitSeen = true;

      // `--limit N` takes the next token whatever it is, so `--limit --dry-run`
      // is a bad value rather than a limit followed by a flag.
      const raw = arg === "--limit" ? argv[++i] : arg.slice("--limit=".length);
      const parsed = parseLimit(raw);
      if (parsed === null) {
        const got = raw === undefined ? "nothing" : JSON.stringify(raw);
        return fail(`--limit needs a positive whole number, got ${got}`);
      }
      limit = parsed;
    } else if (arg === "--trigger" || arg.startsWith("--trigger=")) {
      if (triggerSeen) return fail("--trigger was given more than once");
      triggerSeen = true;

      // Same two spellings and the same take-the-next-token rule as --limit,
      // so `--trigger --dry-run` is a bad value rather than a silent default.
      const raw = arg === "--trigger" ? argv[++i] : arg.slice("--trigger=".length);
      if (raw !== "schedule" && raw !== "manual") {
        const got = raw === undefined ? "nothing" : JSON.stringify(raw);
        return fail(`--trigger must be schedule or manual, got ${got}`);
      }
      trigger = raw;
    } else {
      return fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }

  const swallowed: Array<[string, boolean]> = [
    ["--dry-run", env.npm_config_dry_run === "true" && !dryRun],
    ["--full", env.npm_config_full === "true" && !full],
    ["--limit", Boolean(env.npm_config_limit) && !limitSeen],
    // npm turns any unknown `--foo=bar` into npm_config_foo, so a timer unit
    // written without the `--` would label the nightly run as a hand run and
    // nobody would notice until the Settings page said so.
    ["--trigger", Boolean(env.npm_config_trigger) && !triggerSeen],
  ];
  for (const [flag, wasSwallowed] of swallowed) {
    if (wasSwallowed) {
      return {
        ok: false,
        error: `npm swallowed ${flag} and never passed it to the script, so this would have run without it. Put -- before the flags: npm run act:sync -- ${flag}`,
      };
    }
  }

  return { ok: true, args: { full, dryRun, limit, trigger } };
}

export type DatabaseTarget = { host: string; port: string; name: string };

/**
 * Which database a DATABASE_URL points at: host, port and name, and nothing
 * else. The password and the username are never read out of the URL, and on
 * any failure the URL itself is not echoed either, since a URL that does not
 * parse is the one most likely to have a password sitting where a host should
 * be.
 *
 * Null when the URL is missing, is not a postgres URL, or does not parse to a
 * plain host and database name.
 */
export function describeDatabase(url: string | undefined): DatabaseTarget | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;

  // A path with more than one segment means the authority did not parse the
  // way it was written, typically an unescaped "/" in the password.
  const name = parsed.pathname.replace(/^\//, "");
  if (!parsed.hostname || !/^[^/]+$/.test(name)) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return null;
  }
  return { host: parsed.hostname, port: parsed.port || "5432", name: decoded };
}

export function formatBanner(args: ActSyncArgs, database: DatabaseTarget): string {
  const mode = args.dryRun
    ? "dry run -- reads ACT!, writes nothing"
    : "WRITE -- creates and updates contacts and companies";
  const limit = args.limit === undefined ? "none" : `${args.limit} contacts`;
  const since = args.full
    ? "everything (--full: the stored cursor is ignored)"
    : "changes since the stored cursor";
  // Said in the banner because it is part of what the run was asked to do, and
  // because the nightly unit's whole contribution is this one word: a journal
  // entry that says "manual" is a unit that lost its flag.
  const trigger =
    args.trigger === "schedule"
      ? "schedule -- Settings will call it the nightly run"
      : "manual -- Settings will call it run by hand";

  return [
    "act:sync",
    `  mode      ${mode}`,
    `  limit     ${limit}`,
    `  reads     ${since}`,
    `  trigger   ${trigger}`,
    `  database  ${database.host}:${database.port}/${database.name}`,
  ].join("\n");
}
