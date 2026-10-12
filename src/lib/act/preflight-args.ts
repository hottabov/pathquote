// What `npm run act:sync-preflight` was asked to do, and what it says first.
//
// Pure for the same reason cli-args.ts is: the one real danger of this script
// is a write to production that nobody meant, so the argument rules are the part
// worth testing, and they can be tested without a database.
//
// cli-args.ts parses the sync's flags (--full, --dry-run, --limit) and a banner
// that says "dry run". Neither fits a script whose only flag is --apply and
// whose default is already report-only, so this is a sibling with the same
// rule -- anything not understood is an error -- rather than a widening of it.
// The database description is shared: describeDatabase and DatabaseTarget come
// from there unchanged.

import type { DatabaseTarget } from "@/lib/act/cli-args";
import { npmSwallowedApply, type NpmEnv } from "@/lib/npm-swallowed-flags";

export type PreflightArgs = { apply: boolean };

export type PreflightParseResult =
  | { ok: true; args: PreflightArgs }
  | { ok: false; error: string };

export const PREFLIGHT_ACCEPTED_ARGS = "--apply (with no flag the run is report-only)";

/**
 * `argv` is `process.argv.slice(2)`. `env` is `process.env`, read for one
 * reason: `npm run act:sync-preflight --apply` -- no `--` -- does not hand the
 * flag to the script. npm keeps it as its own option and the script starts with
 * no arguments, so the run reports where the operator asked for a write and
 * exits 0, which reads as proof that the write happened. That is what this
 * check refuses.
 *
 * Detection is npmSwallowedApply, not a direct read of npm_config_apply: on
 * npm 10.9.8 the word `apply` is expanded into single-letter shorthands and
 * npm_config_apply is never set, so the npm_config_apply test this function
 * shipped with could not fire. See src/lib/npm-swallowed-flags.ts.
 */
export function parsePreflightArgs(argv: readonly string[], env: NpmEnv = {}): PreflightParseResult {
  let apply = false;

  for (const arg of argv) {
    if (arg === "--apply") {
      apply = true;
    } else {
      return {
        ok: false,
        error: `unknown argument ${JSON.stringify(arg)}. Accepted: ${PREFLIGHT_ACCEPTED_ARGS}`,
      };
    }
  }

  if (npmSwallowedApply(env) && !apply) {
    return {
      ok: false,
      error:
        "npm swallowed --apply and never passed it to the script, so this would have run as a report only. Put -- before the flag: npm run act:sync-preflight -- --apply",
    };
  }

  return { ok: true, args: { apply } };
}

export function formatPreflightBanner(args: PreflightArgs, database: DatabaseTarget): string {
  const mode = args.apply
    ? "APPLY -- writes actCompanyKey on the unambiguous companies, nothing else"
    : "report only -- writes nothing (add --apply to write)";

  return [
    "act:sync-preflight",
    `  mode      ${mode}`,
    `  database  ${database.host}:${database.port}/${database.name}`,
  ].join("\n");
}
