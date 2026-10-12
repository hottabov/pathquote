import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  ALERT_REARM_LINE,
  drainExitStatus,
  drainRearmsAlert,
  formatDrainBanner,
  parseActDrainArgs,
} from "../src/lib/act/drain-args";

describe("parseActDrainArgs", () => {
  it("drains every due row when given nothing: what the timer runs", () => {
    expect(parseActDrainArgs([])).toEqual({ ok: true, args: { documentId: undefined } });
  });

  it("takes one quote's id, in either spelling", () => {
    const id = "cmg8x2k4f0001qz9h3v7b5n1a";
    expect(parseActDrainArgs(["--document", id])).toEqual({ ok: true, args: { documentId: id } });
    expect(parseActDrainArgs([`--document=${id}`])).toEqual({ ok: true, args: { documentId: id } });
  });

  it("refuses an id that is not one, rather than draining nothing in silence", () => {
    // A quote number is the likeliest mistake: it matches no row's
    // documentId, and the pass would report "nothing due".
    for (const argv of [["--document"], ["--document", "--x"], ["--document="], ["--document", "Q-AU-2026-001"]]) {
      const parsed = parseActDrainArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain("--document needs the quote's id");
    }
  });

  it("refuses anything else, and the same flag twice", () => {
    expect(parseActDrainArgs(["--dry-run"])).toMatchObject({ ok: false });
    expect(parseActDrainArgs(["abc"])).toMatchObject({ ok: false });
    expect(parseActDrainArgs(["--document", "a1", "--document", "b2"])).toMatchObject({ ok: false });
  });

  it("refuses a --document npm swallowed, which would have drained every due row", () => {
    // `npm run act:drain --document=abc`, no `--`: npm keeps it, and the
    // script starts with no arguments at all.
    const parsed = parseActDrainArgs([], { npm_config_document: "abc" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("npm run act:drain -- --document");
    // A bare `--document` leaves "true".
    expect(parseActDrainArgs([], { npm_config_document: "true" }).ok).toBe(false);
    // Typed both ways is odd but not ambiguous: the script got the flag.
    expect(parseActDrainArgs(["--document", "abc"], { npm_config_document: "abc" }).ok).toBe(true);
    // `--no-document` leaves the empty string, which asks for the default.
    expect(parseActDrainArgs([], { npm_config_document: "" }).ok).toBe(true);
  });
});

describe("formatDrainBanner", () => {
  const db = { host: "db.example.com", port: "5432", name: "pathquote" };

  it("says it writes to ACT!, which rows, and which database", () => {
    const every = formatDrainBanner({ documentId: undefined }, db);
    expect(every).toContain("mode      WRITE -- sends queued quotes to ACT! if sending is on");
    expect(every).toContain("rows      every due row");
    expect(every).toContain("database  db.example.com:5432/pathquote");
    expect(formatDrainBanner({ documentId: "abc123" }, db)).toContain("rows      only quote abc123's");
  });
});

describe("drainExitStatus", () => {
  // The unit runs every 15 minutes and every failure starts the alert (which
  // emails once a day of a failure that goes on), so it fails only for what
  // needs a person.
  it("is 0 for every outcome that clears itself or is nobody's fault", () => {
    expect(drainExitStatus({ status: "ran", stopCause: null })).toBe(0);
    expect(drainExitStatus({ status: "busy", stopCause: null })).toBe(0);
    expect(drainExitStatus({ status: "switched-off", stopCause: null })).toBe(0);
    expect(drainExitStatus({ status: "out-of-time", stopCause: null })).toBe(0);
    expect(drainExitStatus({ status: "stopped", stopCause: "unavailable" })).toBe(0);
  });

  it("is 1 for a pass stopped by a fault that will not mend itself", () => {
    expect(drainExitStatus({ status: "stopped", stopCause: "setup" })).toBe(1);
    // A stop with no cause should not happen; failing is the side to err on.
    expect(drainExitStatus({ status: "stopped", stopCause: null })).toBe(1);
  });
});

describe("drainRearmsAlert, and the line pq-act-drain.sh looks for", () => {
  const pass = (overrides: Partial<Parameters<typeof drainRearmsAlert>[0]> = {}) => ({
    status: "ran" as const,
    stopCause: null,
    stepsWritten: 0,
    ...overrides,
  });

  it("re-arms the alert only after a pass that ACT! took writes from", () => {
    expect(drainRearmsAlert(pass({ stepsWritten: 3 }))).toBe(true);
    expect(drainRearmsAlert(pass({ status: "out-of-time", stepsWritten: 40 }))).toBe(true);
  });

  it("does not re-arm on an exit 0 that asked ACT! nothing", () => {
    // While a fault stands its row backs off further each time, so ticks in
    // between find nothing due; at 03:00 a tick finds the nightly sync busy.
    // Re-armed by those, the alert would email at each failure after them.
    expect(drainRearmsAlert(pass())).toBe(false);
    expect(drainRearmsAlert(pass({ status: "busy" }))).toBe(false);
    expect(drainRearmsAlert(pass({ status: "switched-off" }))).toBe(false);
    expect(drainRearmsAlert(pass({ status: "stopped", stopCause: "unavailable" }))).toBe(false);
  });

  it("never re-arms on a pass that fails its unit, whatever it wrote first", () => {
    expect(drainRearmsAlert(pass({ status: "stopped", stopCause: "setup", stepsWritten: 5 }))).toBe(false);
  });

  it("is the very line pq-act-drain.sh greps for", () => {
    // The two are a contract across a language boundary; this is the only
    // thing that fails if one changes without the other.
    const script = readFileSync(path.join(__dirname, "../scripts/ops/pq-act-drain.sh"), "utf8");
    expect(script).toContain(`grep -qxF "${ALERT_REARM_LINE}" "$OUT"`);
  });
});
