import { describe, it, expect } from "vitest";
import {
  describeDatabase,
  formatBanner,
  parseActSyncArgs,
  type ActSyncArgs,
} from "../src/lib/act/cli-args";

function ok(argv: string[], env: Record<string, string | undefined> = {}): ActSyncArgs {
  const result = parseActSyncArgs(argv, env);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.args;
}

function error(argv: string[], env: Record<string, string | undefined> = {}): string {
  const result = parseActSyncArgs(argv, env);
  if (result.ok) throw new Error("expected an error");
  return result.error;
}

describe("parseActSyncArgs", () => {
  it("defaults to a delta write with no limit", () => {
    expect(ok([])).toEqual({ full: false, dryRun: false, limit: undefined });
  });

  it("accepts the three flags", () => {
    expect(ok(["--full"])).toEqual({ full: true, dryRun: false, limit: undefined });
    expect(ok(["--dry-run"])).toEqual({ full: false, dryRun: true, limit: undefined });
    expect(ok(["--dry-run", "--full", "--limit", "50"])).toEqual({
      full: true,
      dryRun: true,
      limit: 50,
    });
  });

  it("accepts --limit as two tokens or with =", () => {
    expect(ok(["--limit", "200"]).limit).toBe(200);
    expect(ok(["--limit=200"]).limit).toBe(200);
    expect(ok(["--limit=200", "--dry-run"]).dryRun).toBe(true);
  });

  it("refuses a misspelled flag instead of running without it", () => {
    // The case that matters: `--dryrun` must not become a production write.
    const message = error(["--dryrun"]);
    expect(message).toContain('unknown argument "--dryrun"');
    expect(message).toContain("--full, --dry-run, --limit");
  });

  it("refuses every other unknown argument", () => {
    expect(error(["--dry-run", "--verbose"])).toContain('"--verbose"');
    expect(error(["200"])).toContain('"200"');
    expect(error(["-n", "5"])).toContain('"-n"');
    expect(error(["--full=true"])).toContain('"--full=true"');
    expect(error(["--limitless"])).toContain('"--limitless"');
    expect(error(["--limit-5"])).toContain('"--limit-5"');
  });

  it("refuses a --limit with no usable value", () => {
    expect(error(["--limit"])).toContain("got nothing");
    expect(error(["--limit="])).toContain('got ""');
    expect(error(["--limit=abc"])).toContain('"abc"');
    expect(error(["--limit", "abc"])).toContain('"abc"');
    expect(error(["--limit", "0"])).toContain("positive whole number");
    expect(error(["--limit=0"])).toContain("positive whole number");
    expect(error(["--limit", "-5"])).toContain("positive whole number");
    expect(error(["--limit=-5"])).toContain("positive whole number");
    expect(error(["--limit", "1.5"])).toContain("positive whole number");
    expect(error(["--limit", "1e3"])).toContain("positive whole number");
    expect(error(["--limit", "99999999999999999999"])).toContain("positive whole number");
  });

  it("does not take the next flag as the value of --limit", () => {
    expect(error(["--limit", "--dry-run"])).toContain('"--dry-run"');
  });

  it("refuses --limit given twice, since the later one would silently win", () => {
    expect(error(["--limit", "5", "--limit=10"])).toContain("more than once");
  });

  it("names the accepted set in every refusal", () => {
    for (const argv of [["--nope"], ["--limit"], ["--limit", "0"], ["--limit", "5", "--limit", "6"]]) {
      expect(error(argv)).toContain("Accepted: --full, --dry-run, --limit N (or --limit=N)");
    }
  });

  describe("flags npm kept for itself", () => {
    // `npm run act:sync --dry-run` hands the script no arguments at all, and
    // leaves only npm_config_dry_run in the environment.
    it("refuses when npm swallowed --dry-run", () => {
      expect(error([], { npm_config_dry_run: "true" })).toContain("npm swallowed --dry-run");
    });

    it("refuses when npm swallowed --limit or --full", () => {
      expect(error([], { npm_config_limit: "200" })).toContain("npm swallowed --limit");
      expect(error([], { npm_config_full: "true" })).toContain("npm swallowed --full");
    });

    it("does not object when the flag also arrived properly", () => {
      expect(ok(["--dry-run"], { npm_config_dry_run: "true" }).dryRun).toBe(true);
      expect(ok(["--limit", "5"], { npm_config_limit: "5" }).limit).toBe(5);
    });

    it("ignores an npm setting that is switched off", () => {
      expect(ok([], { npm_config_dry_run: "false" })).toEqual({
        full: false,
        dryRun: false,
        limit: undefined,
      });
    });
  });
});

describe("describeDatabase", () => {
  it("reports host, port and database name", () => {
    expect(describeDatabase("postgresql://pathquote:s3cret@db.internal:5433/pathquote")).toEqual({
      host: "db.internal",
      port: "5433",
      name: "pathquote",
    });
  });

  it("assumes the postgres port when the URL has none", () => {
    expect(describeDatabase("postgres://u:p@localhost/pathquote_dev")).toEqual({
      host: "localhost",
      port: "5432",
      name: "pathquote_dev",
    });
  });

  it("ignores query parameters", () => {
    expect(describeDatabase("postgresql://u:p@h:5432/db?schema=public&sslmode=require")?.name).toBe(
      "db",
    );
  });

  it("never lets the password or username into what it returns", () => {
    const target = describeDatabase("postgresql://admin:hunter2-Pa55@db.internal:5432/pathquote");
    const everything = JSON.stringify(target);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("Pa55");
    expect(everything).not.toContain("admin");
  });

  it("copes with an @ inside the password", () => {
    expect(describeDatabase("postgresql://u:p%40ss@host:5432/db")?.host).toBe("host");
    expect(describeDatabase("postgresql://u:p@ss@host:5432/db")?.host).toBe("host");
  });

  it("returns null rather than guess when the URL does not parse cleanly", () => {
    expect(describeDatabase(undefined)).toBeNull();
    expect(describeDatabase("")).toBeNull();
    expect(describeDatabase("not a url")).toBeNull();
    expect(describeDatabase("mysql://u:p@h:3306/db")).toBeNull();
    expect(describeDatabase("postgresql://u:p@h:5432")).toBeNull();
    expect(describeDatabase("postgresql:///db")).toBeNull();
    // An unescaped "/" in a password moves the host/path boundary; reporting
    // whatever lands where would print part of the password as a host.
    expect(describeDatabase("postgresql://u:1234/ab@h:5432/db")).toBeNull();
    expect(describeDatabase("postgresql://u:ab/cd@h:5432/db")).toBeNull();
  });
});

describe("formatBanner", () => {
  const db = { host: "db.example.com", port: "5432", name: "pathquote" };

  it("says WRITE for a write run and dry run for a dry run", () => {
    const write = formatBanner({ full: false, dryRun: false, limit: undefined }, db);
    const dry = formatBanner({ full: false, dryRun: true, limit: undefined }, db);
    expect(write).toContain("mode      WRITE");
    expect(dry).toContain("mode      dry run");
    expect(dry).not.toContain("WRITE");
  });

  it("names the limit, or says there is none", () => {
    expect(formatBanner({ full: false, dryRun: false, limit: 200 }, db)).toContain(
      "limit     200 contacts",
    );
    expect(formatBanner({ full: false, dryRun: false, limit: undefined }, db)).toContain(
      "limit     none",
    );
  });

  it("names the database and nothing that identifies a login", () => {
    const banner = formatBanner({ full: true, dryRun: false, limit: undefined }, db);
    expect(banner).toContain("database  db.example.com:5432/pathquote");
    expect(banner).toContain("--full");
  });
});
