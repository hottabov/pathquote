// What `npm run act:weekly-report` was asked to do. Pure, and strict for the
// same reason as cli-args.ts: a flag that is silently dropped is a test run
// that quietly emails three managers and their CCs.

import {
  parseCalendarDate,
  previousWeek,
  windowForDays,
  type ReportWindow,
} from "@/lib/act/weekly-report";

export type WeeklyReportArgs = {
  dryRun: boolean;
  window: ReportWindow;
  /** Send every report to this one address instead, with no CC. */
  sendTo: string | null;
};

export type WeeklyReportParse = { ok: true; args: WeeklyReportArgs } | { ok: false; error: string };

export const WEEKLY_REPORT_ACCEPTED_ARGS =
  "--dry-run, --from YYYY-MM-DD --to YYYY-MM-DD (both, inclusive Melbourne days), --send-to EMAIL";

type Env = Readonly<Record<string, string | undefined>>;

function fail(message: string): WeeklyReportParse {
  return { ok: false, error: `${message}. Accepted: ${WEEKLY_REPORT_ACCEPTED_ARGS}` };
}

/**
 * `argv` is `process.argv.slice(2)`; `env` is read only to catch a flag npm
 * kept for itself because the `--` was missing.
 */
export function parseWeeklyReportArgs(argv: readonly string[], now: Date, env: Env = {}): WeeklyReportParse {
  let dryRun = false;
  const values: Record<"from" | "to" | "send-to", string | undefined> = {
    from: undefined,
    to: undefined,
    "send-to": undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const name = (["from", "to", "send-to"] as const).find(
      (key) => arg === `--${key}` || arg.startsWith(`--${key}=`),
    );
    if (!name) return fail(`unknown argument ${JSON.stringify(arg)}`);
    if (values[name] !== undefined) return fail(`--${name} was given more than once`);
    const raw = arg === `--${name}` ? argv[++i] : arg.slice(`--${name}=`.length);
    if (raw === undefined || raw.startsWith("--")) return fail(`--${name} needs a value`);
    values[name] = raw;
  }

  const swallowed: Array<[string, boolean]> = [
    ["--dry-run", env.npm_config_dry_run === "true" && !dryRun],
    ["--from", Boolean(env.npm_config_from) && values.from === undefined],
    ["--to", Boolean(env.npm_config_to) && values.to === undefined],
    ["--send-to", Boolean(env.npm_config_send_to) && values["send-to"] === undefined],
  ];
  for (const [flag, wasSwallowed] of swallowed) {
    if (wasSwallowed) {
      return {
        ok: false,
        error: `npm swallowed ${flag} and never passed it to the script. Put -- before the flags: npm run act:weekly-report -- ${flag}`,
      };
    }
  }

  let window: ReportWindow;
  if (values.from === undefined && values.to === undefined) {
    window = previousWeek(now);
  } else if (values.from === undefined || values.to === undefined) {
    return fail("--from and --to go together");
  } else {
    const first = parseCalendarDate(values.from);
    const last = parseCalendarDate(values.to);
    if (!first) return fail(`--from is not a YYYY-MM-DD date: ${JSON.stringify(values.from)}`);
    if (!last) return fail(`--to is not a YYYY-MM-DD date: ${JSON.stringify(values.to)}`);
    window = windowForDays(first, last);
    if (window.to <= window.from) return fail("--to is before --from");
  }

  const sendTo = values["send-to"] ?? null;
  if (sendTo !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendTo)) {
    return fail(`--send-to is not an email address: ${JSON.stringify(sendTo)}`);
  }

  return { ok: true, args: { dryRun, window, sendTo } };
}
