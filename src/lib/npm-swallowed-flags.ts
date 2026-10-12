// Which flags npm kept for itself instead of handing to the script.
//
// `npm run <script> --apply` does not pass `--apply`. npm gives a script only
// what follows a bare `--`; written without one, the flag never reaches
// process.argv and the script runs with its defaults while the operator
// believes they asked for something else. Every operator script here defaults
// to report-only, so the mistake is silent in the worse direction: the run
// prints a report, says nothing was written, exits 0, and the operator reads
// the report as proof the write happened.
//
// The only trace is in the environment, and it is not the trace you would
// guess. Measured on npm 10.9.8 with Node 22 -- what the tools image runs --
// on 2026-10-12:
//
//   npm run x --apply             npm_config_all, npm_config_parseable,
//                                 npm_config_long and npm_config_yes all
//                                 "true". npm_config_apply is NOT set.
//   npm run x --apply=true        the same four keys. Still no npm_config_apply.
//   npm run x --no-apply          npm_config_apply="" -- the empty string, not
//                                 "false", and asking for the default is not
//                                 the mistake this catches.
//   npm run x --include-inactive  npm_config_include_inactive="true"
//   npm run x --dry-run           npm_config_dry_run="true"
//   npm run x -- --apply          no npm_config_* at all; argv is ["--apply"]
//
// `--apply` is the odd one out because npm's option parser cannot match the
// word `apply` to any option of its own, so it falls back to reading the
// letters as a run of single-letter shorthands: a-p-p-l-y expands to --all,
// --parseable, --parseable, --long, --yes. A flag with a dash in it
// (`--include-inactive`, `--dry-run`) cannot be read that way, so it lands in
// npm_config_<name> as expected.
//
// This module exists because three shipped guards tested npm_config_apply and
// nothing else, which that expansion never sets, so the check written to catch
// exactly this mistake could not fire on it. One definition, one test file, and
// npm_config_apply is still checked because another npm version may yet set it.

export type NpmEnv = Readonly<Record<string, string | undefined>>;

/**
 * The four npm options the letters of `apply` expand to, in npm's own order.
 * All four together are the fingerprint: npm_config_all on its own is the
 * operator's own `--all`, which is a different mistake for a different script
 * to report.
 */
export const APPLY_SHORTHAND_KEYS = [
  "npm_config_all",
  "npm_config_parseable",
  "npm_config_long",
  "npm_config_yes",
] as const;

/**
 * Whether npm swallowed an `--apply` the operator typed.
 *
 * A correct `npm run x -- --apply` sets none of these keys, so this cannot
 * fire on the invocation it is protecting. Callers that also accept `--apply`
 * in argv must still check argv first: typing it both ways is odd but not
 * ambiguous, and the script did get the flag.
 */
export function npmSwallowedApply(env: NpmEnv): boolean {
  if (env.npm_config_apply === "true") return true;
  return APPLY_SHORTHAND_KEYS.every((key) => env[key] === "true");
}

/** `"--include-inactive"` -> `"npm_config_include_inactive"`, which is how npm
 *  names the option it could not match. */
export function npmConfigKey(flag: string): string {
  return `npm_config_${flag.replace(/^--/, "").replace(/-/g, "_")}`;
}

/**
 * Whether npm swallowed a flag that contains a dash, which is every flag but
 * `--apply`. `"true"` and not merely truthy: `--no-include-inactive` leaves the
 * key set to the empty string, and asking for the default is not a mistake.
 *
 * `--apply` has no dash and does not come through here -- use
 * npmSwallowedApply, which knows about the shorthand expansion.
 */
export function npmSwallowedFlag(env: NpmEnv, flag: string): boolean {
  return env[npmConfigKey(flag)] === "true";
}
