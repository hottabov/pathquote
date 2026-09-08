// PrismaAdapter, wrapped so that a verification token can carry the challenge
// nonce minted for the browser that requested it.
//
// The awkwardness this solves: @auth/core owns the creation of the token row
// and writes exactly `{ identifier, token, expires }` — it knows nothing about
// our extra column, and gives no hook for adding one. Meanwhile the nonce is
// minted in `sendMagicLink`, several frames up the same request, and the
// adapter method is called deep inside `signIn()` with no argument path
// between them.
//
// AsyncLocalStorage is the join. `withPendingChallenge` wraps the `signIn()`
// call; `createVerificationToken` reads the value back out. It is scoped to
// one request by construction, so two people requesting links at the same
// moment cannot see each other's nonce — which a module-level variable would
// have allowed, and which would have handed one person's sign-in to another.

import { AsyncLocalStorage } from "node:async_hooks";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, VerificationToken } from "@auth/core/adapters";
import { db } from "@/lib/db";

const pendingChallenge = new AsyncLocalStorage<string>();

/**
 * Runs `fn` with `challengeHash` visible to `createVerificationToken`.
 *
 * Everything the callback awaits stays inside the same async context, so the
 * value is still there when @auth/core gets around to writing the row.
 */
export function withPendingChallenge<T>(challengeHash: string, fn: () => Promise<T>): Promise<T> {
  return pendingChallenge.run(challengeHash, fn);
}

const base = PrismaAdapter(db);

export const adapter: Adapter = {
  ...base,
  async createVerificationToken(data: VerificationToken) {
    // Absent whenever a token is created outside a magic-link request — and,
    // more importantly, absent is a legitimate state rather than an error: the
    // column is nullable precisely so that a row without a challenge behaves
    // the way every row behaved before this feature existed.
    const challengeHash = pendingChallenge.getStore() ?? null;
    const created = await db.verificationToken.create({
      data: {
        identifier: data.identifier,
        token: data.token,
        expires: data.expires,
        challengeHash,
      },
    });
    return created;
  },
};
