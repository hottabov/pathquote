// What `npm run act:map-users` was asked to do, and what it says first.
//
// Pure for the same reason preflight-args.ts is: the one real danger of this
// script is a write to production that nobody meant, so the argument rules are
// the part worth testing, and they can be tested without a database.
//
// A sibling of preflight-args.ts rather than a widening of it: this script has
// a second flag, and the npm-swallowed-flag check below is not the same check,
// because `--apply` and `--include-inactive` do not reach the environment the
// same way. See npmSwallowedFlags.

import type { DatabaseTarget } from "@/lib/act/cli-args";

export type UserMapArgs = {
  /** Write actUserId on the matched users. Default false: report only. */
  apply: boolean;
  /** Also write the matches whose Act! user is not Active. */
  includeInactive: boolean;
};

export type UserMapParseResult = { ok: true; args: UserMapArgs } | { ok: false; error: string };

export const USER_MAP_ACCEPTED_ARGS =
  "--apply, --include-inactive (with no flag the run is report-only)";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Flags npm consumed as its own options instead of passing them on.
 *
 * npm hands the script only what follows a bare `--`. Written without it, the
 * flag never reaches process.argv and the script runs in report mode while the
 * operator believes they asked for a write. That mistake can only be caught
 * here, from the traces npm leaves in the environment -- and the two flags do
 * not leave the same trace, which is why this is not a one-liner:
 *
 *   --include-inactive  becomes npm_config_include_inactive=true. A flag with a
 *                       dash in it is not a word npm can do anything else with.
 *   --apply             does NOT become npm_config_apply, on npm 10.9.8 with
 *                       Node 22, which is what the tools image runs (measured
 *                       2026-10-12). npm's option parser cannot match the word,
 *                       falls back to reading it as a run of single-letter
 *                       shorthands, and a-p-p-l-y expands to --all,
 *                       --parseable, --parseable, --long, --yes. So all four of
 *                       npm_config_all, npm_config_parseable, npm_config_long
 *                       and npm_config_yes come out "true" together, and that
 *                       combination is the fingerprint. npm_config_apply is
 *                       checked as well because another npm version may yet set
 *                       it -- it is what scripts/normalise-websites.ts and
 *                       preflight-args.ts look for.
 *
 * A correct `npm run act:map-users -- --apply --include-inactive` sets none of
 * these, so neither check can fire on the invocation it is protecting.
 *
 * Returns the flag names as the operator typed them, for the message.
 */
function npmSwallowedFlags(env: Env): string[] {
  const swallowed: string[] = [];

  const applyShorthands = ["npm_config_all", "npm_config_parseable", "npm_config_long", "npm_config_yes"];
  if (env.npm_config_apply === "true" || applyShorthands.every((name) => env[name] === "true")) {
    swallowed.push("--apply");
  }
  if (env.npm_config_include_inactive === "true") {
    swallowed.push("--include-inactive");
  }

  return swallowed;
}

/** `argv` is `process.argv.slice(2)`. `env` is `process.env`. */
export function parseUserMapArgs(argv: readonly string[], env: Env = {}): UserMapParseResult {
  let apply = false;
  let includeInactive = false;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--include-inactive") {
      includeInactive = true;
    } else {
      return {
        ok: false,
        error: `unknown argument ${JSON.stringify(arg)}. Accepted: ${USER_MAP_ACCEPTED_ARGS}`,
      };
    }
  }

  // Only a flag that did NOT also arrive in argv is a swallowed one. Typing it
  // both ways -- `npm run act:map-users --apply -- --apply` -- is odd but not
  // ambiguous: the script got the flag, so there is nothing to warn about.
  const swallowed = npmSwallowedFlags(env).filter(
    (flag) => !(flag === "--apply" ? apply : includeInactive),
  );
  if (swallowed.length > 0) {
    return {
      ok: false,
      error: `npm swallowed ${swallowed.join(" and ")} and never passed ${
        swallowed.length > 1 ? "them" : "it"
      } to the script, so this would have run as a report only. Put -- before the flags: npm run act:map-users -- ${swallowed.join(" ")}`,
    };
  }

  return { ok: true, args: { apply, includeInactive } };
}

export function formatUserMapBanner(args: UserMapArgs, database: DatabaseTarget): string {
  const mode = args.apply
    ? "APPLY -- writes User.actUserId on the matched users, nothing else"
    : "report only -- writes nothing (add --apply to write)";
  const inactive = args.includeInactive
    ? "included -- a match to a non-Active Act! user is written too"
    : "held back -- a match to a non-Active Act! user is reported, not written";

  return [
    "act:map-users",
    `  mode      ${mode}`,
    `  inactive  ${inactive}`,
    `  database  ${database.host}:${database.port}/${database.name}`,
  ].join("\n");
}
