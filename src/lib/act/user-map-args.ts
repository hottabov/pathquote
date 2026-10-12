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
import { npmSwallowedApply, npmSwallowedFlag, type NpmEnv } from "@/lib/npm-swallowed-flags";

export type UserMapArgs = {
  /** Write actUserId and actAccountMgr on the matched users. Default false:
   *  report only. */
  apply: boolean;
  /** Also write the matches whose Act! user is not Active. */
  includeInactive: boolean;
};

export type UserMapParseResult = { ok: true; args: UserMapArgs } | { ok: false; error: string };

export const USER_MAP_ACCEPTED_ARGS =
  "--apply, --include-inactive (with no flag the run is report-only)";

/**
 * Flags npm consumed as its own options instead of passing them on.
 *
 * The detection itself, and the measurements behind it, are in
 * src/lib/npm-swallowed-flags.ts -- shared because three other guards need the
 * same rule. What stays here is that this script has two flags and they do not
 * leave the same trace: `--include-inactive` has a dash in it and lands in
 * npm_config_include_inactive, while `--apply` is read as a run of
 * single-letter shorthands and never sets npm_config_apply at all.
 *
 * A correct `npm run act:map-users -- --apply --include-inactive` sets none of
 * those keys, so neither check can fire on the invocation it is protecting.
 *
 * Returns the flag names as the operator typed them, for the message.
 */
function npmSwallowedFlags(env: NpmEnv): string[] {
  const swallowed: string[] = [];
  if (npmSwallowedApply(env)) swallowed.push("--apply");
  if (npmSwallowedFlag(env, "--include-inactive")) swallowed.push("--include-inactive");
  return swallowed;
}

/** `argv` is `process.argv.slice(2)`. `env` is `process.env`. */
export function parseUserMapArgs(argv: readonly string[], env: NpmEnv = {}): UserMapParseResult {
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
    ? "APPLY -- writes User.actUserId and User.actAccountMgr, nothing else"
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
