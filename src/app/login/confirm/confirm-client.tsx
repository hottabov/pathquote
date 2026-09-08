"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

// The two lanes of magic-link verification, from the browser's side.
//
// On mount this posts the token once. If this is the browser that requested
// the link it holds the challenge cookie, the post returns 200, and the user
// lands signed in having clicked nothing — the same experience as before any
// of this existed. If it is not that browser — the link was opened on a phone,
// or fetched by a scanner in the recipient's mail pipeline — the server
// answers 409 without spending the token, and a human has to press a button.
//
// The scanner never presses it, so the token survives for the real click.

type Phase = "verifying" | "confirm" | "invalid" | "denied" | "error";

type ConfirmClientProps = {
  token: string;
  email: string;
  callbackUrl?: string;
};

export function ConfirmClient({ token, email, callbackUrl }: ConfirmClientProps) {
  // Initial phase belongs in the initializer, not in an effect. Setting state
  // synchronously from an effect trips react-hooks/set-state-in-effect and
  // causes an extra render pass for no reason.
  const [phase, setPhase] = useState<Phase>("verifying");
  const [pending, setPending] = useState(false);

  // React StrictMode invokes effects twice in development. Without this guard
  // the second invocation posts the same token again; the first post has
  // already spent it, so the second comes back 401 and every local sign-in
  // looks broken.
  const attempted = useRef(false);

  async function verify(confirmed: boolean) {
    const response = await fetch("/api/auth/magic-verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token, email, callbackUrl, confirmed }),
    });

    if (response.ok) {
      const { redirectTo } = (await response.json()) as { redirectTo?: string };
      // A full navigation, not a router push: the destination is server
      // rendered against the session cookie this response just set, and a
      // client-side transition would render it against the old, absent one.
      window.location.assign(redirectTo || "/");
      return "verifying" as const;
    }
    if (response.status === 409) return "confirm" as const;
    // 401 is the link: expired, or already used. 403 is the account: it was
    // deactivated between requesting the link and opening it. Everything else
    // is our side being broken, and must not be dressed up as an expired link
    // — that sends someone to request new links during an outage.
    if (response.status === 401) return "invalid" as const;
    if (response.status === 403) return "denied" as const;
    return "error" as const;
  }

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    verify(false).then(setPhase, () => setPhase("error"));
    // Intentionally runs once, for the token this page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "verifying") {
    return (
      <p role="status" className="py-4 text-center text-sm text-slate-500">
        Signing you in…
      </p>
    );
  }

  if (phase === "invalid") {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-base font-semibold text-brand-dark">This link has expired</p>
        <p className="text-sm text-slate-500">
          Sign-in links are valid for 15 minutes and can only be used once. Request a new one.
        </p>
        <Link
          href="/login"
          className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand text-base font-medium text-white hover:bg-brand/90"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  if (phase === "denied") {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-base font-semibold text-brand-dark">This account can&apos;t sign in</p>
        <p className="text-sm text-slate-500">
          The link is fine, but the account is no longer active. Ask an administrator to re-enable
          it.
        </p>
        <Link
          href="/login"
          className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand text-base font-medium text-white hover:bg-brand/90"
        >
          Back to sign in
        </Link>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-base font-semibold text-brand-dark">Something went wrong</p>
        <p className="text-sm text-slate-500">
          The link could not be checked just now. Try again, or request a new one.
        </p>
        <button
          type="button"
          onClick={() => {
            setPending(true);
            verify(true).then(
              (next) => {
                setPending(false);
                setPhase(next);
              },
              () => {
                setPending(false);
                setPhase("error");
              }
            );
          }}
          className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand text-base font-medium text-white hover:bg-brand/90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-center">
      <div>
        <p className="text-base font-semibold text-brand-dark">Confirm your sign-in</p>
        <p className="mt-1 text-sm text-slate-500">
          Continue as <span className="font-medium break-all text-brand-dark">{email}</span>
        </p>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setPending(true);
          verify(true).then(
            (next) => {
              setPending(false);
              setPhase(next);
            },
            () => {
              setPending(false);
              setPhase("error");
            }
          );
        }}
        className="inline-flex h-12 w-full items-center justify-center rounded-md bg-brand text-base font-medium text-white hover:bg-brand/90 disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-xs text-slate-400">
        You&apos;re seeing this because the link was opened somewhere other than the browser that
        requested it.
      </p>
    </div>
  );
}
