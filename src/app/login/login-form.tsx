"use client";

import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { loginWithPassword, sendMagicLink } from "@/lib/actions/auth";

type ActionResult = { error?: string; success?: string; sentTo?: string };

const initialState: ActionResult = {};

type LoginFormProps = {
  /** Same-origin relative path to send the user to after signing in, by either method. */
  callbackUrl?: string;
};

export function LoginForm({ callbackUrl = "/" }: LoginFormProps) {
  const [passwordState, passwordAction, passwordPending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => loginWithPassword(formData),
    initialState
  );
  const [magicLinkState, magicLinkAction, magicLinkPending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => sendMagicLink(formData),
    initialState
  );

  // Once a link is on its way there is nothing left to do on this page, so the
  // forms come down entirely — leaving them up invites a second submission
  // that only burns through the rate limit.
  if (magicLinkState.sentTo) {
    return (
      <div role="status" className="flex flex-col items-center gap-4 py-4 text-center">
        <MailCheck aria-hidden="true" className="size-12 text-brand-accent-ink" strokeWidth={1.5} />
        <div>
          <p className="text-base font-semibold text-brand-dark">Check your email!</p>
          <p className="mt-1 text-sm text-slate-500">
            We sent a link to{" "}
            <span className="font-medium break-all text-brand-dark">{magicLinkState.sentTo}</span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <form action={magicLinkAction} className="flex flex-col gap-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <FieldRow label="Email" htmlFor="magic-email" error={magicLinkState.error}>
          <input
            id="magic-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className={fieldInputClass}
          />
        </FieldRow>
        <Button
          type="submit"
          disabled={magicLinkPending}
          className="h-12 w-full bg-brand text-base text-white hover:bg-brand/90"
        >
          {magicLinkPending ? "Sending…" : "Send magic link"}
        </Button>
      </form>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-slate-200" />
        <span className="text-xs font-medium tracking-wide text-slate-400 uppercase">or</span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <form action={passwordAction} className="flex flex-col gap-4">
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
        <FieldRow label="Email" htmlFor="email">
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className={fieldInputClass}
          />
        </FieldRow>
        <FieldRow label="Password" htmlFor="password" error={passwordState.error}>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={fieldInputClass}
          />
        </FieldRow>
        <Button
          type="submit"
          variant="outline"
          disabled={passwordPending}
          className="h-12 w-full border-brand-accent-ink text-base text-brand-accent-ink hover:bg-brand-accent/10"
        >
          {passwordPending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
