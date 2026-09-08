import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ConfirmClient } from "./confirm-client";

// Landing page for a magic link.
//
// The email points here rather than at /api/auth/callback/nodemailer, because
// that callback signs you in on GET: @auth/prisma-adapter's
// `useVerificationToken` is a DELETE that @auth/core runs before it validates
// anything, so the first machine to fetch the URL both burned the link and
// collected a session. On 2026-09-07 a link scanner did exactly that, 31
// seconds before the mail reached the recipient's inbox.
//
// Fetching this page spends nothing. The token is only spent by the POST the
// client component makes — silently when the browser can present the challenge
// cookie minted at request time, behind a button otherwise. See
// src/lib/auth/magic-challenge.ts for why the challenge is a UX gate and not
// an authorization one.

export const metadata: Metadata = {
  // The URL in the address bar is a live credential for the next few minutes.
  // Keep it out of indexes, and out of the Referer header on the way out.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// Never prerendered, never cached: the response is specific to one token, and
// a shared cache holding it would be a credential leak.
export const dynamic = "force-dynamic";

type ConfirmPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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

  // Opened by hand, or a mail client mangled the link. Nothing has been spent,
  // so the only honest thing to say is "start over". `callbackUrl` is passed
  // through unvalidated on purpose: /api/auth/magic-verify is the trust
  // boundary and checks it there, and duplicating the check here would mean
  // two places to keep right instead of one.
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

  return (
    <Shell>
      <ConfirmClient token={token} email={email} callbackUrl={first(params.callbackUrl)} />
    </Shell>
  );
}
