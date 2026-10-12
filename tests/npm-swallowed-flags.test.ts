import { describe, it, expect } from "vitest";
import {
  APPLY_SHORTHAND_KEYS,
  npmConfigKey,
  npmSwallowedApply,
  npmSwallowedFlag,
} from "../src/lib/npm-swallowed-flags";

/**
 * Every environment below was taken from a real `npm run` on npm 10.9.8 with
 * Node 22 -- the version the tools image runs -- on 2026-10-12, by printing
 * process.argv and every npm_config_* key from a throwaway script. The point of
 * copying them here rather than describing them is that the whole module is a
 * claim about what npm does, and a claim about an external tool is worth
 * pinning to its measurement.
 */

/** `npm run x --apply`. The four keys the letters a-p-p-l-y expand to. Note
 *  what is NOT here: npm_config_apply. */
const SWALLOWED_APPLY = {
  npm_config_all: "true",
  npm_config_parseable: "true",
  npm_config_long: "true",
  npm_config_yes: "true",
};

/** `npm run x -- --apply`, the correct form: argv gets the flag and npm leaves
 *  nothing behind. */
const PASSED_APPLY = {};

describe("npmSwallowedApply", () => {
  it("catches the shorthand expansion npm 10.9.8 actually produces", () => {
    expect(npmSwallowedApply(SWALLOWED_APPLY)).toBe(true);
  });

  it("catches an npm_config_apply another npm version may set instead", () => {
    expect(npmSwallowedApply({ npm_config_apply: "true" })).toBe(true);
  });

  it("does not fire on the correct `-- --apply` form", () => {
    // This is the one that matters: a guard that fires on the invocation it is
    // protecting is worse than no guard, because the operator learns to work
    // around it.
    expect(npmSwallowedApply(PASSED_APPLY)).toBe(false);
  });

  it("is not fooled by three of the four shorthand keys", () => {
    // npm_config_all on its own is the operator's own `--all`, which some
    // scripts have as a real flag. Only all four together are `--apply`.
    for (const key of APPLY_SHORTHAND_KEYS) {
      const partial = { ...SWALLOWED_APPLY, [key]: undefined };
      expect(npmSwallowedApply(partial)).toBe(false);
    }
  });

  it("treats a negated --no-apply as asking for the default, not as a mistake", () => {
    // Measured: `npm run x --no-apply` sets npm_config_apply to the empty
    // string, not "false". Either way it asks for report-only, which is the
    // default, so there is nothing to refuse.
    expect(npmSwallowedApply({ npm_config_apply: "" })).toBe(false);
    expect(npmSwallowedApply({ npm_config_apply: "false" })).toBe(false);
  });

  it("ignores an empty environment and unrelated npm keys", () => {
    expect(npmSwallowedApply({})).toBe(false);
    expect(npmSwallowedApply({ npm_config_loglevel: "warn", npm_config_cache: "/tmp" })).toBe(false);
  });
});

describe("npmConfigKey", () => {
  it("names the key npm uses for a flag it could not match", () => {
    expect(npmConfigKey("--include-inactive")).toBe("npm_config_include_inactive");
    expect(npmConfigKey("--dry-run")).toBe("npm_config_dry_run");
    expect(npmConfigKey("--full")).toBe("npm_config_full");
  });
});

describe("npmSwallowedFlag", () => {
  it("catches a swallowed dashed flag", () => {
    expect(npmSwallowedFlag({ npm_config_include_inactive: "true" }, "--include-inactive")).toBe(
      true,
    );
    expect(npmSwallowedFlag({ npm_config_dry_run: "true" }, "--dry-run")).toBe(true);
  });

  it("does not fire on the correct form, which sets nothing", () => {
    expect(npmSwallowedFlag({}, "--include-inactive")).toBe(false);
  });

  it("treats the negated form as asking for the default", () => {
    // Measured: both `--no-include-inactive` and `--include-inactive=false`
    // leave the key as the empty string.
    expect(npmSwallowedFlag({ npm_config_include_inactive: "" }, "--include-inactive")).toBe(false);
  });

  it("does not confuse one flag's key with another's", () => {
    expect(npmSwallowedFlag({ npm_config_dry_run: "true" }, "--include-inactive")).toBe(false);
  });

  it("does not catch --apply, which has no dash and does not land in its own key", () => {
    // The trap this module exists for. A caller reaching for the generic
    // function to check --apply would get `false` on the very environment the
    // mistake produces, which is what three shipped guards did.
    expect(npmSwallowedFlag(SWALLOWED_APPLY, "--apply")).toBe(false);
    expect(npmSwallowedApply(SWALLOWED_APPLY)).toBe(true);
  });
});
