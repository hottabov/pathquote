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

export type PreflightArgs = { apply: boolean };

export type PreflightParseResult =
  | { ok: true; args: PreflightArgs }
  | { ok: false; error: string };

export const PREFLIGHT_ACCEPTED_ARGS = "--apply (with no flag the run is report-only)";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `argv` is `process.argv.slice(2)`. `env` is `process.env`, read for one
 * reason: `npm run act:sync-preflight --apply` -- no `--` -- does not hand the
 * flag to the script. npm keeps it as its own option and the script starts with
 * no arguments. Here that means a report where the person expected a write,
 * which is the safe direction, but a run that quietly did something other than
 * what was typed is exactly what this module exists to refuse. npm leaves the
 * swallowed flag in the environment as `npm_config_apply`, so it is detectable.
 */
export function parsePreflightArgs(argv: readonly string[], env: Env = {}): PreflightParseResult {
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

  if (env.npm_config_apply === "true" && !apply) {
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
