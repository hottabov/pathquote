import { describe, it, expect } from "vitest";
import { STATUS_TONE } from "../src/components/ui-kit/status-badge";
import { ROLE_VALUES } from "../src/lib/roles";

/**
 * `STATUS_TONE` is a `Record<string, StatusTone>` shared between roles and
 * document/signing statuses, and deliberately partial — so a role with no
 * entry compiles fine and renders an unstyled pill. `StatusBadge` now
 * defaults a missing tone to "slate", which stops that being *broken*, but a
 * role silently wearing the fallback grey instead of its own colour is still
 * wrong and still invisible to the type system.
 *
 * This is the cheap structural guard: it imports the map, not the component,
 * so it runs in the node environment in milliseconds with no React and no
 * database. Adding a fifth role without giving it a tone fails here.
 */
describe("STATUS_TONE role coverage", () => {
  it.each(ROLE_VALUES)("has an entry for %s", (role) => {
    expect(STATUS_TONE[role]).toBeDefined();
  });
});
