import { describe, it, expect } from "vitest";
import { formatPreflightBanner, parsePreflightArgs } from "../src/lib/act/preflight-args";

describe("parsePreflightArgs", () => {
  it("defaults to report-only", () => {
    expect(parsePreflightArgs([])).toEqual({ ok: true, args: { apply: false } });
  });

  it("accepts --apply", () => {
    expect(parsePreflightArgs(["--apply"])).toEqual({ ok: true, args: { apply: true } });
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    for (const flag of ["--dry-run", "--force", "--yes", "--apply=true", "-a", "apply", ""]) {
      const result = parsePreflightArgs([flag]);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an unknown flag even beside a valid --apply", () => {
    // A run that carries on past a flag it did not understand is a run that does
    // not do what its author thinks.
    expect(parsePreflightArgs(["--apply", "--limit", "5"]).ok).toBe(false);
    expect(parsePreflightArgs(["--full", "--apply"]).ok).toBe(false);
  });

  it("names what is accepted in the error", () => {
    const result = parsePreflightArgs(["--dry-run"]);
    if (result.ok) throw new Error("expected an error");
    expect(result.error).toContain('"--dry-run"');
    expect(result.error).toContain("--apply");
  });

  it("refuses the environment `npm run act:sync-preflight --apply` really leaves", () => {
    // This is the regression. npm 10.9.8 cannot match the word `apply` to an
    // option of its own, reads a-p-p-l-y as single-letter shorthands, and sets
    // --all, --parseable, --long and --yes instead. It never sets
    // npm_config_apply, which is the only key this function used to check -- so
    // the guard written to catch exactly this mistake could not fire, and
    // `npm run act:sync-preflight --apply` printed a report and exited 0 while
    // the operator read that as proof the write had happened.
    const result = parsePreflightArgs([], {
      npm_config_all: "true",
      npm_config_parseable: "true",
      npm_config_long: "true",
      npm_config_yes: "true",
    });
    if (result.ok) throw new Error("expected an error");
    expect(result.error).toContain("swallowed --apply");
    expect(result.error).toContain("npm run act:sync-preflight -- --apply");
  });

  it("still refuses an npm_config_apply another npm version may set", () => {
    const result = parsePreflightArgs([], { npm_config_apply: "true" });
    if (result.ok) throw new Error("expected an error");
    expect(result.error).toContain("swallowed --apply");
  });

  it("does not mistake a passed --apply for a swallowed one", () => {
    expect(parsePreflightArgs(["--apply"], { npm_config_apply: "true" })).toEqual({
      ok: true,
      args: { apply: true },
    });
    expect(
      parsePreflightArgs(["--apply"], {
        npm_config_all: "true",
        npm_config_parseable: "true",
        npm_config_long: "true",
        npm_config_yes: "true",
      }),
    ).toEqual({ ok: true, args: { apply: true } });
  });

  it("does not fire on the correct `-- --apply`, which leaves no npm_config_* at all", () => {
    // Measured: the correct form sets none of these keys, so neither check can
    // fire on the invocation it is protecting.
    expect(parsePreflightArgs(["--apply"], {})).toEqual({ ok: true, args: { apply: true } });
  });

  it("ignores unrelated npm environment", () => {
    expect(parsePreflightArgs([], { npm_config_apply: undefined, npm_config_loglevel: "warn" }).ok).toBe(
      true,
    );
  });
});

describe("formatPreflightBanner", () => {
  const database = { host: "db.example.test", port: "5432", name: "pathquote" };

  it("names report-only mode and the database", () => {
    const banner = formatPreflightBanner({ apply: false }, database);
    expect(banner).toContain("report only -- writes nothing");
    expect(banner).toContain("db.example.test:5432/pathquote");
    expect(banner).not.toContain("APPLY");
  });

  it("names apply mode and the database", () => {
    const banner = formatPreflightBanner({ apply: true }, database);
    expect(banner).toContain("APPLY");
    expect(banner).toContain("db.example.test:5432/pathquote");
    expect(banner).not.toContain("writes nothing");
  });
});
