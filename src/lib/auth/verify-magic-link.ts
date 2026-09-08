// Orchestration for magic-link verification, with its two dependencies passed
// in rather than imported.
//
// `lookup` is the read-only row fetch; `consume` is the delegation to
// @auth/core that actually spends the token. Keeping them as parameters is not
// ceremony — it is what lets the tests assert the property this whole feature
// rests on: that a request without the challenge never reaches `consume` at
// all. Asserting "the row is still there afterwards" needs a database;
// asserting "the consuming path was never invoked" is the same guarantee,
// checked against the code rather than against a fixture.

import { decideChallenge, hashVerificationToken, type ChallengeRow } from "./magic-challenge";
import { safeCallbackUrl } from "./safe-callback-url";

export type VerifyOutcome =
  | { status: 200; redirectTo: string }
  | { status: 401 }
  | { status: 403 }
  | { status: 409 }
  | { status: 500 };

/**
 * Why @auth/core turned the token down.
 *
 * The distinction earns its keep: "invalid" is the ordinary expired-or-spent
 * link and deserves "request a new one", while "error" is our own outage —
 * @auth/core reports an unreachable database the same way it reports anything
 * else, through a redirect to its error page. Collapsing them would tell a
 * user their link had expired during a database incident, sending them to
 * request new links that cannot work either.
 */
export type ConsumeResult =
  | { ok: true; redirectTo: string }
  | { ok: false; reason: "invalid" | "denied" | "error" };

export type VerifyDeps = {
  /** Read-only fetch of the token row. Must never mutate. */
  lookup: (tokenHash: string) => Promise<ChallengeRow>;
  /**
   * Hands the request to @auth/core, which performs the atomic delete and
   * mints the session.
   */
  consume: (args: {
    token: string;
    email: string;
    destination: string;
  }) => Promise<ConsumeResult>;
};

export async function verifyMagicLink(
  input: {
    token: string;
    email: string;
    callbackUrl?: string;
    confirmed: boolean;
    cookie?: string;
    origin: string;
    secret: string;
    now?: Date;
  },
  deps: VerifyDeps
): Promise<VerifyOutcome> {
  const destination = safeCallbackUrl(input.callbackUrl, input.origin) ?? "/";

  const row = await deps.lookup(hashVerificationToken(input.token, input.secret));

  const decision = decideChallenge({
    row,
    cookie: input.cookie,
    confirmed: input.confirmed,
    now: input.now,
  });

  // The refusal path. Returns before `consume` is so much as constructed, so
  // the token is still spendable by whoever presses the button next — which is
  // the entire point: the scanner lands here, the human lands in the branch
  // below a minute later.
  if (decision === "confirm") return { status: 409 };

  const result = await deps.consume({
    token: input.token,
    email: input.email,
    destination,
  });

  if (result.ok) return { status: 200, redirectTo: result.redirectTo };
  if (result.reason === "denied") return { status: 403 };
  if (result.reason === "error") return { status: 500 };
  return { status: 401 };
}
