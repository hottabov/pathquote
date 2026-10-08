import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `visibleCountries` reaches `session.user` through four hand-written hops:
 * the `jwt` callback (twice: first sign-in and revalidation), the `session`
 * callback, and the NextAuth type augmentations. Miss one and nothing fails
 * loudly: the field is optional on `ScopeUser`, so it arrives undefined, the
 * filter reads that as no grant, and a manager sees an empty client list with
 * no error anywhere. Fail-closed is the right default and a terrible way to
 * find out.
 *
 * `regionId` takes exactly the same path, so the check is parity with it: every
 * place `regionId` is carried, `visibleCountries` must be carried too. This
 * reads files rather than running the callbacks because src/auth.ts imports the
 * database and this suite has none.
 */
function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("visibleCountries follows regionId through src/auth.ts", () => {
  const auth = readFileSync("src/auth.ts", "utf8");

  it("is written to the token wherever regionId is", () => {
    const regionWrites = count(auth, /token\.regionId\s*=/g);
    expect(regionWrites).toBe(2);
    expect(count(auth, /token\.visibleCountries\s*=/g)).toBe(regionWrites);
  });

  it("is copied onto the session wherever regionId is", () => {
    const regionCopies = count(auth, /session\.user\.regionId\s*=/g);
    expect(regionCopies).toBe(1);
    expect(count(auth, /session\.user\.visibleCountries\s*=/g)).toBe(regionCopies);
  });

  it("is read from the database user, not from the token it is replacing", () => {
    expect(count(auth, /token\.visibleCountries\s*=\s*dbUser\.visibleCountries/g)).toBe(2);
  });
});

describe("visibleCountries is declared wherever regionId is in src/types/next-auth.d.ts", () => {
  const types = readFileSync("src/types/next-auth.d.ts", "utf8");

  it("has one declaration per regionId declaration", () => {
    const regionDeclarations = count(types, /^\s*regionId\??:/gm);
    // next-auth: Session + User; next-auth/jwt: JWT; @auth/core/types:
    // Session + User; @auth/core/jwt: JWT.
    expect(regionDeclarations).toBe(6);
    expect(count(types, /^\s*visibleCountries\??:/gm)).toBe(regionDeclarations);
  });

  it("declares it required on the session user and the token, optional on User", () => {
    expect(count(types, /^\s*visibleCountries: string\[\];/gm)).toBe(4);
    expect(count(types, /^\s*visibleCountries\?: string\[\];/gm)).toBe(2);
  });
});

// The client page memoises its lookup on primitives (React's `cache` compares
// by identity), so the grant has to be passed through that memo as a primitive
// too. Dropping it would fail closed: the clients list shows a manager their
// countries' clients and every one of them 404s when opened.
describe("visibleCountries survives the client page's memo in src/lib/queries/clients.ts", () => {
  const queries = readFileSync("src/lib/queries/clients.ts", "utf8");

  it("is handed to the memoised lookup", () => {
    expect(queries).toMatch(/countriesKey\(user\.visibleCountries\)/);
  });

  it("is rebuilt onto the ScopeUser the filter reads", () => {
    expect(queries).toMatch(/visibleCountries:\s*countriesFromKey\(countries\)/);
  });
});
