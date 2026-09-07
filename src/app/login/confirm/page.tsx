import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

// The interstitial that makes magic links survive automated link scanners.
//
// The email used to link straight to /api/auth/callback/nodemailer. That route
// spends the token on GET — @auth/prisma-adapter's `useVerificationToken` is a
// DELETE that @auth/core runs before it checks anything — so the first machine
// to fetch the URL both burned the link and got a real 7-day session. On
// 2026-09-07 a scanner did exactly that 24 seconds after send, 31 seconds
// before the mail reached the recipient's inbox; the human's click failed with
// "The sign in link is no longer valid". See src/lib/email/magic-link-url.ts.
//
// So the email points here instead. This page is an ordinary GET: fetching it
// as many times as you like costs nothing. The token is spent only by the POST
// below, which needs a human to press a button. Scanners follow links; they do
// not submit forms.
//
// Deliberately zero-JavaScript — a plain <form> and a plain <button>, no client
// component, no useEffect. An auto-submitting page would hand the token
// straight back to any scanner that executes scripts, which is most of the
// modern ones, and would undo the entire fix.

export const metadata: Metadata = {
  // The URL carries a live credential. Keep it out of indexes, and out of the
  // Referer header on any navigation away from this page.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const CALLBACK_PATH = "/api/auth/callback/nodemailer";

type ConfirmPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Auth.js sends the user wherever `callbackUrl` says, so it is a redirect
 * target arriving in a URL — the classic open-redirect shape. @auth/core's
 * default `redirect` callback already refuses foreign origins, but this page
 * is the thing that decides whether the parameter is forwarded at all, so it
 * gets its own check rather than relying on a library default staying put.
 * Anything unrecognised is dropped, and the sign-in lands on "/".
 */
function safeCallbackUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // A same-origin relative path. "//host/path" is protocol-relative and would
  // navigate off-site, so a second leading slash disqualifies it.
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  const base = process.env.AUTH_URL;
  if (!base) return undefined;
  try {
    return new URL(value).origin === new URL(base).origin ? value : undefined;
  } catch {
    return undefined;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-1 items-center justify-center bg-brand-dark px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg sm:p-8">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Image
            src="/pathquote-logo.png"
            alt=""
            aria-hidden="true"
            width={512}
            height={512}
            priority
            className="size-14 rounded-xl object-cover shadow-sm"
          />
          <h1 className="text-2xl font-semibold text-brand-dark">PathQuote</h1>
        </div>
        {children}
      </div>
    </div>
  );
}

export default async function ConfirmPage({ searchParams }: ConfirmPageProps) {
  const params = await searchParams;
  const token = first(params.token);
  const email = first(params.email);
  const callbackUrl = safeCallbackUrl(first(params.callbackUrl));

  // Someone opened /login/confirm by hand, or a mail client mangled the link.
  // Nothing has been consumed, so the only honest thing to say is "start over".
  if (!token || !email) {
    return (
      <Shell>
        <div className="flex flex-col gap-4 text-center">
          <p className="text-base font-semibold text-brand-dark">This link is incomplete</p>
          <p className="text-sm text-slate-500">
            Open the most recent sign-in email again, or request a new link.
          </p>
          <Link
            href="/login"
            className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand text-base font-medium text-white hover:bg-brand/90"
          >
            Back to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  // The parameters ride in the query string, not in the body: @auth/core reads
  // `token` and `email` from `request.query` even on a POST (see
  // node_modules/@auth/core/lib/actions/callback/index.js). No csrfToken field
  // is needed either — that check runs only for credentials providers
  // (node_modules/@auth/core/lib/index.js).
  const action = new URLSearchParams({ token, email });
  if (callbackUrl) action.set("callbackUrl", callbackUrl);

  return (
    <Shell>
      <form method="POST" action={`${CALLBACK_PATH}?${action}`} className="flex flex-col gap-4">
        <div className="text-center">
          <p className="text-base font-semibold text-brand-dark">Confirm sign-in</p>
          <p className="mt-1 text-sm text-slate-500">
            Continue as <span className="font-medium break-all text-brand-dark">{email}</span>
          </p>
        </div>
        <button
          type="submit"
          className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand text-base font-medium text-white hover:bg-brand/90"
        >
          Sign in
        </button>
        <p className="text-center text-xs text-slate-400">
          If you didn&apos;t request this, close this page — nothing has happened yet.
        </p>
      </form>
    </Shell>
  );
}
