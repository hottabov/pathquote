import { NextRequest, NextResponse } from "next/server";
import { handlers } from "@/auth";
import { challengeCookieName } from "@/lib/auth/magic-challenge";
import { consumeResultFromLocation, grantedResponse } from "@/lib/auth/magic-verify-response";
import { verifyMagicLink } from "@/lib/auth/verify-magic-link";
import { db } from "@/lib/db";

// Verify a magic link. POST only, on purpose: this is the endpoint that spends
// the token, and everything about the 2026-09-07 incident came from spending
// being reachable by a GET that a link scanner could make on the recipient's
// behalf. Scanners follow links; they do not post JSON.
//
// The division of labour here is the part worth keeping straight:
//
//   - This route may REFUSE. It performs one read-only lookup and, if the
//     browser cannot present the challenge minted when the link was requested,
//     answers 409 and touches nothing — the token stays spendable for whoever
//     presses the button next.
//
//   - This route may not GRANT. When the pre-check has no objection it hands
//     the request to @auth/core's own callback, whose single atomic
//     `DELETE … WHERE identifier = $1 AND token = $2 RETURNING *` remains the
//     only thing that decides a token is real and the only thing that spends
//     it. We never mint a session ourselves; we pass through the Set-Cookie
//     that @auth/core produced.
//
// That split is what keeps the guarantees intact. The single-use property and
// the expiry check are still enforced in one statement by the library, and a
// bug in the challenge logic can at worst refuse a legitimate sign-in — it
// cannot manufacture one.

export const runtime = "nodejs";

type VerifyBody = {
  token?: unknown;
  email?: unknown;
  callbackUrl?: unknown;
  confirmed?: unknown;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function POST(request: NextRequest) {
  let body: VerifyBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = str(body.token);
  const email = str(body.email);
  if (!token || !email) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    console.error("[auth] AUTH_SECRET is not set; cannot verify a magic link");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  // The public origin, not necessarily the one this request arrived on:
  // behind the reverse proxy `request.nextUrl.origin` can be the container's
  // own address, while the callbackUrl in the email is an absolute URL on the
  // public one. Compared against an internal origin it would fail the
  // same-origin check and every deep link would collapse to "/".
  const origin = process.env.AUTH_URL ? new URL(process.env.AUTH_URL).origin : request.nextUrl.origin;
  const cookieName = challengeCookieName();

  // Set by `consume` below so the session cookies @auth/core minted can be
  // copied onto our own JSON response.
  let granted: Response | undefined;

  const outcome = await verifyMagicLink(
    {
      token,
      email,
      callbackUrl: str(body.callbackUrl),
      confirmed: body.confirmed === true,
      cookie: request.cookies.get(cookieName)?.value,
      origin,
      secret,
    },
    {
      // Read-only, and selects only what the decision needs — it must not be
      // able to spend anything, so it does not even read the identifier.
      lookup: (tokenHash) =>
        db.verificationToken.findUnique({
          where: { token: tokenHash },
          select: { expires: true, challengeHash: true },
        }),

      // Hand over to @auth/core. Its callback reads token and email from the
      // query string even on a POST, and validates a CSRF token only for
      // credentials providers, so the parameters stay where they already are
      // and the forwarded request needs no body.
      consume: async ({ token: raw, email: identifier, destination }) => {
        const callback = new URL("/api/auth/callback/nodemailer", origin);
        callback.searchParams.set("token", raw);
        callback.searchParams.set("email", identifier);
        callback.searchParams.set("callbackUrl", destination);

        // Must be a NextRequest, not a plain Request. next-auth's handler runs
        // the request through `reqWithEnvURL`, which destructures
        // `req.nextUrl` whenever AUTH_URL is set — and it is set here, so a
        // plain Request throws a TypeError before the handler does any work.
        const forwarded = new NextRequest(callback, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            // Carries the cookie jar through for @auth/core's own bookkeeping.
            cookie: request.headers.get("cookie") ?? "",
          },
          body: "",
        });

        granted = await handlers.POST(forwarded);
        return consumeResultFromLocation(granted.headers.get("location") ?? "", origin);
      },
    }
  );

  if (outcome.status === 409) {
    // Says nothing about the token. An unknown, expired or already-spent token
    // never reaches this branch, so a 409 cannot tell a prober that a token is
    // live.
    return NextResponse.json({ requiresConfirmation: true }, { status: 409 });
  }

  if (outcome.status === 401) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  if (outcome.status === 403) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  if (outcome.status === 500) {
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }

  return grantedResponse(outcome.redirectTo, granted?.headers.getSetCookie() ?? []);
}
