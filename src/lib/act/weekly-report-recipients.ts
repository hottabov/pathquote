import type { ManagerConfig } from "@/lib/act/weekly-report";

// Who gets the Monday activity report, and who is copied on each one.
//
// `actUser` is the Act! display name exactly as in Tools -> Manage Users; it is
// matched exactly and the report goes to that user's Act! email. Set `to` only
// to send somewhere else. `cc` is per manager: each report is a separate email,
// so a manager never sees anyone else's numbers or anyone else's CC list.
//
// Changing this file is a commit and a deploy -- the timer runs the image built
// from HEAD, like the nightly sync (scripts/ops/pq-act-weekly-report.sh).

export const WEEKLY_REPORT_SENDER_NAME = "Pathfinder Marketing";

/** Where a manager's reply lands: the From address receives nothing. */
export const WEEKLY_REPORT_REPLY_TO = "marketing@pathfindercut.com";

const MONTE_KIMBALL = "monte@pathfindercut.com";
const JOHN_HOLLO = "john@pathfindercut.com";

export const WEEKLY_REPORT_MANAGERS: readonly ManagerConfig[] = [
  { actUser: "Brandon Clark", cc: [MONTE_KIMBALL, JOHN_HOLLO] },
  { actUser: "Chris Gilmartin", cc: [MONTE_KIMBALL, JOHN_HOLLO] },
  { actUser: "John Kyprianou", cc: [JOHN_HOLLO] },
];
