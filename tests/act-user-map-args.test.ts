import { describe, it, expect } from "vitest";
import {
  USER_MAP_ACCEPTED_ARGS,
  formatUserMapBanner,
  parseUserMapArgs,
} from "../src/lib/act/user-map-args";

const DATABASE = { host: "db", port: 5432, name: "pathquote" };

/** What npm puts in the environment for `npm run act:map-users --apply` on npm
 *  10.9.8: it cannot match the word, so it reads a-p-p-l-y as single-letter
 *  shorthands. Measured 2026-10-12, Node 22. */
const SWALLOWED_APPLY = {
  npm_config_all: "true",
  npm_config_parseable: "true",
  npm_config_long: "true",
  npm_config_yes: "true",
};

function args(argv: string[], env: Record<string, string | undefined> = {}) {
  const parsed = parseUserMapArgs(argv, env);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.args;
}

function error(argv: string[], env: Record<string, string | undefined> = {}) {
  const parsed = parseUserMapArgs(argv, env);
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error;
}

describe("parseUserMapArgs", () => {
  it("defaults to a report that writes nothing", () => {
    expect(args([])).toEqual({ apply: false, includeInactive: false });
  });

  it("takes --apply and --include-inactive, in either order", () => {
    expect(args(["--apply"])).toEqual({ apply: true, includeInactive: false });
    expect(args(["--include-inactive"])).toEqual({ apply: false, includeInactive: true });
    expect(args(["--apply", "--include-inactive"])).toEqual({ apply: true, includeInactive: true });
    expect(args(["--include-inactive", "--apply"])).toEqual({ apply: true, includeInactive: true });
  });

  it("refuses anything it does not understand, and says what it takes", () => {
    const message = error(["--force"]);
    expect(message).toContain('"--force"');
    expect(message).toContain(USER_MAP_ACCEPTED_ARGS);
    expect(error(["--apply=yes"])).toContain("--apply=yes");
    expect(error(["-a"])).toContain("-a");
    expect(error([""])).toContain('""');
  });

  describe("a flag npm swallowed", () => {
    it("refuses when --apply was written without a bare --", () => {
      const message = error([], SWALLOWED_APPLY);
      expect(message).toContain("npm swallowed --apply");
      expect(message).toContain("npm run act:map-users -- --apply");
    });

    it("refuses when --include-inactive was written without a bare --", () => {
      const message = error([], { npm_config_include_inactive: "true" });
      expect(message).toContain("npm swallowed --include-inactive");
    });

    it("names both when both were swallowed", () => {
      const message = error([], { ...SWALLOWED_APPLY, npm_config_include_inactive: "true" });
      expect(message).toContain("--apply and --include-inactive");
      expect(message).toContain("them");
    });

    it("also catches the npm_config_apply other npm versions may set", () => {
      expect(error([], { npm_config_apply: "true" })).toContain("npm swallowed --apply");
    });

    it("does not fire on the correct invocation, which sets none of those", () => {
      // `npm run act:map-users -- --apply --include-inactive` passes the flags
      // through and leaves nothing behind in the environment. A guard that
      // fired here would make the script unusable.
      expect(args(["--apply", "--include-inactive"], {})).toEqual({
        apply: true,
        includeInactive: true,
      });
    });

    it("does not fire on a flag that arrived in argv as well", () => {
      // Odd to type both ways, but not ambiguous: the script got the flag.
      expect(args(["--apply"], SWALLOWED_APPLY)).toEqual({ apply: true, includeInactive: false });
      expect(args(["--include-inactive"], { npm_config_include_inactive: "true" })).toEqual({
        apply: false,
        includeInactive: true,
      });
    });

    it("needs all four shorthands together, not one of them", () => {
      // npm_config_all alone is `npm run act:map-users --all`, which is not a
      // swallowed --apply and must not be read as one.
      for (const name of Object.keys(SWALLOWED_APPLY)) {
        expect(args([], { [name]: "true" })).toEqual({ apply: false, includeInactive: false });
      }
      const three = { ...SWALLOWED_APPLY, npm_config_yes: undefined };
      expect(args([], three)).toEqual({ apply: false, includeInactive: false });
    });

    it("ignores a config value that is not exactly \"true\"", () => {
      expect(args([], { npm_config_include_inactive: "false" })).toEqual({
        apply: false,
        includeInactive: false,
      });
      expect(args([], { npm_config_apply: "" })).toEqual({ apply: false, includeInactive: false });
    });
  });
});

describe("formatUserMapBanner", () => {
  it("says report-only, and how to write, when nothing was asked for", () => {
    const banner = formatUserMapBanner({ apply: false, includeInactive: false }, DATABASE);
    expect(banner).toContain("report only");
    expect(banner).toContain("add --apply to write");
    expect(banner).toContain("held back");
  });

  it("names both columns APPLY writes, and claims nothing beyond them", () => {
    const banner = formatUserMapBanner({ apply: true, includeInactive: false }, DATABASE);
    expect(banner).toContain("APPLY");
    expect(banner).toContain("User.actUserId");
    expect(banner).toContain("User.actAccountMgr");
    expect(banner).toContain("nothing else");
  });

  it("says when the inactive matches are included", () => {
    expect(formatUserMapBanner({ apply: true, includeInactive: true }, DATABASE)).toContain(
      "included",
    );
  });

  it("names the database without a password", () => {
    const banner = formatUserMapBanner({ apply: true, includeInactive: false }, DATABASE);
    expect(banner).toContain("db:5432/pathquote");
    expect(banner).not.toContain("://");
  });
});
