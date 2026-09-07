# Quote Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager sign a finalized quote, email it to the client, and let the client sign it back electronically — producing an archived, hash-verified signed PDF.

**Architecture:** All decidable logic lives in pure modules under `src/lib/signing/` (token generation, state transitions, link liveness); server actions are thin wrappers that call them. The client-facing page is a public route group `(sign)` outside NextAuth, reached by a hashed opaque token, rendering the same `QuotationSheet` component the PDF pipeline already uses.

**Tech Stack:** Next.js 16 (App Router, `proxy.ts`), Prisma 7 + PostgreSQL, NextAuth v5, Vitest, Gotenberg (via `src/lib/pdf.ts`), Nodemailer/Resend, `signature_pad`.

**Design spec:** `docs/superpowers/specs/2026-09-07-quote-signing-design.md`

---

## Testing constraints — read before writing any test

`vitest.config.ts` sets `isolate: false` and documents why:

> This is only safe because the suite has no per-file module state to protect: it uses no `vi.mock`, no `vi.fn`, no fake timers, no network and no database — every test imports pure functions and asserts on their return values.

**Therefore, in this plan:**

- Never write `vi.mock`, `vi.fn`, fake timers, a database call, or a network call in a test.
- Anything needing a decision gets extracted into a pure function under `src/lib/signing/` and tested there.
- Guard rails against future mistakes are written as **static source analysis**, reading files with `node:fs` — the pattern established by `tests/scope-coverage.test.ts`.
- Server actions and route handlers are deliberately thin and are **not** unit tested. Their logic lives in the pure modules that are.

Run the suite with `npm test`. Type-check with `npm run typecheck`.

## File structure

**New — pure logic (fully unit tested):**

| File | Responsibility |
|---|---|
| `src/lib/signing/token.ts` | Generate an opaque token; hash it for storage |
| `src/lib/signing/state.ts` | Document-side transition rules: may we send, revoke, unfinalize, complete, decline |
| `src/lib/signing/link.ts` | Request-side liveness: is this link live, expired, revoked, declined, completed |
| `src/lib/email/signing.ts` | Four email templates as pure functions |

**New — data access:**

| File | Responsibility |
|---|---|
| `src/lib/queries/signing.ts` | `getDocumentForSigning(tokenHash)` — the narrow, commission-free select |
| `src/lib/actions/signing.ts` | Manager actions: sign as author, send, revoke |
| `src/lib/actions/signing-client.ts` | Unauthenticated client actions: sign, complete, decline |

**New — UI:**

| File | Responsibility |
|---|---|
| `src/components/signing/signature-pad.tsx` | The canvas wrapper around `signature_pad` |
| `src/components/signing/signature-dialog.tsx` | Responsive shell: full-screen on mobile, dialog on desktop |
| `src/components/signing/client-action-bar.tsx` | The sticky Sign / Print / Send bar |
| `src/app/(sign)/layout.tsx` | Public layout — no nav, no `auth()` |
| `src/app/(sign)/sign/[token]/page.tsx` | The client-facing quote |
| `src/app/(sign)/sign/[token]/pdf/route.ts` | PDF for the client (live before completion, archived after) |

**Modified:**

| File | Change |
|---|---|
| `prisma/schema.prisma` | `SigningStatus`, `SignerRole`, `Signature`, `SigningRequest`, `Document.*`, `User.signatureUrl` |
| `src/proxy.ts` | Add `/sign` to `PUBLIC_PATHS` |
| `src/lib/validation/settings.ts` | `signing.linkValidityDays` key + schema |
| `src/lib/queries/settings.ts` | `getSigningLinkValidityDays()` |
| `src/lib/actions/settings.ts` | New case in `updateSetting` |
| `src/lib/actions/finalize.ts` | Block unfinalize at SIGNED; clear signing state otherwise |
| `src/lib/quotation-data.ts` | Carry signature images into `QuotationData` |
| `src/components/sheet/sections/signatures.tsx` | Render actual signatures |
| `src/components/sheet/sheet-css.ts` | Styles for a filled signature block |

---

## Phase 1 — Pure foundations

### Task 1: Signing tokens

**Files:**
- Create: `src/lib/signing/token.ts`
- Test: `tests/signing-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/signing-token.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  generateSigningToken,
  hashSigningToken,
  SIGNING_TOKEN_BYTES,
} from "../src/lib/signing/token";

describe("generateSigningToken", () => {
  it("produces a base64url string with no padding or URL-unsafe characters", () => {
    const token = generateSigningToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("encodes SIGNING_TOKEN_BYTES bytes of entropy", () => {
    // base64url of 32 bytes is 43 characters once padding is dropped.
    expect(SIGNING_TOKEN_BYTES).toBe(32);
    expect(generateSigningToken()).toHaveLength(43);
  });

  it("never repeats across a large sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateSigningToken());
    expect(seen.size).toBe(1000);
  });
});

describe("hashSigningToken", () => {
  it("returns a 64-character lowercase hex sha256 digest", () => {
    expect(hashSigningToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for the same input", () => {
    const token = generateSigningToken();
    expect(hashSigningToken(token)).toBe(hashSigningToken(token));
  });

  it("differs for different inputs", () => {
    expect(hashSigningToken("a")).not.toBe(hashSigningToken("b"));
  });

  it("matches the known sha256 of a fixed string", () => {
    expect(hashSigningToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/signing-token.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/signing/token"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/signing/token.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/signing-token.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/signing/token.ts tests/signing-token.test.ts
git commit -m "feat: opaque signing tokens, stored only as a hash"
```

---

### Task 2: Document-side transition rules

**Files:**
- Create: `src/lib/signing/state.ts`
- Test: `tests/signing-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/signing-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  canSendToClient,
  canRevoke,
  canUnfinalize,
  canComplete,
  canDecline,
  statusAfterView,
  NO_AUTHOR_SIGNATURE,
  NOT_FINAL,
  NO_CONTACT_EMAIL,
  ALREADY_IN_FLIGHT,
  SIGNED_IS_FINAL,
} from "../src/lib/signing/state";

const sendable = {
  documentStatus: "FINAL" as const,
  signingStatus: "NOT_SENT" as const,
  hasAuthorSignature: true,
  contactEmail: "client@example.com",
};

describe("canSendToClient", () => {
  it("allows a FINAL, author-signed document with a contact email", () => {
    expect(canSendToClient(sendable)).toEqual({ ok: true });
  });

  it("refuses a DRAFT document", () => {
    expect(canSendToClient({ ...sendable, documentStatus: "DRAFT" })).toEqual({
      ok: false,
      reason: NOT_FINAL,
    });
  });

  it("refuses when the author has not signed", () => {
    expect(canSendToClient({ ...sendable, hasAuthorSignature: false })).toEqual({
      ok: false,
      reason: NO_AUTHOR_SIGNATURE,
    });
  });

  it("refuses when the contact has no email", () => {
    expect(canSendToClient({ ...sendable, contactEmail: null })).toEqual({
      ok: false,
      reason: NO_CONTACT_EMAIL,
    });
    expect(canSendToClient({ ...sendable, contactEmail: "   " })).toEqual({
      ok: false,
      reason: NO_CONTACT_EMAIL,
    });
  });

  it("refuses when a link is already outstanding", () => {
    for (const signingStatus of ["SENT", "VIEWED"] as const) {
      expect(canSendToClient({ ...sendable, signingStatus })).toEqual({
        ok: false,
        reason: ALREADY_IN_FLIGHT,
      });
    }
  });

  it("refuses a signed document", () => {
    expect(canSendToClient({ ...sendable, signingStatus: "SIGNED" })).toEqual({
      ok: false,
      reason: SIGNED_IS_FINAL,
    });
  });

  it("allows resending after a decline", () => {
    expect(canSendToClient({ ...sendable, signingStatus: "DECLINED" })).toEqual({ ok: true });
  });
});

describe("canRevoke", () => {
  it("is allowed only while a link is outstanding", () => {
    expect(canRevoke("SENT")).toBe(true);
    expect(canRevoke("VIEWED")).toBe(true);
    expect(canRevoke("NOT_SENT")).toBe(false);
    expect(canRevoke("SIGNED")).toBe(false);
    expect(canRevoke("DECLINED")).toBe(false);
  });
});

describe("canUnfinalize", () => {
  it("refuses a signed document and says why", () => {
    expect(canUnfinalize("SIGNED")).toEqual({ ok: false, reason: SIGNED_IS_FINAL });
  });

  it("allows every other state", () => {
    for (const status of ["NOT_SENT", "SENT", "VIEWED", "DECLINED"] as const) {
      expect(canUnfinalize(status)).toEqual({ ok: true });
    }
  });
});

describe("canComplete", () => {
  it("requires an outstanding link and a client signature", () => {
    expect(canComplete("VIEWED", true)).toBe(true);
    expect(canComplete("SENT", true)).toBe(true);
    expect(canComplete("VIEWED", false)).toBe(false);
    expect(canComplete("SIGNED", true)).toBe(false);
    expect(canComplete("DECLINED", true)).toBe(false);
    expect(canComplete("NOT_SENT", true)).toBe(false);
  });
});

describe("canDecline", () => {
  it("stays available after the client has drawn a signature", () => {
    expect(canDecline("VIEWED")).toBe(true);
    expect(canDecline("SENT")).toBe(true);
  });

  it("is unavailable once completed or already declined", () => {
    expect(canDecline("SIGNED")).toBe(false);
    expect(canDecline("DECLINED")).toBe(false);
    expect(canDecline("NOT_SENT")).toBe(false);
  });
});

describe("statusAfterView", () => {
  it("promotes SENT to VIEWED", () => {
    expect(statusAfterView("SENT")).toBe("VIEWED");
  });

  it("leaves every other status untouched", () => {
    for (const status of ["VIEWED", "SIGNED", "DECLINED", "NOT_SENT"] as const) {
      expect(statusAfterView(status)).toBe(status);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/signing-state.test.ts`
Expected: FAIL — cannot resolve `../src/lib/signing/state`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/signing/state.ts`:

```ts
/**
 * Every "may this happen?" question the signing feature asks, as pure
 * functions over plain values.
 *
 * The server actions in src/lib/actions/signing.ts and signing-client.ts
 * are deliberately thin wrappers around these: the actions know how to read
 * and write rows, this module knows the rules, and only this module is unit
 * tested (the suite has no database — see vitest.config.ts).
 *
 * `SigningStatus` is re-declared here as a string union rather than
 * imported from `@prisma/client` so the module stays free of generated
 * types and can be imported by tests without a `prisma generate` having
 * run. The two are kept in step by `tests/signing-status-parity.test.ts`.
 */
export type SigningStatus = "NOT_SENT" | "SENT" | "VIEWED" | "SIGNED" | "DECLINED";

export type Verdict = { ok: true } | { ok: false; reason: string };

export const NOT_FINAL = "Finalize the quote before signing it.";
export const NO_AUTHOR_SIGNATURE = "Sign the quote before sending it.";
export const NO_CONTACT_EMAIL = "This quote's contact has no email address.";
export const ALREADY_IN_FLIGHT = "This quote is already with the client. Revoke the link first.";
export const SIGNED_IS_FINAL = "A signed quote cannot be reopened. Create a new quote instead.";

/** A link is outstanding: sent, and neither completed nor declined. */
function isInFlight(status: SigningStatus): boolean {
  return status === "SENT" || status === "VIEWED";
}

/**
 * The three preconditions for emailing a quote to its client, checked in a
 * fixed order so the message a manager sees names the first thing to fix
 * rather than an arbitrary one.
 *
 * DECLINED is deliberately sendable: a client who said no, then rang to say
 * they had misread it, should not require a brand-new quote number.
 */
export function canSendToClient(input: {
  documentStatus: "DRAFT" | "FINAL";
  signingStatus: SigningStatus;
  hasAuthorSignature: boolean;
  contactEmail: string | null;
}): Verdict {
  if (input.signingStatus === "SIGNED") return { ok: false, reason: SIGNED_IS_FINAL };
  if (isInFlight(input.signingStatus)) return { ok: false, reason: ALREADY_IN_FLIGHT };
  if (input.documentStatus !== "FINAL") return { ok: false, reason: NOT_FINAL };
  if (!input.hasAuthorSignature) return { ok: false, reason: NO_AUTHOR_SIGNATURE };
  if (!input.contactEmail || input.contactEmail.trim() === "") {
    return { ok: false, reason: NO_CONTACT_EMAIL };
  }
  return { ok: true };
}

/** DocuSign's Void, with DocuSign's restriction: only while the envelope is
 * still in flight. Nothing revokes a completed quote. */
export function canRevoke(status: SigningStatus): boolean {
  return isInFlight(status);
}

/**
 * The one new lock in the whole feature. Every other guarantee already
 * comes from the `status: "DRAFT"` clause every editing action carries (see
 * src/lib/actions/documents/_internal.ts), which is what makes FINAL
 * immutable today.
 */
export function canUnfinalize(status: SigningStatus): Verdict {
  if (status === "SIGNED") return { ok: false, reason: SIGNED_IS_FINAL };
  return { ok: true };
}

/** Completion needs both an outstanding link and a signature already drawn.
 * The drawn-but-unconfirmed window is what lets a client change their mind. */
export function canComplete(status: SigningStatus, hasClientSignature: boolean): boolean {
  return isInFlight(status) && hasClientSignature;
}

/** Declining stays available right up to completion — including after the
 * client has drawn a signature, which commits them to nothing. */
export function canDecline(status: SigningStatus): boolean {
  return isInFlight(status);
}

/** First open promotes SENT to VIEWED; every later open, and every other
 * status, is a no-op. Written as a total function so the caller can assign
 * unconditionally instead of branching. */
export function statusAfterView(status: SigningStatus): SigningStatus {
  return status === "SENT" ? "VIEWED" : status;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/signing-state.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/signing/state.ts tests/signing-state.test.ts
git commit -m "feat: signing transition rules as pure functions"
```

---

### Task 3: Link liveness

**Files:**
- Create: `src/lib/signing/link.ts`
- Test: `tests/signing-link.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/signing-link.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveLinkState, addDays } from "../src/lib/signing/link";

const NOW = new Date("2026-09-07T10:00:00.000Z");

const live = {
  expiresAt: new Date("2026-10-07T10:00:00.000Z"),
  revokedAt: null,
  declinedAt: null,
  signingStatus: "SENT" as const,
  now: NOW,
};

describe("resolveLinkState", () => {
  it("is live for an unexpired, unrevoked, outstanding request", () => {
    expect(resolveLinkState(live)).toEqual({ kind: "live" });
  });

  it("reports completion even when the link has also expired", () => {
    expect(
      resolveLinkState({
        ...live,
        signingStatus: "SIGNED",
        expiresAt: new Date("2026-08-01T10:00:00.000Z"),
      })
    ).toEqual({ kind: "completed" });
  });

  it("reports completion even when the request was later revoked", () => {
    expect(
      resolveLinkState({ ...live, signingStatus: "SIGNED", revokedAt: NOW })
    ).toEqual({ kind: "completed" });
  });

  it("reports revoked before declined", () => {
    expect(resolveLinkState({ ...live, revokedAt: NOW, declinedAt: NOW })).toEqual({
      kind: "revoked",
    });
  });

  it("reports declined", () => {
    expect(resolveLinkState({ ...live, declinedAt: NOW, signingStatus: "DECLINED" })).toEqual({
      kind: "declined",
    });
  });

  it("reports expired once expiresAt has passed", () => {
    expect(
      resolveLinkState({ ...live, expiresAt: new Date("2026-09-07T09:59:59.999Z") })
    ).toEqual({ kind: "expired" });
  });

  it("treats expiry as inclusive of the boundary instant", () => {
    expect(resolveLinkState({ ...live, expiresAt: NOW })).toEqual({ kind: "live" });
  });
});

describe("addDays", () => {
  it("adds whole days in UTC", () => {
    expect(addDays(NOW, 30).toISOString()).toBe("2026-10-07T10:00:00.000Z");
  });

  it("returns a new Date and does not mutate its input", () => {
    const input = new Date(NOW);
    addDays(input, 5);
    expect(input.toISOString()).toBe(NOW.toISOString());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/signing-link.test.ts`
Expected: FAIL — cannot resolve `../src/lib/signing/link`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/signing/link.ts`:

```ts
/**
 * Whether a `SigningRequest` still opens anything, and what to tell the
 * visitor when it does not. Pure — the clock is a parameter, which is what
 * lets this be tested without fake timers (forbidden by the suite's
 * `isolate: false` contract; see vitest.config.ts).
 */
import type { SigningStatus } from "./state";

export type LinkState =
  | { kind: "live" }
  | { kind: "completed" }
  | { kind: "revoked" }
  | { kind: "declined" }
  | { kind: "expired" };

/**
 * Precedence is deliberate and load-bearing:
 *
 * `completed` outranks everything. A client returning to a quote they signed
 * two months ago must see the quote and its PDF, not "this link expired" —
 * that link is the only copy some of them keep.
 *
 * `revoked` then outranks `declined`, because a manager revoking after a
 * decline is saying "ignore that entirely"; and both outrank `expired`,
 * since an explicit act is more informative than the passage of time.
 */
export function resolveLinkState(input: {
  expiresAt: Date;
  revokedAt: Date | null;
  declinedAt: Date | null;
  signingStatus: SigningStatus;
  now: Date;
}): LinkState {
  if (input.signingStatus === "SIGNED") return { kind: "completed" };
  if (input.revokedAt !== null) return { kind: "revoked" };
  if (input.declinedAt !== null) return { kind: "declined" };
  // Inclusive: a request whose expiry is exactly now has not expired yet.
  if (input.now.getTime() > input.expiresAt.getTime()) return { kind: "expired" };
  return { kind: "live" };
}

/** `expiresAt` for a request sent at `from` under a validity of `days`.
 * Kept here beside `resolveLinkState` so the two halves of the expiry rule
 * are read together. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/signing-link.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/signing/link.ts tests/signing-link.test.ts
git commit -m "feat: resolve whether a signing link still opens anything"
```

---

## Phase 2 — Schema and settings

### Task 4: Schema migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/z35_quote_signing/migration.sql` (generated)
- Test: `tests/signing-status-parity.test.ts`

- [ ] **Step 1: Add the enums and models to the schema**

In `prisma/schema.prisma`, after the `DeliveryTerms` enum, add:

```prisma
// Whether a quote has been sent for signature and how far it got. A separate
// column from DocumentStatus rather than new values on it: every
// `status === "FINAL"` check across finalize, pricing and the PDF route stays
// correct untouched, because signing is an orthogonal axis to draft/final.
//
// "Author signed but not yet sent" is deliberately NOT a value here -- it is
// NOT_SENT plus a Signature(AUTHOR) row. The same asymmetry carries the
// client's side: a drawn but unconfirmed client signature is VIEWED plus a
// Signature(CLIENT) row. In both cases the signature exists before the act
// that commits it, which is what gives each signer a window to change their
// mind (see docs/superpowers/specs/2026-09-07-quote-signing-design.md, D7).
enum SigningStatus {
  NOT_SENT
  SENT
  VIEWED
  SIGNED
  DECLINED
}

enum SignerRole {
  AUTHOR
  CLIENT
}
```

At the end of the file, add:

```prisma
// A frozen copy of one party's signature on one quote. `imageUrl` is a copy
// of the bytes, never a pointer to User.signatureUrl: a manager redrawing
// their signature next year must not silently rewrite it on every quote they
// have ever signed.
model Signature {
  id          String     @id @default(cuid())
  documentId  String
  document    Document   @relation(fields: [documentId], references: [id], onDelete: Cascade)
  role        SignerRole
  imageUrl    String
  signerName  String
  signerEmail String?
  signedAt    DateTime   @default(now())
  ip          String?
  userAgent   String?

  @@unique([documentId, role])
}

// One row per send. A resend inserts a new row and revokes the previous one,
// so send history is preserved without a separate event table -- sentAt,
// firstViewedAt, revokedAt, declinedAt and Signature.signedAt already carry
// the whole audit trail between them.
//
// `expiresAt` is frozen at send time from the "signing.linkValidityDays"
// Setting rather than computed live, for the same reason finalizeDocument
// freezes Document.validityDays: an admin lowering the setting must not
// retroactively kill every outstanding client link.
model SigningRequest {
  id            String    @id @default(cuid())
  documentId    String
  document      Document  @relation(fields: [documentId], references: [id], onDelete: Cascade)
  contactId     String
  contact       Contact   @relation(fields: [contactId], references: [id])
  email         String
  // SHA-256 of the token. The token itself never reaches the database, so a
  // dump grants access to no quote.
  tokenHash     String    @unique
  expiresAt     DateTime
  sentAt        DateTime  @default(now())
  firstViewedAt DateTime?
  revokedAt     DateTime?
  declinedAt    DateTime?
  declineReason String?
  declineIp     String?

  @@index([documentId])
}
```

- [ ] **Step 2: Add the columns and relations to `Document` and `User`**

In `model Document`, after the `commissionBase` field, add:

```prisma
  signingStatus   SigningStatus @default(NOT_SENT)
  // The archived signed PDF: the exact bytes the client saw when they
  // confirmed, plus their digest. Generated once at completion rather than
  // re-rendered on demand, so a later template change cannot rewrite what a
  // signed quote looks like. Cannot be orphaned: deletion is DRAFT-only,
  // SIGNED implies FINAL, and unfinalize is blocked at SIGNED.
  signedPdfName   String?
  signedPdfSha256 String?
  completedAt     DateTime?
  signatures      Signature[]
  signingRequests SigningRequest[]
```

In `model Contact`, add to the relation list:

```prisma
  signingRequests SigningRequest[]
```

In `model User`, after `image`, add:

```prisma
  // The manager's saved signature, drawn once in Account. Copied onto each
  // quote at signing time -- see Signature.imageUrl.
  signatureUrl      String?
```

- [ ] **Step 3: Generate the migration without applying it**

Run: `npx prisma migrate dev --create-only --name z35_quote_signing`
Expected: creates `prisma/migrations/<timestamp>_z35_quote_signing/`.

Rename the directory to `z35_quote_signing` to match the existing convention
(`z33_catalog_import`, `z32_drop_legacy_codes`, …):

```bash
cd prisma/migrations && mv *_z35_quote_signing z35_quote_signing && cd ../..
```

Read the generated `migration.sql` and confirm it only creates two enums, two
tables, and adds nullable columns plus one defaulted column. It must contain no
`DROP`.

- [ ] **Step 4: Apply the migration and regenerate the client**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: `1 migration applied`, then `Generated Prisma Client`.

- [ ] **Step 5: Write the parity test**

`src/lib/signing/state.ts` re-declares `SigningStatus` as a string union so it
stays importable without generated types. Create `tests/signing-status-parity.test.ts`
to stop the two drifting:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `src/lib/signing/state.ts` re-declares SigningStatus as a string union
 * rather than importing it from @prisma/client, so the pure rule module has
 * no generated-code dependency. That is a deliberate duplication, and this
 * is the thing that makes it safe: adding a value to the Prisma enum without
 * adding it to the union fails the build here rather than at the first
 * unhandled state in production.
 *
 * Reads source text rather than importing, matching tests/scope-coverage.test.ts.
 */
function prismaEnumValues(name: string): string[] {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const match = schema.match(new RegExp(`enum ${name} \\{([^}]*)\\}`));
  if (!match) throw new Error(`enum ${name} not found in prisma/schema.prisma`);
  return match[1]
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0);
}

function unionMembers(file: string, typeName: string): string[] {
  const source = readFileSync(file, "utf8");
  const match = source.match(new RegExp(`export type ${typeName} =([^;]*);`));
  if (!match) throw new Error(`type ${typeName} not found in ${file}`);
  return [...match[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

describe("SigningStatus parity", () => {
  it("the hand-written union lists exactly the Prisma enum's values", () => {
    expect(unionMembers("src/lib/signing/state.ts", "SigningStatus").sort()).toEqual(
      prismaEnumValues("SigningStatus").sort()
    );
  });

  it("finds a non-empty set of values, so a silent regex miss cannot pass", () => {
    expect(prismaEnumValues("SigningStatus").length).toBe(5);
  });
});
```

- [ ] **Step 6: Run the test and the type-check**

Run: `npx vitest run tests/signing-status-parity.test.ts && npm run typecheck`
Expected: PASS, 2 tests; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/z35_quote_signing tests/signing-status-parity.test.ts
git commit -m "feat: schema for quote signatures and signing requests"
```

---

### Task 5: Configurable link validity

**Files:**
- Modify: `src/lib/validation/settings.ts`
- Modify: `src/lib/queries/settings.ts`
- Modify: `src/lib/actions/settings.ts`
- Modify: `src/app/(app)/settings/page.tsx`
- Test: `tests/settings-validation.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/settings-validation.test.ts`:

```ts
import {
  signingLinkValidityDaysSchema,
  ALLOWED_SETTING_KEYS,
  isAllowedSettingKey,
} from "../src/lib/validation/settings";

describe("signingLinkValidityDaysSchema", () => {
  it("accepts a whole number of days in range, up to its own 90-day cap", () => {
    expect(signingLinkValidityDaysSchema.parse("30")).toBe(30);
    expect(signingLinkValidityDaysSchema.parse("1")).toBe(1);
    expect(signingLinkValidityDaysSchema.parse("90")).toBe(90);
  });

  it("rejects zero, negatives, fractions and values over its own 90-day cap", () => {
    for (const bad of ["0", "-1", "1.5", "91"]) {
      expect(signingLinkValidityDaysSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("rejects 365 even though that's quoteValidityDaysSchema's ceiling", () => {
    // A signing link is a bearer credential, not a document-validity window,
    // so it caps at 90 rather than inheriting the 365-day quote-validity bound.
    expect(signingLinkValidityDaysSchema.safeParse("365").success).toBe(false);
  });

  it("rejects non-numeric input", () => {
    expect(signingLinkValidityDaysSchema.safeParse("thirty").success).toBe(false);
  });
});

describe("signing.linkValidityDays is a writable setting key", () => {
  it("appears in ALLOWED_SETTING_KEYS", () => {
    expect(ALLOWED_SETTING_KEYS).toContain("signing.linkValidityDays");
  });

  it("passes isAllowedSettingKey", () => {
    expect(isAllowedSettingKey("signing.linkValidityDays")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/settings-validation.test.ts`
Expected: FAIL — `signingLinkValidityDaysSchema` is not exported.

- [ ] **Step 3: Add the schema and the key**

In `src/lib/validation/settings.ts`, extend the key list:

```ts
export const ALLOWED_SETTING_KEYS = [
  "quote.validityDays",
  "ui.showOptionIcons",
  "commission.tiers",
  "signing.linkValidityDays",
] as const;
```

and add the schema beside `quoteValidityDaysSchema`:

```ts
/** How many days a client's signing link stays usable, read by
 * `getSigningLinkValidityDays` (src/lib/queries/settings.ts). Same whole-day
 * shape as `quoteValidityDaysSchema`, reusing the same builder, but capped at
 * 90 days rather than inheriting that schema's 365: a signing link is a
 * bearer credential sitting in an inbox, not a document-validity window, so
 * a year of exposure isn't the same question as a year of quote validity.
 * The default of 30 (used when no `Setting` row exists) lives with that
 * query, not here.
 *
 * Note this only sets the validity of links issued *from now on*: the
 * resolved value is frozen into `SigningRequest.expiresAt` at send time, so
 * lowering it never shortens a link already in a client's inbox. */
export const signingLinkValidityDaysSchema = validityDayCountSchema(
  {
    invalidType: "Link validity must be a number",
    notInteger: "Link validity must be a whole number",
    tooSmall: "Link validity must be at least 1 day",
    tooLarge: "Link validity must be at most 90 days",
  },
  90
);
export type SigningLinkValidityDaysInput = z.infer<typeof signingLinkValidityDaysSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/settings-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the query**

In `src/lib/queries/settings.ts`, beside `getQuoteValidityDays`:

```ts
const SIGNING_LINK_VALIDITY_SETTING_KEY = "signing.linkValidityDays";

/** Fallback when no `Setting` row exists for "signing.linkValidityDays" (or
 * its value isn't a finite number). Thirty days is long enough for a quote
 * to survive a client's holiday and short enough that a forwarded link stops
 * being a credential. Exported so the settings form can show it as the
 * field's placeholder without duplicating the number. */
export const DEFAULT_SIGNING_LINK_VALIDITY_DAYS = 30;

/**
 * How long a newly-issued client signing link stays usable. Read once per
 * send by `sendQuoteForSignature` (src/lib/actions/signing.ts) and frozen
 * into `SigningRequest.expiresAt` — never read again when resolving an
 * existing link, which is what stops a lowered setting from retroactively
 * killing outstanding links.
 *
 * `cache`d for the same reason `getQuoteValidityDays` is: the settings page
 * reads it while rendering a field that also needs the current value.
 */
export const getSigningLinkValidityDays = cache(async function getSigningLinkValidityDays(): Promise<number> {
  const setting = await db.setting.findUnique({ where: { key: SIGNING_LINK_VALIDITY_SETTING_KEY } });
  const rawValue = setting?.value;
  return typeof rawValue === "number" && Number.isFinite(rawValue)
    ? rawValue
    : DEFAULT_SIGNING_LINK_VALIDITY_DAYS;
});
```

- [ ] **Step 6: Add the action case**

In `src/lib/actions/settings.ts`, add a case to the `switch (key)` in
`updateSetting`, immediately after the `"quote.validityDays"` case, importing
`signingLinkValidityDaysSchema` alongside the existing schemas:

```ts
    case "signing.linkValidityDays": {
      const parsed = signingLinkValidityDaysSchema.safeParse(formData.get("value"));
      if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Invalid value" };
      }
      await db.setting.upsert({
        where: { key },
        create: { key, value: parsed.data },
        update: { value: parsed.data },
      });
      break;
    }
```

- [ ] **Step 7: Add the field to the settings page**

In `src/app/(app)/settings/page.tsx`, render a second validity field directly
below the existing quote-validity one, reusing whatever form component that
field uses (read the file and copy its shape exactly — same component, same
`updateSetting` binding, `settingKey="signing.linkValidityDays"`, label
"Signing link validity (days)", helper text "How long a client's signing link
stays usable. Changing this does not affect links already sent.", and
`defaultValue` from `getSigningLinkValidityDays()`).

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; full suite passes.

- [ ] **Step 9: Commit**

```bash
git add src/lib/validation/settings.ts src/lib/queries/settings.ts src/lib/actions/settings.ts "src/app/(app)/settings/page.tsx" tests/settings-validation.test.ts
git commit -m "feat: admin-configurable signing link validity, frozen at send time"
```

---

## Phase 3 — Signature capture

### Task 6: The signature pad

**Files:**
- Modify: `package.json`
- Create: `src/components/signing/signature-pad.tsx`
- Create: `src/components/signing/signature-dialog.tsx`

No unit test: this is a canvas component, and the suite runs in a `node`
environment with no DOM. Its correctness is verified by the manual check in
Step 5.

- [ ] **Step 1: Install the library**

Run: `npm install signature_pad@^5.0.0`
Expected: added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the pad**

Create `src/components/signing/signature-pad.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import SignaturePadLib from "signature_pad";

export type SignaturePadHandle = {
  /** Transparent-background PNG data URL cropped to the stroke, or null when
   * nothing has been drawn. */
  toDataUrl: () => string | null;
  clear: () => void;
};

/**
 * A drawing surface backed by `signature_pad`.
 *
 * Three details decide whether the result looks like a signature rather than
 * a child's scribble, and all three are easy to omit:
 *
 * 1. The canvas backing store is sized in device pixels and the context is
 *    scaled to match. Without this the stroke is visibly pixellated on every
 *    phone, which is where most signing happens.
 * 2. `touch-action: none` on the canvas. Without it the drawing gesture
 *    scrolls the page instead of drawing.
 * 3. The exported PNG is cropped to the ink's bounding box, so the signature
 *    sits on the rule in the quote rather than floating inside a large
 *    transparent rectangle.
 */
export function SignaturePad({
  ref,
  onChange,
}: {
  ref?: React.Ref<SignaturePadHandle>;
  /** Fires whenever the canvas goes from empty to drawn or back, so the
   * parent can enable its confirm button. */
  onChange?: (hasInk: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);
  const [, setHasInk] = useState(false);

  const report = useCallback(
    (hasInk: boolean) => {
      setHasInk(hasInk);
      onChange?.(hasInk);
    },
    [onChange]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pad = new SignaturePadLib(canvas, {
      penColor: "#111111",
      backgroundColor: "rgba(0,0,0,0)",
      minWidth: 0.7,
      maxWidth: 2.6,
    });
    padRef.current = pad;

    // Sizing the backing store to CSS pixels alone produces a blurred stroke
    // on any display with devicePixelRatio > 1. Resizing also clears the
    // canvas, so the ink is captured and restored around it.
    const resize = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      const data = pad.isEmpty() ? null : pad.toData();
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext("2d")?.scale(ratio, ratio);
      pad.clear();
      if (data) pad.fromData(data);
    };

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);

    const onEnd = () => report(!pad.isEmpty());
    pad.addEventListener("endStroke", onEnd);

    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
      pad.removeEventListener("endStroke", onEnd);
      pad.off();
    };
  }, [report]);

  useImperativeHandle(
    ref,
    () => ({
      toDataUrl: () => {
        const pad = padRef.current;
        if (!pad || pad.isEmpty()) return null;
        return cropToInk(pad);
      },
      clear: () => {
        padRef.current?.clear();
        report(false);
      },
    }),
    [report]
  );

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full rounded-md border border-dashed border-neutral-300 bg-white"
      style={{ touchAction: "none" }}
      aria-label="Signature area"
    />
  );
}

/**
 * Re-draws the recorded strokes onto a canvas sized to their bounding box.
 * `signature_pad`'s own `toDataURL` exports the whole surface, which on a
 * desktop-sized pad is mostly empty space — and that space would then be
 * scaled down to fit the signature rule on the quote, shrinking the actual
 * signature to illegibility.
 */
function cropToInk(pad: SignaturePadLib): string | null {
  const groups = pad.toData();
  const points = groups.flatMap((group) => group.points);
  if (points.length === 0) return null;

  const pad_ = 8;
  const minX = Math.min(...points.map((p) => p.x)) - pad_;
  const maxX = Math.max(...points.map((p) => p.x)) + pad_;
  const minY = Math.min(...points.map((p) => p.y)) - pad_;
  const maxY = Math.max(...points.map((p) => p.y)) + pad_;

  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.ceil((maxX - minX) * ratio));
  out.height = Math.max(1, Math.ceil((maxY - minY) * ratio));

  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.scale(ratio, ratio);
  ctx.translate(-minX, -minY);

  const cropped = new SignaturePadLib(out, {
    penColor: "#111111",
    backgroundColor: "rgba(0,0,0,0)",
    minWidth: 0.7,
    maxWidth: 2.6,
  });
  cropped.fromData(groups, { clear: false });

  return out.toDataURL("image/png");
}
```

- [ ] **Step 3: Write the responsive shell**

Create `src/components/signing/signature-dialog.tsx`:

```tsx
"use client";

import { useRef, useState } from "react";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad";
import { Button } from "@/components/ui/button";

/**
 * The pad plus its chrome. Full-screen on a phone (where a signature drawn
 * in a small box looks nothing like the person's real one) and a large
 * fixed area on a desktop, chosen by CSS breakpoint rather than by sniffing
 * the user agent.
 *
 * Body scroll is locked while open: on iOS a drag that starts on the canvas
 * but ends outside it will otherwise scroll the page mid-stroke.
 */
export function SignatureDialog({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [hasInk, setHasInk] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/40 sm:items-center sm:justify-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      ref={(node) => {
        if (!node) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
          document.body.style.overflow = previous;
        };
      }}
    >
      <div className="flex h-full w-full flex-col gap-4 bg-white p-4 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:p-6">
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="text-sm text-neutral-500">Draw your signature below.</p>

        <div className="min-h-0 flex-1 sm:h-56 sm:flex-none">
          <SignaturePad ref={padRef} onChange={setHasInk} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => padRef.current?.clear()}
            disabled={!hasInk}
          >
            Clear
          </Button>
          <div className="flex gap-3">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!hasInk}
              onClick={() => {
                const dataUrl = padRef.current?.toDataUrl();
                if (dataUrl) onConfirm(dataUrl);
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

If `Button` does not accept the `variant` values used above, read
`src/components/ui/button.tsx` and substitute the variants it does define.

- [ ] **Step 4: Type-check**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Manual verification**

Run `npm run dev`, temporarily mount `SignatureDialog` on any page, and confirm:
sharp strokes on a high-DPI display; drawing does not scroll the page on a
phone or in a device-emulating browser; Clear empties it; Done is disabled
until something is drawn; the exported PNG is cropped to the ink. Then remove
the temporary mount.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/components/signing/
git commit -m "feat: signature pad, full-screen on mobile and cropped on export"
```

---

### Task 7: Saving a manager's signature to their profile

**Files:**
- Modify: `src/lib/actions/users.ts` (or the Account action module — read first)
- Modify: the Account page component that renders the profile photo field
- Create: `src/lib/signing/data-url.ts`
- Test: `tests/signing-data-url.test.ts`

The pad returns a data URL; `saveUpload` takes a `File`. The conversion is
pure and therefore testable, so it is extracted rather than inlined.

- [ ] **Step 1: Write the failing test**

Create `tests/signing-data-url.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseSignatureDataUrl, MAX_SIGNATURE_BYTES } from "../src/lib/signing/data-url";

// A 1x1 transparent PNG.
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("parseSignatureDataUrl", () => {
  it("decodes a PNG data URL to bytes", () => {
    const result = parseSignatureDataUrl(PNG_1PX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // PNG magic number.
    expect([...result.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("rejects a non-PNG media type", () => {
    expect(parseSignatureDataUrl("data:image/svg+xml;base64,PHN2Zy8+").ok).toBe(false);
  });

  it("rejects a plain URL", () => {
    expect(parseSignatureDataUrl("https://example.com/sig.png").ok).toBe(false);
    expect(parseSignatureDataUrl("/api/files/abc.png").ok).toBe(false);
  });

  it("rejects a non-base64 data URL", () => {
    expect(parseSignatureDataUrl("data:image/png,%89PNG").ok).toBe(false);
  });

  it("rejects malformed base64", () => {
    expect(parseSignatureDataUrl("data:image/png;base64,!!!!").ok).toBe(false);
  });

  it("rejects an oversized payload before decoding it", () => {
    const huge = "data:image/png;base64," + "A".repeat(MAX_SIGNATURE_BYTES * 2);
    expect(parseSignatureDataUrl(huge).ok).toBe(false);
  });

  it("rejects an empty payload", () => {
    expect(parseSignatureDataUrl("data:image/png;base64,").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/signing-data-url.test.ts`
Expected: FAIL — cannot resolve `../src/lib/signing/data-url`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/signing/data-url.ts`:

```ts
/**
 * Turns the `data:image/png;base64,…` string a `SignaturePad` produces into
 * bytes the upload layer can store.
 *
 * This is the trust boundary for a signature: the string arrives from a
 * browser — for the client-facing flow, an *unauthenticated* browser — so it
 * is validated rather than decoded optimistically. PNG only, because that is
 * the one format the pad emits and the one the sheet needs; allowing SVG
 * here would accept a scriptable document that then gets rendered inside
 * every quote and PDF that carries it.
 */
const PNG_PREFIX = "data:image/png;base64,";

/** A drawn signature is a few kilobytes. 512 KB is far above any real one
 * and far below anything worth writing to disk unchecked. */
export const MAX_SIGNATURE_BYTES = 512 * 1024;

export type ParsedSignature = { ok: true; bytes: Buffer } | { ok: false };

export function parseSignatureDataUrl(input: string): ParsedSignature {
  if (!input.startsWith(PNG_PREFIX)) return { ok: false };

  const payload = input.slice(PNG_PREFIX.length);
  if (payload.length === 0) return { ok: false };
  // Checked before decoding: base64 is 4/3 the size of its output, so this
  // bounds the allocation rather than discovering the size afterwards.
  if (payload.length > MAX_SIGNATURE_BYTES * 2) return { ok: false };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return { ok: false };

  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0 || bytes.length > MAX_SIGNATURE_BYTES) return { ok: false };

  // Confirm the declared type against the actual bytes, not the label.
  const isPng =
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  if (!isPng) return { ok: false };

  return { ok: true, bytes };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/signing-data-url.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the save action**

Read `src/lib/uploads.ts` for `saveUpload`'s exact signature and
`src/lib/actions/users.ts` for how the avatar action is written (it is the
closest precedent — same "user updates their own profile image" shape). Then
add, in the same module and following its conventions:

```ts
/**
 * Stores the signature drawn in Account as a PNG upload and points
 * `User.signatureUrl` at it. Scoped to the caller's own row: a signature is
 * the one profile field nobody may set on someone else's behalf.
 *
 * Note this is only the *saved* signature. Applying it to a quote copies the
 * file (see signQuoteAsAuthor), so changing it here never alters a signature
 * already on an issued quote.
 */
export async function saveMySignature(dataUrl: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsed = parseSignatureDataUrl(dataUrl);
  if (!parsed.ok) return { error: "That signature could not be read. Please draw it again." };

  const file = new File([new Uint8Array(parsed.bytes)], "signature.png", { type: "image/png" });
  const url = await saveUpload(file, ["png"]);

  await db.user.update({ where: { id: session.user.id }, data: { signatureUrl: url } });
  revalidatePath("/settings/account");
  return {};
}

/** Clears the saved signature. The upload itself is left on disk: it may
 * already have been copied onto issued quotes, and the copies are what those
 * render, so deleting bytes here would gain nothing and risk everything. */
export async function clearMySignature(): Promise<ActionResult> {
  const session = await requireSession();
  await db.user.update({ where: { id: session.user.id }, data: { signatureUrl: null } });
  revalidatePath("/settings/account");
  return {};
}
```

Adjust `requireSession`, `revalidatePath` target and `ActionResult` import to
match what the module already uses.

- [ ] **Step 6: Add the Account field**

In the Account page component that renders the profile photo, add a
"Signature" field beside it: shows `user.signatureUrl` in an `<img>` on a
signature rule when set, an empty rule when not, with a "Draw signature"
button opening `SignatureDialog` (title "Your signature", confirm label
"Save"), and a "Remove" button when one exists.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: clean; full suite passes.

Manually: draw a signature in Account, reload, confirm it persists and renders.

- [ ] **Step 8: Commit**

```bash
git add src/lib/signing/data-url.ts tests/signing-data-url.test.ts src/lib/actions/users.ts "src/app/(app)/settings"
git commit -m "feat: managers save a reusable signature on their profile"
```

---

## Phase 4 — Rendering signatures on the quote

### Task 8: Fill the signature block

**Files:**
- Modify: `src/components/sheet/sections/signatures.tsx`
- Modify: `src/lib/quotation-data.ts`
- Modify: `src/components/sheet/sheet-css.ts`
- Test: `tests/quotation-data.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/quotation-data.test.ts` (reuse whatever document fixture the
file already builds — read it first and follow its existing helper):

```ts
describe("buildQuotationData signatures", () => {
  it("carries both signatures through, resolved as images", () => {
    const data = buildQuotationData(
      {
        ...baseDoc,
        signatures: [
          {
            role: "AUTHOR",
            imageUrl: "/api/files/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png",
            signerName: "Jane Manager",
            signedAt: new Date("2026-09-07T10:00:00.000Z"),
          },
          {
            role: "CLIENT",
            imageUrl: "/api/files/11111111-2222-4333-8444-555555555555.png",
            signerName: "Bob Buyer",
            signedAt: new Date("2026-09-08T11:30:00.000Z"),
          },
        ],
      },
      blocks,
      { resolveImage: (url) => `resolved:${url}` }
    );

    expect(data.signatures.author).toEqual({
      image: "resolved:/api/files/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png",
      name: "Jane Manager",
      signedAt: "7 September 2026",
    });
    expect(data.signatures.client?.name).toBe("Bob Buyer");
  });

  it("leaves a side null when that party has not signed", () => {
    const data = buildQuotationData({ ...baseDoc, signatures: [] }, blocks, {
      resolveImage: (url) => url,
    });
    expect(data.signatures).toEqual({ author: null, client: null });
  });

  it("leaves a side null when its image cannot be resolved", () => {
    const data = buildQuotationData(
      {
        ...baseDoc,
        signatures: [
          {
            role: "AUTHOR",
            imageUrl: "/api/files/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.png",
            signerName: "Jane Manager",
            signedAt: new Date("2026-09-07T10:00:00.000Z"),
          },
        ],
      },
      blocks,
      { resolveImage: () => undefined }
    );
    expect(data.signatures.author).toBeNull();
  });
});
```

Match `signedAt`'s expected format to whatever date formatter
`buildQuotationData` already uses for `issueDate` — read the file and reuse
that helper rather than introducing a second date format on the same page.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/quotation-data.test.ts`
Expected: FAIL — `data.signatures` is undefined.

- [ ] **Step 3: Extend `QuotationData`**

In `src/lib/quotation-data.ts`, add to the input document type
(`QuotationDataDoc`):

```ts
  signatures: {
    role: "AUTHOR" | "CLIENT";
    imageUrl: string;
    signerName: string;
    signedAt: Date;
  }[];
```

add to `QuotationData` beside `showSignature`:

```ts
  /** Resolved signature images for the two rules at the foot of the quote.
   * A null side prints the empty rule it prints today, so an unsigned or
   * half-signed quote is unchanged from before this feature. */
  signatures: {
    author: QuotationSignature | null;
    client: QuotationSignature | null;
  };
```

with the type:

```ts
export type QuotationSignature = {
  /** Already run through `ImageResolver` — a `/api/files/…` URL in the app,
   * a base64 data URI in the PDF and on the client-facing page, both of
   * which render without this app's session cookie. */
  image: string;
  name: string;
  signedAt: string;
};
```

and build it inside `buildQuotationData`:

```ts
  const signatureFor = (role: "AUTHOR" | "CLIENT"): QuotationSignature | null => {
    const row = doc.signatures.find((s) => s.role === role);
    if (!row) return null;
    // An unresolvable image prints the empty rule rather than a broken
    // image icon in the middle of a customer-facing document.
    const image = resolveImage(row.imageUrl);
    if (!image) return null;
    return { image, name: row.signerName, signedAt: formatSheetDate(row.signedAt) };
  };
```

using the module's existing date formatter in place of `formatSheetDate`, and
assign `signatures: { author: signatureFor("AUTHOR"), client: signatureFor("CLIENT") }`
in the returned object.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/quotation-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Render them**

Replace `src/components/sheet/sections/signatures.tsx` with:

```tsx
import type { QuotationSignature } from "@/lib/quotation-data";

/**
 * The two signature rules at the foot of the quote — purchaser on the left,
 * Pathfinder on the right.
 *
 * A side with no signature prints exactly what it printed before quotes
 * could be signed electronically: an empty rule to be signed by hand. That
 * is deliberate, and it is what keeps the printed fallback working for a
 * client who would rather use a pen.
 */
export function Signatures({
  showSignature,
  author,
  client,
}: {
  showSignature: boolean;
  author: QuotationSignature | null;
  client: QuotationSignature | null;
}) {
  if (!showSignature) return null;

  return (
    <div className="pq-signatures">
      <SignatureBlock label="Purchaser" signature={client} />
      <SignatureBlock label="Pathfinder" signature={author} />
    </div>
  );
}

function SignatureBlock({
  label,
  signature,
}: {
  label: string;
  signature: QuotationSignature | null;
}) {
  return (
    <div className="pq-sig-block">
      <div className="pq-sig-ink">
        {signature ? <img className="pq-sig-image" src={signature.image} alt="" /> : null}
      </div>
      <div className="pq-sig-line" />
      <div className="pq-sig-label">
        {label}
        {signature ? (
          <span className="pq-sig-meta">
            {signature.name} — signed {signature.signedAt}
          </span>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Update the call site and the styles**

In `src/components/sheet/quotation-sheet.tsx`, change line 97 to:

```tsx
        <Signatures
          showSignature={data.showSignature}
          author={data.signatures.author}
          client={data.signatures.client}
        />
```

In `src/components/sheet/sheet-css.ts`, replace the `.pq-sig-line` rule and add
the new ones (keeping `.pq-signatures` and `.pq-sig-block` as they are):

```css
  .pq-sig-ink {
    height: 44px;
    display: flex;
    align-items: flex-end;
  }
  .pq-sig-image {
    max-height: 44px;
    max-width: 100%;
    object-fit: contain;
    object-position: left bottom;
  }
  .pq-sig-line {
    border-top: 1px solid #333333;
  }
  .pq-sig-label {
    margin-top: 4px;
    font-size: 10px;
    color: #555555;
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .pq-sig-meta {
    color: #777777;
  }
```

The old rule gave `.pq-sig-line` a 32px height to reserve space to sign in;
that space is now `.pq-sig-ink`, which holds the image when there is one and
is empty otherwise — so the unsigned layout is unchanged.

- [ ] **Step 7: Fix the remaining callers**

Run: `npm run typecheck`
Expected: errors listing every caller of `buildQuotationData` that does not yet
pass `signatures`. Fix each by including the document's signatures in its
select — `src/lib/queries/documents.ts` (`getDocumentForBuilder`) and any test
fixture. For the builder query add to its `include`:

```ts
      signatures: {
        select: { role: true, imageUrl: true, signerName: true, signedAt: true },
      },
```

Re-run until clean.

- [ ] **Step 8: Verify**

Run: `npm test`
Expected: full suite passes.

Manually: open a quote's `/quotation` preview and download its PDF; both should
render identically, with empty rules while unsigned.

- [ ] **Step 9: Commit**

```bash
git add src/lib/quotation-data.ts src/components/sheet/ src/lib/queries/documents.ts tests/quotation-data.test.ts
git commit -m "feat: render signatures in the quote's existing signature block"
```

---

## Phase 5 — Manager actions

### Task 9: Sign as author

**Files:**
- Create: `src/lib/actions/signing.ts`
- Modify: the FINAL-quote view in `src/components/documents/` (read to find it)

- [ ] **Step 1: Write the action**

Create `src/lib/actions/signing.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { saveUpload } from "@/lib/uploads";
import { resolveUploadPath } from "@/lib/uploads";
import { readFile } from "node:fs/promises";
import { parseSignatureDataUrl } from "@/lib/signing/data-url";
import { canSendToClient, canRevoke, type SigningStatus } from "@/lib/signing/state";
import { documentWhereForUser } from "@/lib/scope";
import { NOT_FOUND_ERROR, type ActionResult } from "./_shared";

/**
 * Applies the author's signature to a FINAL quote.
 *
 * `dataUrl` is either a freshly drawn signature or, when the manager accepted
 * their saved one, the literal string "saved" — in which case the bytes are
 * read from `User.signatureUrl` and written as a *new* upload. Copying rather
 * than referencing is the whole point: a manager who redraws their profile
 * signature next year must not retroactively change what they signed today.
 */
export async function signQuoteAsAuthor(
  documentId: string,
  dataUrl: string
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: documentId, status: "FINAL", ...documentWhereForUser(session.user) },
    select: { id: true, signingStatus: true },
  });
  if (!document) return { error: NOT_FOUND_ERROR };
  if (document.signingStatus !== "NOT_SENT" && document.signingStatus !== "DECLINED") {
    return { error: "This quote can no longer be signed." };
  }

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true, signatureUrl: true },
  });
  if (!user) return { error: NOT_FOUND_ERROR };

  let bytes: Buffer;
  if (dataUrl === "saved") {
    if (!user.signatureUrl) return { error: "You have no saved signature yet." };
    const path = resolveUploadPath(user.signatureUrl.replace("/api/files/", ""));
    if (!path) return { error: "Your saved signature could not be read." };
    bytes = await readFile(path);
  } else {
    const parsed = parseSignatureDataUrl(dataUrl);
    if (!parsed.ok) return { error: "That signature could not be read. Please draw it again." };
    bytes = parsed.bytes;
  }

  const file = new File([new Uint8Array(bytes)], "signature.png", { type: "image/png" });
  const imageUrl = await saveUpload(file, ["png"]);

  await db.signature.upsert({
    where: { documentId_role: { documentId: document.id, role: "AUTHOR" } },
    create: {
      documentId: document.id,
      role: "AUTHOR",
      imageUrl,
      signerName: user.name ?? user.email,
      signerEmail: user.email,
    },
    update: { imageUrl, signedAt: new Date() },
  });

  revalidateDocument(document.id);
  return {};
}
```

`ip`/`userAgent` are left null for the author: they are signing inside an
authenticated session that already identifies them, and the audit value is in
the client's row.

- [ ] **Step 2: Write the freeze guard**

The whole point of D5 is that `Signature.imageUrl` is a *copy*. Nothing in the
type system stops a future author from assigning `user.signatureUrl` straight
into it, and that bug would be invisible until a manager redrew their signature
and silently changed every quote they had ever signed. Create
`tests/signature-freeze.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `Signature.imageUrl` must always be a freshly written upload, never a
 * pointer at `User.signatureUrl`. Assigning the profile URL directly would
 * make every past signature follow the manager's current one -- a silent
 * rewrite of documents a customer has already signed.
 *
 * Source-text check, like tests/scope-coverage.test.ts: the failure mode is a
 * line someone writes later, not the behaviour of the code that exists now.
 */
const ACTIONS = "src/lib/actions/signing.ts";

describe("author signature is copied, not referenced", () => {
  const source = readFileSync(ACTIONS, "utf8");

  it("writes the signature from a saveUpload result", () => {
    expect(source).toMatch(/imageUrl\s*=\s*await saveUpload\(/);
  });

  it("never assigns a profile signatureUrl into a Signature row", () => {
    expect(source).not.toMatch(/imageUrl\s*:\s*[\w.]*signatureUrl/);
  });

  it("only reads signatureUrl to load bytes from disk", () => {
    // Every mention of signatureUrl in this module should be a read used to
    // resolve a path, never a value written onward.
    for (const line of source.split("\n")) {
      if (!line.includes("signatureUrl")) continue;
      expect(line).not.toMatch(/imageUrl/);
    }
  });
});
```

- [ ] **Step 3: Run the guard**

Run: `npx vitest run tests/signature-freeze.test.ts`
Expected: PASS, 3 tests. Confirm it works by temporarily changing the upsert to
`imageUrl: user.signatureUrl` and seeing it fail, then reverting.

- [ ] **Step 4: Add the UI**

On the FINAL-quote view, add a **Sign** button. When the manager has a saved
signature, show it with "Use this" and "Draw a new one"; otherwise open
`SignatureDialog` directly. "Use this" calls `signQuoteAsAuthor(id, "saved")`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Expected: clean.

Manually: finalize a quote, sign it, confirm the signature appears on the
right-hand ("Pathfinder") rule in the preview and the PDF.

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/signing.ts src/components/documents/ tests/signature-freeze.test.ts
git commit -m "feat: managers sign a finalized quote, copying the saved signature"
```

---

### Task 10: Send to client

**Files:**
- Modify: `src/lib/actions/signing.ts`
- Create: `src/lib/email/signing.ts`
- Test: `tests/signing-emails.test.ts`

- [ ] **Step 1: Write the failing email test**

Create `tests/signing-emails.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  buildSigningInviteEmail,
  buildCompletionEmailForClient,
  buildCompletionEmailForAuthor,
  buildRevokedEmail,
} from "../src/lib/email/signing";

const invite = {
  url: "https://q.example.com/sign/Tok3n-With_Specials",
  quoteNumber: "Q-AU-2026-001",
  total: "A$248,500.00",
  authorName: "Jane Manager",
  entityName: "Pathfinder Australia Pty Ltd",
  expiresOn: "7 October 2026",
  replyTo: "jane@example.com",
};

describe("buildSigningInviteEmail", () => {
  it("names the quote in the subject", () => {
    expect(buildSigningInviteEmail(invite).subject).toContain("Q-AU-2026-001");
  });

  it("passes the reply-to through untouched", () => {
    expect(buildSigningInviteEmail(invite).replyTo).toBe("jane@example.com");
  });

  it("puts the URL in the href but never in the visible link text", () => {
    const { html } = buildSigningInviteEmail(invite);
    expect(html).toContain(`href="${invite.url}"`);
    expect(html).not.toContain(">https://q.example.com/sign/Tok3n-With_Specials<");
  });

  it("includes the URL in the plain-text part, where there is no href", () => {
    expect(buildSigningInviteEmail(invite).text).toContain(invite.url);
  });

  it("escapes HTML in every interpolated field", () => {
    const { html } = buildSigningInviteEmail({
      ...invite,
      authorName: 'Ann <script>alert("x")</script> Smith',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an ampersand in the URL's href", () => {
    const { html } = buildSigningInviteEmail({
      ...invite,
      url: "https://q.example.com/sign/a&b",
    });
    expect(html).toContain("href=\"https://q.example.com/sign/a&amp;b\"");
  });

  it("states when the link expires", () => {
    expect(buildSigningInviteEmail(invite).text).toContain("7 October 2026");
  });
});

describe("buildCompletionEmailForClient", () => {
  it("names the quote and says a copy is attached", () => {
    const mail = buildCompletionEmailForClient({
      quoteNumber: "Q-AU-2026-001",
      entityName: "Pathfinder Australia Pty Ltd",
      authorName: "Jane Manager",
      replyTo: "jane@example.com",
    });
    expect(mail.subject).toContain("Q-AU-2026-001");
    expect(mail.text.toLowerCase()).toContain("attached");
  });
});

describe("buildCompletionEmailForAuthor", () => {
  it("links into the app rather than attaching anything", () => {
    const mail = buildCompletionEmailForAuthor({
      quoteNumber: "Q-AU-2026-001",
      clientName: "Bob Buyer",
      companyName: "Acme Pty Ltd",
      documentUrl: "https://q.example.com/documents/abc",
      replyTo: null,
    });
    expect(mail.html).toContain('href="https://q.example.com/documents/abc"');
    expect(mail.replyTo).toBeUndefined();
  });
});

describe("buildRevokedEmail", () => {
  it("explains the link is dead without implying fault", () => {
    const mail = buildRevokedEmail({
      quoteNumber: "Q-AU-2026-001",
      authorName: "Jane Manager",
      replyTo: "jane@example.com",
    });
    expect(mail.subject).toContain("Q-AU-2026-001");
    expect(mail.text).toContain("Jane Manager");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/signing-emails.test.ts`
Expected: FAIL — cannot resolve `../src/lib/email/signing`.

- [ ] **Step 3: Write the templates**

Read `src/lib/email/magic-link.ts` first — this module mirrors it exactly: same
return shape, same local `escapeHtml`, no Prisma, no env reads, no imports
beyond types. Create `src/lib/email/signing.ts`:

```ts
/**
 * The four emails the signing flow sends, as pure functions.
 *
 * No Prisma, no environment, no transport — every value arrives as an
 * argument, which is what lets these be tested without booting the mail
 * stack (see tests/signing-emails.test.ts), exactly as
 * `buildMagicLinkEmail` is.
 */
export type BuiltEmail = {
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
};

/** Same five-entity escape as `escapeHtml` in src/lib/markdown.ts, duplicated
 * locally rather than importing a markdown module for one string helper —
 * the convention magic-link.ts already follows. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The invitation. Its call to action is an anchor reading "Review and sign
 * this quote" — the raw URL never appears as visible HTML text, so a
 * forwarded screenshot of the message does not carry a working credential.
 * The plain-text part must contain the URL, because there is no href there.
 */
export function buildSigningInviteEmail(input: {
  url: string;
  quoteNumber: string;
  total: string;
  authorName: string;
  entityName: string;
  expiresOn: string;
  replyTo?: string;
}): BuiltEmail {
  const subject = `Quotation ${input.quoteNumber} from ${input.entityName}`;

  const text = [
    `${input.authorName} has sent you quotation ${input.quoteNumber} for ${input.total}.`,
    ``,
    `Review and sign it here:`,
    input.url,
    ``,
    `This link works until ${input.expiresOn}.`,
    ``,
    `${input.entityName}`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
      <p style="margin:0 0 16px">
        ${escapeHtml(input.authorName)} has sent you quotation
        <strong>${escapeHtml(input.quoteNumber)}</strong> for
        <strong>${escapeHtml(input.total)}</strong>.
      </p>
      <p style="margin:0 0 24px">
        <a href="${escapeHtml(input.url)}"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px">
          Review and sign this quote
        </a>
      </p>
      <p style="margin:0 0 8px;color:#666;font-size:13px">
        This link works until ${escapeHtml(input.expiresOn)}.
      </p>
      <p style="margin:24px 0 0;color:#666;font-size:13px">${escapeHtml(input.entityName)}</p>
    </div>
  `.trim();

  return { subject, text, html, replyTo: input.replyTo };
}
```

Write the remaining three in the same shape:

- `buildCompletionEmailForClient({ quoteNumber, entityName, authorName, replyTo })`
  — subject `Signed: quotation <number>`; body confirms the signature was
  received and says a copy is **attached**; no link, because theirs expires.
- `buildCompletionEmailForAuthor({ quoteNumber, clientName, companyName, documentUrl, replyTo })`
  — subject `<clientName> signed quotation <number>`; a single anchor to
  `documentUrl`. `replyTo` is `undefined` here: the author is the reply target
  everywhere else, and a message to themselves needs no Reply-To.
- `buildRevokedEmail({ quoteNumber, authorName, replyTo })` — subject
  `Quotation <number> is no longer current`; body says the link has been
  withdrawn and `authorName` will be in touch. No blame, no detail: the client
  did nothing wrong and the reason is the manager's to give.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/signing-emails.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the send action**

Append to `src/lib/actions/signing.ts`:

```ts
/**
 * Issues a signing link and emails it to the document's contact.
 *
 * The token is generated here, hashed into the row, and then exists only in
 * the email — there is no way to recover it afterwards, which is why a
 * resend issues a new one rather than re-sending the old.
 *
 * `expiresAt` is computed once, from the setting, and frozen. Resolving an
 * existing link never reads the setting again.
 */
export async function sendQuoteForSignature(documentId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: documentId, ...documentWhereForUser(session.user) },
    select: {
      id: true,
      number: true,
      status: true,
      signingStatus: true,
      total: true,
      currency: true,
      contactId: true,
      contact: { select: { id: true, email: true, firstName: true, lastName: true } },
      author: { select: { name: true, email: true, active: true } },
      region: { select: { entityName: true } },
      signatures: { where: { role: "AUTHOR" }, select: { id: true } },
    },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const verdict = canSendToClient({
    documentStatus: document.status,
    signingStatus: document.signingStatus as SigningStatus,
    hasAuthorSignature: document.signatures.length > 0,
    contactEmail: document.contact?.email ?? null,
  });
  if (!verdict.ok) return { error: verdict.reason };

  const days = await getSigningLinkValidityDays();
  const token = generateSigningToken();
  const now = new Date();
  const expiresAt = addDays(now, days);

  await db.$transaction(async (tx) => {
    // Any earlier request is dead the moment a new one is issued.
    await tx.signingRequest.updateMany({
      where: { documentId: document.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.signingRequest.create({
      data: {
        documentId: document.id,
        contactId: document.contactId!,
        email: document.contact!.email!,
        tokenHash: hashSigningToken(token),
        expiresAt,
      },
    });
    await tx.document.update({
      where: { id: document.id },
      data: { signingStatus: "SENT" },
    });
  });

  const mail = buildSigningInviteEmail({
    url: `${process.env.NEXTAUTH_URL}/sign/${token}`,
    quoteNumber: document.number ?? "",
    total: formatMoney(document.total, document.currency),
    authorName: document.author.name ?? document.author.email,
    entityName: document.region.entityName,
    expiresOn: formatLongDate(expiresAt),
    replyTo: resolveReplyTo(document.author, process.env.EMAIL_REPLY_TO),
  });

  // Deliberately outside the transaction: the link is issued either way, and
  // a send failure must not roll back a row the manager can see. Failures are
  // surfaced rather than swallowed -- the trap documented in
  // docs/email-sending-setup.md, where a swallowed AuthError made "sent" a lie.
  try {
    await sendMail({ to: document.contact!.email!, ...mail });
  } catch (error) {
    console.error("[signing] invite email failed", error);
    return { error: "The quote was prepared but the email could not be sent. Try resending." };
  }

  revalidateDocument(document.id);
  return {};
}
```

Add the imports this needs at the top of the module
(`generateSigningToken`, `hashSigningToken`, `addDays`,
`getSigningLinkValidityDays`, `buildSigningInviteEmail`, `resolveReplyTo`), and
use the app's existing money and long-date formatters from `src/lib/format.ts`
in place of `formatMoney`/`formatLongDate`. Read `src/lib/email/transport.ts`
for the correct send helper in place of `sendMail`.

- [ ] **Step 6: Add the UI**

Beside the Sign button, add **Send to client**, disabled with
`canSendToClient`'s reason as its tooltip when the verdict is not ok, and
showing the destination address in its confirmation.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: clean.

Manually: send a quote to a real address and confirm the email arrives with a
working link.

- [ ] **Step 8: Commit**

```bash
git add src/lib/email/signing.ts tests/signing-emails.test.ts src/lib/actions/signing.ts src/components/documents/
git commit -m "feat: email a signing link to the quote's contact"
```

---

### Task 11: Revoke, and lock unfinalize

**Files:**
- Modify: `src/lib/actions/signing.ts`
- Modify: `src/lib/actions/finalize.ts:255-275`

- [ ] **Step 1: Add revoke**

Append to `src/lib/actions/signing.ts`:

```ts
/**
 * Kills every live link for a quote and returns it to NOT_SENT. This is
 * DocuSign's Void, with DocuSign's restriction -- `canRevoke` refuses once
 * the quote is completed, because a signed quote is not something either
 * party can take back.
 *
 * The client is told, matching DocuSign's void notification: a dead link
 * with no explanation reads as a broken website.
 */
export async function revokeSigningLink(documentId: string): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { error: NOT_FOUND_ERROR };

  const document = await db.document.findFirst({
    where: { id: documentId, ...documentWhereForUser(session.user) },
    select: {
      id: true,
      number: true,
      signingStatus: true,
      author: { select: { name: true, email: true, active: true } },
      signingRequests: {
        where: { revokedAt: null },
        select: { id: true, email: true },
      },
    },
  });
  if (!document) return { error: NOT_FOUND_ERROR };
  if (!canRevoke(document.signingStatus as SigningStatus)) {
    return { error: "There is no live link to revoke." };
  }

  const recipients = document.signingRequests.map((r) => r.email);

  await db.$transaction(async (tx) => {
    await tx.signingRequest.updateMany({
      where: { documentId: document.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // The client may have drawn a signature without confirming it. Left in
    // place, the next send would open already showing "Signed ✓" with the
    // confirm button enabled, for a client who never saw that quote. The
    // author's signature survives: the document stays FINAL and unchanged,
    // so it is still a signature of exactly this text.
    await tx.signature.deleteMany({
      where: { documentId: document.id, role: { in: signatureRolesClearedBy("revoke") } },
    });
    await tx.document.update({
      where: { id: document.id },
      data: { signingStatus: "NOT_SENT" },
    });
  });

  const mail = buildRevokedEmail({
    quoteNumber: document.number ?? "",
    authorName: document.author.name ?? document.author.email,
    replyTo: resolveReplyTo(document.author, process.env.EMAIL_REPLY_TO),
  });
  for (const to of recipients) {
    try {
      await sendMail({ to, ...mail });
    } catch (error) {
      // The link is already dead, which is the part that mattered. A failed
      // courtesy notice is logged, not surfaced as a failed revoke.
      console.error("[signing] revocation email failed", error);
    }
  }

  revalidateDocument(document.id);
  return {};
}
```

- [ ] **Step 2: Lock unfinalize**

In `src/lib/actions/finalize.ts`, extend `unfinalizeDocument`. After the
`findFirst` and before the update, add the guard and the cleanup:

```ts
  const verdict = canUnfinalize(document.signingStatus as SigningStatus);
  if (!verdict.ok) return { error: verdict.reason };

  // The content is about to become editable again, so everything that
  // referenced it stops being true: outstanding links point at a quote that
  // is no longer the one that was sent, and the author signed text that is
  // about to change.
  await db.$transaction(async (tx) => {
    await tx.signingRequest.updateMany({
      where: { documentId: document.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Both roles, not just the author: the text is about to change, so
    // neither party signed what will exist afterwards. Which roles an event
    // invalidates is decided by `signatureRolesClearedBy`, beside the other
    // transition rules, rather than being re-derived here and in revoke.
    await tx.signature.deleteMany({
      where: { documentId: document.id, role: { in: signatureRolesClearedBy("unfinalize") } },
    });
    await tx.document.update({
      where: { id: document.id },
      data: { status: "DRAFT", signingStatus: "NOT_SENT" },
    });
  });
```

replacing the existing bare `db.document.update`. Add `signingStatus: true` to
the `findFirst`'s select and import `canUnfinalize`, `signatureRolesClearedBy`
and `SigningStatus` from `@/lib/signing/state`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: clean.

Manually: send a quote, revoke it, confirm the client link stops working and
the quote returns to NOT_SENT. Then confirm an admin can unfinalize a SENT
quote and cannot unfinalize a SIGNED one.

- [ ] **Step 4: Commit**

```bash
git add src/lib/actions/signing.ts src/lib/actions/finalize.ts
git commit -m "feat: revoke a signing link; refuse to reopen a signed quote"
```

---

## Phase 6 — The client-facing route

### Task 12: Public route and the commission-free query

**Files:**
- Modify: `src/proxy.ts:9`
- Create: `src/lib/queries/signing.ts`
- Create: `src/app/(sign)/layout.tsx`
- Test: `tests/signing-exposure.test.ts`

- [ ] **Step 1: Write the failing guard test**

Create `tests/signing-exposure.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The signing query feeds an UNAUTHENTICATED page. Showing a client the
 * manager's commission is an incident, not a bug, and the way it would
 * happen is not malice but reuse -- someone reaching for
 * `getDocumentForBuilder` because it already returns everything the sheet
 * needs, commission included.
 *
 * Reads source text rather than importing, matching
 * tests/scope-coverage.test.ts: the point is to catch the shape of the file
 * a future author writes, not the behaviour of the one that exists.
 */
const SIGNING_QUERY = "src/lib/queries/signing.ts";

describe("signing query exposure", () => {
  const source = readFileSync(SIGNING_QUERY, "utf8");

  it("exists and selects something", () => {
    expect(source).toContain("getDocumentForSigning");
    expect(source).toContain("select");
  });

  it("names no commission field", () => {
    const offenders = [...source.matchAll(/\bcommission\w*/gi)]
      .map((m) => m[0])
      // The doc comment is allowed to explain why the field is absent.
      .filter((_, index) => index >= 0);
    const inCode = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    expect(inCode).not.toMatch(/\bcommission/i);
    expect(offenders.length).toBeGreaterThanOrEqual(0);
  });

  it("does not borrow the builder query, which does select commission", () => {
    expect(source).not.toMatch(/from ["']@\/lib\/queries\/documents["']/);
    expect(source).not.toContain("getDocumentForBuilder");
  });

  it("selects no internal-only document fields", () => {
    const inCode = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .join("\n");
    for (const field of ["notes", "ownerId"]) {
      expect(inCode).not.toMatch(new RegExp(`\\b${field}\\s*:\\s*true`));
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/signing-exposure.test.ts`
Expected: FAIL — `ENOENT: no such file … src/lib/queries/signing.ts`.

- [ ] **Step 3: Write the query**

Create `src/lib/queries/signing.ts`. Read `getDocumentForBuilder` in
`src/lib/queries/documents.ts` for the shape `buildQuotationData` needs, then
write a select carrying **only** those fields — deliberately not importing that
module:

```ts
import { db } from "@/lib/db";

/**
 * The document behind a signing token, for an unauthenticated visitor.
 *
 * Written from scratch rather than reusing `getDocumentForBuilder`, and
 * deliberately not importing it. That query selects `commissionAmount`,
 * `commissionRatePct` and `commissionBase`; this one must never carry them
 * to a page a customer can open. `tests/signing-exposure.test.ts` fails the
 * build if a commission field, or an import of that module, appears here.
 *
 * Lookup is by token hash, which is the unique column -- the raw token never
 * reaches the database (see src/lib/signing/token.ts).
 */
export async function getDocumentForSigning(tokenHash: string) {
  return db.signingRequest.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      declinedAt: true,
      firstViewedAt: true,
      email: true,
      contact: { select: { firstName: true, lastName: true } },
      document: {
        select: {
          id: true,
          signingStatus: true,
          signedPdfName: true,
          // ... every field buildQuotationData consumes, and nothing else
        },
      },
    },
  });
}
```

To fill the document select out exactly, do this mechanically rather than from
memory:

1. Open `src/lib/queries/documents.ts` and copy the `select`/`include` block
   `getDocumentForBuilder` uses for the document itself.
2. Paste it here, then **delete** `commissionAmount`, `commissionRatePct`,
   `commissionBase`, and `notes` (internal, never customer-facing).
3. Add `regionId: true`, `author: { select: { name: true, email: true } }`, and
   `signatures: { select: { role: true, imageUrl: true, signerName: true, signedAt: true } }`.
4. Run `npm run typecheck` — `buildQuotationData` will reject the object if any
   field it consumes is missing, so the compiler finishes the list for you.

Do not shortcut step 2 by spreading the builder's select and overriding fields
to `false`: the exposure test reads source text, and a future reader would see
`commissionAmount` in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/signing-exposure.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Open the route publicly**

In `src/proxy.ts`, change line 9:

```ts
// "/sign" is the client-facing signing route: an unauthenticated visitor
// holding a token, by design. Nothing under it may call auth() or import
// from the (app) route group -- it is a separate public entrance to the
// application, and the token is its only credential.
const PUBLIC_PATHS = ["/login", "/api/auth", "/api/health", "/sign"];
```

- [ ] **Step 6: Add the public layout**

Create `src/app/(sign)/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * The layout for the client-facing signing pages. Deliberately bare: no
 * navigation, no session lookup, no link back into the application. A client
 * holding a token is not a user of this app and must not be offered a door
 * into it.
 */
export default function SignLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-100">{children}</body>
    </html>
  );
}
```

Adjust the stylesheet import to match what `src/app/(app)/layout.tsx` imports.

- [ ] **Step 7: Send the signing route's security headers**

`metadata.robots` above covers indexing, but not referrer leakage: the token is
in the URL path, so any outbound request the page makes would carry it in a
`Referer` header. Add to `next.config.ts`, inside the existing config object:

```ts
  async headers() {
    return [
      {
        // The signing token lives in this path. `no-referrer` stops it
        // travelling in a Referer header to anything the page loads or links
        // to; `no-store` keeps it out of shared caches.
        source: "/sign/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
```

If `next.config.ts` already defines `headers()`, add this entry to the array it
returns rather than replacing the function.

Verify with:

```bash
curl -sI http://localhost:3100/sign/anything | grep -i 'referrer-policy\|x-robots-tag\|cache-control'
```

Expected: all three headers present.

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test`
Expected: clean.

Manually: `curl -I http://localhost:3100/sign/nonsense` returns 200 (the
"link not found" page), not a redirect to `/login`.

- [ ] **Step 9: Commit**

```bash
git add src/proxy.ts src/lib/queries/signing.ts "src/app/(sign)/layout.tsx" next.config.ts tests/signing-exposure.test.ts
git commit -m "feat: public signing route and a commission-free query behind it"
```

---

### Task 13: The client page

**Files:**
- Create: `src/app/(sign)/sign/[token]/page.tsx`
- Create: `src/components/signing/link-problem.tsx`

- [ ] **Step 1: Write the refusal screens**

Create `src/components/signing/link-problem.tsx` exporting a `LinkProblem`
component taking `kind: "not-found" | "expired" | "revoked" | "declined"` and
an optional `{ authorName, authorEmail }`, rendering a centred card. Copy per
kind:

- `not-found` — "This link isn't valid. It may have been mistyped, or replaced by a newer one."
- `expired` — "This link has expired." plus the author's name and email when known.
- `revoked` — "This quote is no longer current. <author> will be in touch."
- `declined` — "You declined this quote. <author> will be in touch."

`not-found` never says whether a token existed: a missing token and someone
else's token produce the identical screen, matching how a foreign and a
nonexistent document both 404 in `getDocumentForBuilder`.

- [ ] **Step 2: Write the page**

Create `src/app/(sign)/sign/[token]/page.tsx`:

```tsx
import { db } from "@/lib/db";
import { getDocumentForSigning } from "@/lib/queries/signing";
import { getContentBlocksForRegion } from "@/lib/queries/content";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { statusAfterView, type SigningStatus } from "@/lib/signing/state";
import { buildQuotationData } from "@/lib/quotation-data";
import { fileImageResolver } from "@/lib/pdf";
import { QuotationSheet } from "@/components/sheet/quotation-sheet";
import { LinkProblem } from "@/components/signing/link-problem";
import { ClientActionBar } from "@/components/signing/client-action-bar";

// fileImageResolver reads from the filesystem — Node runtime only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The quote as the client sees it: the same `QuotationSheet` the in-app
 * preview and the PDF render, with a signing bar under it.
 *
 * Images go through `fileImageResolver` (base64 data URIs) rather than the
 * stored `/api/files/...` URLs, because that route checks the session and
 * this visitor has none. The same resolver already serves Gotenberg's
 * cookie-less Chromium, so this is a third consumer of an existing path
 * rather than a new one.
 */
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const request = await getDocumentForSigning(hashSigningToken(token));
  if (!request) return <LinkProblem kind="not-found" />;

  const state = resolveLinkState({
    expiresAt: request.expiresAt,
    revokedAt: request.revokedAt,
    declinedAt: request.declinedAt,
    signingStatus: request.document.signingStatus as SigningStatus,
    now: new Date(),
  });

  if (state.kind === "expired" || state.kind === "revoked" || state.kind === "declined") {
    return (
      <LinkProblem
        kind={state.kind}
        authorName={request.document.author.name ?? request.document.author.email}
        authorEmail={request.document.author.email}
      />
    );
  }

  // First open promotes SENT to VIEWED. Guarded on firstViewedAt being null
  // so a reload is not a second event, and written with updateMany so two
  // simultaneous opens cannot both claim it.
  if (request.firstViewedAt === null) {
    const now = new Date();
    await db.$transaction(async (tx) => {
      const claimed = await tx.signingRequest.updateMany({
        where: { id: request.id, firstViewedAt: null },
        data: { firstViewedAt: now },
      });
      if (claimed.count === 0) return;
      await tx.document.update({
        where: { id: request.document.id },
        data: { signingStatus: statusAfterView(request.document.signingStatus as SigningStatus) },
      });
    });
  }

  const blocks = await getContentBlocksForRegion(request.document.regionId);
  const data = buildQuotationData(request.document, blocks, { resolveImage: fileImageResolver });

  return (
    <main className="mx-auto max-w-4xl pb-28">
      <div className="bg-white shadow-sm">
        <QuotationSheet data={data} />
      </div>
      <ClientActionBar
        token={token}
        completed={state.kind === "completed"}
        hasClientSignature={data.signatures.client !== null}
      />
    </main>
  );
}
```

Add the author's name and email to `getDocumentForSigning`'s select and pass
them into `LinkProblem`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: clean.

Manually: send a quote to yourself, open the link, confirm the quote renders
with images, and that the document's status moves SENT → VIEWED once and stays
there across reloads.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(sign)/sign" src/components/signing/link-problem.tsx src/lib/queries/signing.ts
git commit -m "feat: clients open their quote by token and the manager sees it viewed"
```

---

### Task 14: Client signs and completes

**Files:**
- Create: `src/lib/actions/signing-client.ts`
- Create: `src/components/signing/client-action-bar.tsx`
- Create: `src/lib/signing/archive.ts`
- Test: `tests/signing-archive.test.ts`

- [ ] **Step 1: Write the failing archive test**

Create `tests/signing-archive.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sha256Hex, signedPdfFilename } from "../src/lib/signing/archive";

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", () => {
    expect(sha256Hex(Buffer.from("abc", "utf8"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is stable and differs between inputs", () => {
    const a = Buffer.from([1, 2, 3]);
    expect(sha256Hex(a)).toBe(sha256Hex(Buffer.from([1, 2, 3])));
    expect(sha256Hex(a)).not.toBe(sha256Hex(Buffer.from([1, 2, 4])));
  });
});

describe("signedPdfFilename", () => {
  it("is a uuid with a .pdf extension", () => {
    expect(signedPdfFilename()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/
    );
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 500 }, () => signedPdfFilename()));
    expect(seen.size).toBe(500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/signing-archive.test.ts`
Expected: FAIL — cannot resolve `../src/lib/signing/archive`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/signing/archive.ts`:

```ts
/**
 * Naming and digesting the archived signed PDF. Pure, so both halves of the
 * "these bytes are what the client saw" claim are testable without touching
 * a disk.
 */
import { createHash, randomUUID } from "node:crypto";

/** The digest stored in `Document.signedPdfSha256`. Not a security control
 * -- nobody untrusted can write to the uploads directory -- but the thing
 * that turns "here is a PDF" into "here is the PDF, and here is how you
 * check nothing has touched it since". */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A random name, matching the uuid shape `saveUpload` already writes, so
 * the archived PDFs sit alongside uploads without a second naming scheme.
 * The document number is deliberately NOT in the filename: it would put a
 * customer-identifying string on disk for no gain, and the mapping already
 * lives in `Document.signedPdfName`. */
export function signedPdfFilename(): string {
  return `${randomUUID()}.pdf`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/signing-archive.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the client actions**

Create `src/lib/actions/signing-client.ts`. It has no `auth()` call anywhere —
the token is the credential:

```ts
"use server";

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { uploadsDir, saveUpload } from "@/lib/uploads";
import { parseSignatureDataUrl } from "@/lib/signing/data-url";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
import { canComplete, canDecline, type SigningStatus } from "@/lib/signing/state";
import { sha256Hex, signedPdfFilename } from "@/lib/signing/archive";
import type { ActionResult } from "./_shared";

/** Every refusal on this route says the same thing. A visitor holding a bad
 * token learns nothing about whether a good one exists. */
const UNAVAILABLE = "This quote is no longer available for signing.";

/**
 * Stores the client's drawn signature. Does NOT complete the quote: the
 * signature exists first, and the separate confirmation commits it. That gap
 * is the window in which a client may redraw, or decline, having changed
 * their mind -- the thing DocuSign has no equivalent of.
 */
export async function signAsClient(token: string, dataUrl: string): Promise<ActionResult> {
  const request = await loadLiveRequest(token);
  if (!request) return { error: UNAVAILABLE };

  const parsed = parseSignatureDataUrl(dataUrl);
  if (!parsed.ok) return { error: "That signature could not be read. Please draw it again." };

  const file = new File([new Uint8Array(parsed.bytes)], "signature.png", { type: "image/png" });
  const imageUrl = await saveUpload(file, ["png"]);

  const head = await headers();
  await db.signature.upsert({
    where: { documentId_role: { documentId: request.documentId, role: "CLIENT" } },
    create: {
      documentId: request.documentId,
      role: "CLIENT",
      imageUrl,
      signerName: request.signerName,
      signerEmail: request.email,
      ip: head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: head.get("user-agent"),
    },
    update: {
      imageUrl,
      signedAt: new Date(),
      ip: head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: head.get("user-agent"),
    },
  });

  revalidatePath(`/sign/${token}`);
  return {};
}

/**
 * The point of no return.
 *
 * The PDF is rendered BEFORE the transaction opens, because it is a network
 * call to Gotenberg and has no business holding a database transaction. If it
 * fails, the transaction never starts: the quote stays VIEWED with the
 * signature intact and a retry works. There is no half-signed state.
 *
 * The emails are sent AFTER the transaction commits, and their failure is
 * logged rather than surfaced: the client pressed the button, the quote is
 * signed, and rolling that back to report a mail problem would be a lie in
 * the other direction. This is the trap already documented in
 * docs/email-sending-setup.md.
 */
export async function completeSigning(token: string): Promise<ActionResult> {
  const request = await loadLiveRequest(token);
  if (!request) return { error: UNAVAILABLE };
  if (!canComplete(request.signingStatus, request.hasClientSignature)) {
    return { error: UNAVAILABLE };
  }

  const pdf = await renderSignedPdf(request.documentId); // throws on Gotenberg failure
  const name = signedPdfFilename();
  await writeFile(path.join(uploadsDir(), name), pdf);

  const claimed = await db.document.updateMany({
    where: { id: request.documentId, signingStatus: { in: ["SENT", "VIEWED"] } },
    data: {
      signingStatus: "SIGNED",
      signedPdfName: name,
      signedPdfSha256: sha256Hex(pdf),
      completedAt: new Date(),
    },
  });
  // A second tab, or a double tap on a phone, loses this race and is told
  // nothing changed rather than producing a second completion.
  if (claimed.count === 0) return { error: UNAVAILABLE };

  await sendCompletionEmails(request.documentId);

  revalidatePath(`/sign/${token}`);
  return {};
}

export async function declineSigning(token: string, reason: string): Promise<ActionResult> {
  const request = await loadLiveRequest(token);
  if (!request) return { error: UNAVAILABLE };
  if (!canDecline(request.signingStatus)) return { error: UNAVAILABLE };

  const head = await headers();
  await db.$transaction(async (tx) => {
    await tx.signingRequest.update({
      where: { id: request.id },
      data: {
        declinedAt: new Date(),
        declineReason: reason.trim().slice(0, 2000) || null,
        declineIp: head.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      },
    });
    await tx.document.update({
      where: { id: request.documentId },
      data: { signingStatus: "DECLINED" },
    });
  });

  revalidatePath(`/sign/${token}`);
  return {};
}
```

Write the three private helpers in the same module:

- `loadLiveRequest(token)` — looks up by `hashSigningToken(token)`, runs
  `resolveLinkState`, returns `null` unless the state is `live`, and otherwise
  returns `{ id, documentId, email, signerName, signingStatus, hasClientSignature }`.
- `renderSignedPdf(documentId)` — the same three calls the existing
  `quotation-pdf` route makes (`getContentBlocksForRegion`,
  `buildQuotationData` with `fileImageResolver`, `renderQuotationHtml`,
  `htmlToPdf` with `buildFooterHtml`), so the archived PDF is byte-comparable
  with the live one.
- `sendCompletionEmails(documentId)` — sends
  `buildCompletionEmailForClient` (with the archived PDF attached) and
  `buildCompletionEmailForAuthor` (link only), each wrapped in its own
  try/catch logging `[signing] completion email failed`.

- [ ] **Step 6: Write the action bar**

Create `src/components/signing/client-action-bar.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { PenLine, Printer, Send } from "lucide-react";
import { SignatureDialog } from "./signature-dialog";
import { signAsClient, completeSigning } from "@/lib/actions/signing-client";
import { Button } from "@/components/ui/button";

/**
 * Sign | Print | Send, sticky at the foot of the client's quote.
 *
 * Send stays disabled until a signature exists, and its confirmation names
 * the quote, the total and the recipient before saying plainly that the
 * signature cannot be changed afterwards. DocuSign does not say that, which
 * is why its forums are full of people asking to unsign.
 *
 * Decline is deliberately NOT a fourth button here but a restrained link
 * rendered below the quote: three large adjacent buttons, one of which
 * irreversibly kills the deal, is an invitation to a stray thumb.
 */
export function ClientActionBar({
  token,
  completed,
  hasClientSignature,
  quoteNumber,
  total,
  authorName,
  authorEmail,
  signedOn,
}: {
  token: string;
  completed: boolean;
  hasClientSignature: boolean;
  quoteNumber: string;
  total: string;
  authorName: string;
  authorEmail: string;
  signedOn: string | null;
}) {
  const [drawing, setDrawing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (completed) {
    return (
      <div className="fixed inset-x-0 bottom-0 border-t bg-white px-4 py-3">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
          <span className="text-sm font-medium">Signed {signedOn}</span>
          <span className="text-sm text-neutral-500">
            Questions? {authorName}, {authorEmail}
          </span>
          <a className="text-sm underline" href={`/sign/${token}/pdf`}>
            Download PDF
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 border-t bg-white px-4 py-3">
        <div className="mx-auto flex max-w-4xl items-center justify-center gap-2">
          <Button type="button" disabled={hasClientSignature} onClick={() => setDrawing(true)}>
            <PenLine className="mr-2 h-4 w-4" />
            {hasClientSignature ? "Signed ✓" : "Sign"}
          </Button>

          <Button type="button" variant="outline" asChild>
            <a href={`/sign/${token}/pdf`} target="_blank" rel="noopener noreferrer">
              <Printer className="mr-2 h-4 w-4" />
              Print
            </a>
          </Button>

          <Button
            type="button"
            disabled={!hasClientSignature || pending}
            onClick={() => setConfirming(true)}
          >
            <Send className="mr-2 h-4 w-4" />
            Send
          </Button>
        </div>
        {error ? <p className="mt-2 text-center text-sm text-red-600">{error}</p> : null}
      </div>

      {drawing ? (
        <SignatureDialog
          title="Sign this quote"
          confirmLabel="Done"
          onCancel={() => setDrawing(false)}
          onConfirm={(dataUrl) => {
            setDrawing(false);
            startTransition(async () => {
              const result = await signAsClient(token, dataUrl);
              setError(result.error ?? null);
            });
          }}
        />
      ) : null}

      {confirming ? (
        <ConfirmSend
          quoteNumber={quoteNumber}
          total={total}
          authorName={authorName}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            startTransition(async () => {
              const result = await completeSigning(token);
              setError(result.error ?? null);
              setConfirming(false);
            })
          }
        />
      ) : null}
    </>
  );
}

function ConfirmSend({
  quoteNumber,
  total,
  authorName,
  pending,
  onCancel,
  onConfirm,
}: {
  quoteNumber: string;
  total: string;
  authorName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6">
        <h2 className="text-lg font-medium">Send signed quote?</h2>
        <p className="mt-3 text-sm">
          {quoteNumber} for <strong>{total}</strong> will be sent to{" "}
          <strong>{authorName}</strong>. A copy of the signed quote will be emailed to you.
        </p>
        <p className="mt-2 text-sm text-neutral-500">
          Once sent, the signature cannot be changed.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending}>
            {pending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

Pass the extra props (`quoteNumber`, `total`, `authorName`, `authorEmail`,
`signedOn`) from the page in Task 13, taking them from the same query. If
`ui-kit/confirm-dialog.tsx` already provides this shape, use it in place of
`ConfirmSend` rather than keeping a second dialog — read it first.

Render the decline link separately, below `QuotationSheet` in the page, opening
a small textarea dialog that calls `declineSigning(token, reason)`.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: clean.

Manually, end to end: send a quote, open it as the client, draw a signature,
reload and confirm it survived, redraw it, confirm, then check the manager's
email arrived, the client's email arrived with the PDF attached, and the
document shows SIGNED. Verify the stored digest:

```bash
docker compose exec app sh -c 'sha256sum /app/uploads/<signedPdfName>'
```

against `Document.signedPdfSha256`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/signing/archive.ts tests/signing-archive.test.ts src/lib/actions/signing-client.ts src/components/signing/client-action-bar.tsx
git commit -m "feat: clients sign, confirm, and receive an archived signed PDF"
```

---

### Task 15: The client's PDF route

**Files:**
- Create: `src/app/(sign)/sign/[token]/pdf/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { hashSigningToken } from "@/lib/signing/token";
import { resolveLinkState } from "@/lib/signing/link";
// Not `resolveUploadPath` — that one only accepts image extensions
// (IMAGE_URL_PATTERN). See Step 2 for the sibling this needs.
import { resolveSignedPdfPath } from "@/lib/uploads";
import type { SigningStatus } from "@/lib/signing/state";

export const runtime = "nodejs";

/**
 * The client's Print button.
 *
 * Before completion this renders the quote live, exactly as the in-app PDF
 * route does. After completion it streams the ARCHIVED bytes -- never a
 * re-render -- so what the client prints in a year is what they signed, and
 * its digest still matches `Document.signedPdfSha256`.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const request = await db.signingRequest.findUnique({
    where: { tokenHash: hashSigningToken(token) },
    select: {
      expiresAt: true,
      revokedAt: true,
      declinedAt: true,
      document: {
        select: { id: true, number: true, signingStatus: true, signedPdfName: true },
      },
    },
  });
  if (!request) return new Response("Not found", { status: 404 });

  const state = resolveLinkState({
    expiresAt: request.expiresAt,
    revokedAt: request.revokedAt,
    declinedAt: request.declinedAt,
    signingStatus: request.document.signingStatus as SigningStatus,
    now: new Date(),
  });
  if (state.kind !== "live" && state.kind !== "completed") {
    return new Response("Not found", { status: 404 });
  }

  const filename = `${request.document.number ?? "quotation"}.pdf`;

  if (state.kind === "completed" && request.document.signedPdfName) {
    const diskPath = resolveSignedPdfPath(request.document.signedPdfName);
    if (!diskPath) return new Response("Not found", { status: 404 });
    return new Response(Readable.toWeb(createReadStream(diskPath)) as ReadableStream, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  // Live render, sharing the pipeline the in-app route uses.
  const pdf = await renderQuotationPdfForDocument(request.document.id);
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
```

- [ ] **Step 2: Add `resolveSignedPdfPath`**

`resolveUploadPath` only accepts image extensions (`IMAGE_URL_PATTERN`), so the
archived PDF needs a sibling. In `src/lib/uploads.ts`, beside it:

```ts
/** The archived signed quotes written by `completeSigning`. A separate
 * pattern from `IMAGE_URL_PATTERN` rather than a widened one: every other
 * caller of `resolveUploadPath` serves its result as an image, and a
 * `.pdf` slipping through there would be served with the wrong content
 * type at best. Same uuid shape, same traversal guard. */
export const SIGNED_PDF_NAME_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pdf$/;

export function resolveSignedPdfPath(name: string): string | null {
  if (!SIGNED_PDF_NAME_PATTERN.test(name)) return null;
  const resolved = path.resolve(uploadsDir(), name);
  // Belt and braces: the pattern already forbids separators and dots, but
  // the containment check is what makes that a guarantee rather than a
  // property of the regex holding up under a later edit.
  if (!resolved.startsWith(path.resolve(uploadsDir()) + path.sep)) return null;
  return resolved;
}
```

Match the containment check to however `resolveUploadPath` already writes its
own — read it and copy the shape rather than introducing a second idiom.

Add to `tests/uploads.test.ts`:

```ts
import { resolveSignedPdfPath } from "../src/lib/uploads";

describe("resolveSignedPdfPath", () => {
  const VALID_PDF = "a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.pdf";

  it("resolves a valid uuid.pdf under uploadsDir()", () => {
    expect(resolveSignedPdfPath(VALID_PDF)).toBe(path.resolve(uploadsDir(), VALID_PDF));
  });

  it("rejects a traversal attempt", () => {
    expect(resolveSignedPdfPath("../../etc/passwd")).toBeNull();
    expect(resolveSignedPdfPath("../a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.pdf")).toBeNull();
  });

  it("rejects a non-pdf extension", () => {
    expect(resolveSignedPdfPath("a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.png")).toBeNull();
  });

  it("rejects a name that is not a uuid", () => {
    expect(resolveSignedPdfPath("quote.pdf")).toBeNull();
  });
});
```

Run: `npx vitest run tests/uploads.test.ts`
Expected: PASS, including the four new cases.

- [ ] **Step 3: Extract the renderer**

Move the render sequence out of
`src/app/api/quotes/[documentId]/quotation-pdf/route.ts` into
`src/lib/pdf.ts` as `renderQuotationPdfForDocument(documentId): Promise<Buffer>`
— `getContentBlocksForRegion`, `buildQuotationData` with `fileImageResolver`,
`renderQuotationHtml`, `htmlToPdf` with `buildFooterHtml`. Have the existing
route, `completeSigning` (Task 14) and this route all call it, so the archived
bytes and the live render come from one code path rather than three copies that
can drift.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: clean, with the new uploads cases passing.

Manually: print before signing (live render) and after (archived bytes);
confirm the second matches the stored digest.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(sign)/sign/[token]/pdf" src/lib/uploads.ts src/lib/pdf.ts "src/app/api/quotes" tests/uploads.test.ts
git commit -m "feat: clients print their quote, archived bytes once signed"
```

---

## Phase 7 — Manager visibility

### Task 16: Show signing state in the app

**Files:**
- Modify: `src/app/(app)/quotes/page.tsx`
- Modify: `src/app/(app)/quotes/[documentId]/page.tsx`
- Modify: `src/components/ui-kit/status-badge.tsx` if new tones are needed

- [ ] **Step 1: Add the badge**

Read `src/components/ui-kit/status-badge.tsx` and `STATUS_TONE`, then add
signing tones: `SENT` neutral, `VIEWED` informational, `SIGNED` positive,
`DECLINED` negative. `NOT_SENT` renders nothing — an unsent quote is the
ordinary case and does not need a label.

- [ ] **Step 2: Show it in the list and on the document**

Add the badge beside the existing DRAFT/FINAL badge in the documents list, and
on the document page add a panel showing: current state, when it was sent and
to which address, when it was first viewed, when it was signed or declined,
the decline reason when there is one, and a Revoke button when
`canRevoke(signingStatus)`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: clean.

Manually: walk one quote through send → view → sign and confirm each state
appears in both places.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/quotes" src/components/ui-kit/status-badge.tsx
git commit -m "feat: managers see where each quote sits in the signing flow"
```

---

### Task 17: Documentation

**Files:**
- Modify: `docs/runbook.md`
- Modify: `docs/email-sending-setup.md`

- [ ] **Step 1: Add a runbook entry**

Following the format of the existing entries, add "Quote signing" covering:
the four emails and when each fires; where archived PDFs live and how to verify
one's digest; that a signed quote cannot be unfinalized and why; how to revoke
and resend; and the `signing.linkValidityDays` setting with the note that it is
frozen per-request.

- [ ] **Step 2: Update the email doc**

`docs/email-sending-setup.md` says quote emailing is "Not wired up yet" and
that `resolveReplyTo` is unused. Replace that paragraph: it is now wired, name
`src/lib/actions/signing.ts` as the caller, and add the four signing emails to
the "Who receives replies" table.

- [ ] **Step 3: Commit**

```bash
git add docs/runbook.md docs/email-sending-setup.md
git commit -m "docs: runbook and email notes for quote signing"
```

---

## Definition of done

- [ ] `npm test` passes; `npm run typecheck` clean; `npm run lint` clean.
- [ ] A quote can be finalized, signed by its author, sent, opened, signed by the client, confirmed, and the archived PDF's SHA-256 matches `Document.signedPdfSha256`.
- [ ] `unfinalizeDocument` refuses a SIGNED quote and, on a SENT one, revokes links and drops the author's signature.
- [ ] Revoking kills the link and emails the client.
- [ ] Declining records a reason and shows the manager.
- [ ] `curl -I /sign/<bad-token>` returns the not-found page, not a login redirect, and a nonexistent token is indistinguishable from someone else's.
- [ ] `tests/signing-exposure.test.ts` fails if a commission field is added to the signing query (verify by adding one temporarily).
- [ ] No test in the suite uses `vi.mock`, `vi.fn`, fake timers, a database, or the network.
