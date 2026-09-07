/**
 * The opaque credential a client uses to reach their quote.
 *
 * Pure by design: no database, no environment, no clock — the whole module
 * is `node:crypto` and nothing else, which is what keeps it testable under
 * the suite's no-database, no-mock rule (see vitest.config.ts).
 */
import { randomBytes, createHash } from "node:crypto";

/** 32 bytes = 256 bits. Enumeration is not a threat model at this width,
 * which is why no rate limiting is added on the signing route. */
export const SIGNING_TOKEN_BYTES = 32;

/** A fresh token, base64url so it is safe in a URL path segment without
 * escaping. Returned to the caller once, emailed, and never stored — only
 * `hashSigningToken` of it reaches the database. */
export function generateSigningToken(): string {
  return randomBytes(SIGNING_TOKEN_BYTES).toString("base64url");
}

/**
 * What `SigningRequest.tokenHash` stores, and the column the lookup runs
 * against. SHA-256 with no salt and no stretching is correct here and would
 * not be for a password: the input is 256 bits of uniform randomness, so
 * there is no dictionary to build and no cheaper attack than brute force.
 * The single fixed digest also lets the lookup be an indexed equality
 * match rather than a scan.
 */
export function hashSigningToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
