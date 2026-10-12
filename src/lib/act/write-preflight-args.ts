// What `npm run act:write-preflight` was asked to do, and what it says first.
//
// Nothing: it takes no arguments. Pure, and a sibling of preflight-args.ts and
// drain-args.ts rather than a widening of either, for their reason -- the
// rule is the same, anything not understood is an error, and the database
// description is shared (describeDatabase in src/lib/act/cli-args.ts).
//
// Why refuse a flag that changes nothing: a person who types one believes it
// does something. `--apply` is the likely one, from the scripts beside this
// one, and this script never writes; running it as if it had been heard would
// let them believe something was written. npm keeps a flag written without
// `--` for itself, and that is refused too, from the trace it leaves
// (src/lib/npm-swallowed-flags.ts).

import type { DatabaseTarget } from "@/lib/act/cli-args";
import { npmSwallowedApply, npmSwallowedFlag, type NpmEnv } from "@/lib/npm-swallowed-flags";

export type WritePreflightParseResult = { ok: true } | { ok: false; error: string };

const NO_ARGUMENTS =
  "act:write-preflight takes no arguments: it only reads, from ACT! and from PathQuote, and there is nothing to choose";

/**
 * `argv` is `process.argv.slice(2)`; `env` is `process.env`, read for the
 * trace of a flag npm swallowed. Either way the answer is the same refusal:
 * this script has no flags.
 */
export function parseWritePreflightArgs(argv: readonly string[], env: NpmEnv = {}): WritePreflightParseResult {
  if (argv.length > 0) {
    return { ok: false, error: `unknown argument ${JSON.stringify(argv[0])}. ${NO_ARGUMENTS}.` };
  }
  if (npmSwallowedApply(env)) {
    return {
      ok: false,
      error: `npm swallowed --apply. ${NO_ARGUMENTS} -- it never writes, with or without a flag.`,
    };
  }
  if (npmSwallowedFlag(env, "--dry-run")) {
    return {
      ok: false,
      error: `npm swallowed --dry-run. ${NO_ARGUMENTS} -- every run is already read-only.`,
    };
  }
  return { ok: true };
}

/** The banner: what it is about to read, and that it writes nothing. */
export function formatWritePreflightBanner(database: DatabaseTarget, act: { base: string; login: string }): string {
  return [
    "act:write-preflight",
    "  mode      READ-ONLY -- GETs to ACT!, a READ ONLY transaction on PathQuote; writes nothing to either",
    `  act       ${act.base} as "${act.login}"`,
    `  database  ${database.host}:${database.port}/${database.name}`,
  ].join("\n");
}
