import "dotenv/config";

/**
 * The Monday activity report: one email per sales manager with last week's
 * Call Completed / E-mail Sent / Meeting Held counts and new prospects, read
 * from Act!.
 *
 *   npm run act:weekly-report -- --dry-run                         # print, send nothing
 *   npm run act:weekly-report -- --dry-run --from 2026-10-04 --to 2026-10-11
 *   npm run act:weekly-report -- --send-to you@pathfindercut.com   # every report to you, no CC
 *   npm run act:weekly-report                                      # the real thing
 *
 * The `--` matters: without it npm keeps the flags and the script would send
 * for real. It notices and refuses.
 *
 * WHERE TO RUN IT. On the VPS only -- the Act! Web API is IP-allowlisted to it
 * (docs/act-integration-reference.md section 11):
 *
 *   cd /opt/pathquote
 *   TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:weekly-report -- --dry-run
 *
 * Scheduled by pq-act-weekly-report.timer, Mondays 08:00 Melbourne.
 *
 * WHAT IT READS. Read-only against Act!, and touches no database:
 *   - /api/users, to find each configured manager and their email
 *   - /api/History for the window -- every manager's history in a handful of
 *     requests, counted per Record Manager
 *   - /api/contacts edited since the window opened, to find the contacts
 *     created in it with ID/Status Prospect (a contact created in the window
 *     was necessarily edited in it, and `edited ge` is the filter already
 *     proven against the live API)
 *
 * Recipients are in src/lib/act/weekly-report-recipients.ts.
 *
 * Exit status: 0 every report sent (or printed); 1 a manager could not be
 * resolved or an email failed -- the others still go; 2 bad arguments or
 * missing configuration.
 */

import { actClientFromEnv } from "@/lib/act/client";
import type { ActContact } from "@/lib/act/types";
import {
  buildWeeklyReportEmail,
  countForManager,
  historyTypeBreakdown,
  reportFromAddress,
  reportRows,
  resolveManager,
  type ResolvedManager,
} from "@/lib/act/weekly-report";
import { parseWeeklyReportArgs } from "@/lib/act/weekly-report-args";
import {
  WEEKLY_REPORT_MANAGERS,
  WEEKLY_REPORT_REPLY_TO,
  WEEKLY_REPORT_SENDER_NAME,
} from "@/lib/act/weekly-report-recipients";
import { createAppMailTransport, mailFromAddress } from "@/lib/email/transport";

async function main(): Promise<number> {
  const parsed = parseWeeklyReportArgs(process.argv.slice(2), new Date(), process.env);
  if (!parsed.ok) {
    console.error(`act:weekly-report: ${parsed.error}`);
    return 2;
  }
  const { dryRun, window, sendTo } = parsed.args;

  const emailFrom = mailFromAddress();
  if (!dryRun && !emailFrom) {
    console.error("act:weekly-report: EMAIL_FROM is not set, so there is nothing to send from");
    return 2;
  }

  const mode = dryRun ? "dry run (nothing is sent)" : sendTo ? `TEST SEND, everything to ${sendTo}` : "SEND";
  console.log(`act:weekly-report: ${mode}`);
  console.log(
    `  period ${window.label}: ${window.from.toISOString()} .. ${window.to.toISOString()} (Melbourne days, end exclusive)`,
  );

  const act = actClientFromEnv();
  const system = await act.system();
  console.log(`  Act! Web API ${system.apiVersion}, SDK ${system.sdkVersion}`);

  const users = await act.users();
  const managers: ResolvedManager[] = [];
  let failures = 0;
  for (const config of WEEKLY_REPORT_MANAGERS) {
    const resolved = resolveManager(config, users);
    if (resolved.ok) {
      managers.push(resolved.manager);
    } else {
      failures += 1;
      console.error(`  SKIPPED ${config.actUser}: ${resolved.error}`);
    }
  }

  const histories = await act.historiesBetween(window.from, window.to);
  const contacts: ActContact[] = [];
  for await (const page of act.contactsEditedSince(window.from)) contacts.push(...page);
  console.log(`  read ${histories.length} history records and ${contacts.length} contacts edited since the window opened`);

  const transport = dryRun ? null : createAppMailTransport();
  const from = emailFrom ? reportFromAddress(emailFrom, WEEKLY_REPORT_SENDER_NAME) : "(EMAIL_FROM unset)";

  for (const manager of managers) {
    const counts = countForManager(manager.actUserId, histories, contacts, window);
    const email = buildWeeklyReportEmail({ firstName: manager.firstName, window, counts });
    const to = sendTo ?? manager.to;
    const cc = sendTo ? [] : manager.cc;

    console.log("");
    console.log(`  ${manager.displayName} -> to ${to}${cc.length ? `, cc ${cc.join(", ")}` : ""}`);
    for (const row of reportRows(counts)) console.log(`    ${row.label.padEnd(20)} ${row.value}`);

    if (dryRun) {
      const breakdown = historyTypeBreakdown(manager.actUserId, histories, window);
      console.log(
        `    all history in the window: ${breakdown.length ? breakdown.map((t) => `${t.name} ${t.count}`).join(", ") : "none"}`,
      );
      // The email exactly as it would go: headers, then the plain-text body.
      // The HTML part carries the same words with the numbers in a table;
      // --send-to shows it rendered.
      console.log("    ---------------- would send ----------------");
      console.log(`    From:     ${from}`);
      console.log(`    To:       ${to}`);
      console.log(`    Cc:       ${cc.length ? cc.join(", ") : "(none)"}`);
      console.log(`    Reply-To: ${WEEKLY_REPORT_REPLY_TO}`);
      console.log(`    Subject:  ${email.subject}`);
      console.log("");
      for (const line of email.text.split("\n")) console.log(`    ${line}`);
      console.log("    --------------------------------------------");
      continue;
    }

    try {
      const info = await transport!.sendMail({
        from,
        to,
        cc: cc.length ? cc : undefined,
        replyTo: WEEKLY_REPORT_REPLY_TO,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      console.log(`    sent (${info.messageId})`);
    } catch (error) {
      failures += 1;
      console.error(`    FAILED to send: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log("");
  console.log(`act:weekly-report: ${managers.length} report(s), ${failures} failure(s)`);
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("act:weekly-report: failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
