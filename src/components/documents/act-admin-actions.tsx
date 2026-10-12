"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import {
  linkHeldContact,
  releaseHeldContact,
  retryActWrite,
  stopActWrite,
  type ActOutboxActionResult,
} from "@/lib/actions/act-outbox";
import type { AdminActions } from "@/lib/act/outbox-admin";
import type { AdminHelp } from "@/lib/act/quote-act-view";

/**
 * The administrator's buttons on a quote's ACT! card. Rendered by
 * ActStateCard for an admin only, and only the actions `actions` offers --
 * adminActionsFor in src/lib/act/outbox-admin.ts, the same rules each action
 * checks again on the server. Every word comes in `help`, from adminHelpFor
 * in src/lib/act/quote-act-view.ts.
 *
 * The two actions nothing on the page can take back -- "ACT! has nobody" and
 * "Don't send" -- ask first, through the app's confirm dialog, as deleting a
 * quote does (src/components/documents/delete-document-button.tsx). The other
 * two do not: "Try again now" only makes a held row due, and "ACT! has this
 * person" is already a deliberate act, an id typed and submitted.
 */
export function ActAdminActions({
  documentId,
  actions,
  help,
}: {
  documentId: string;
  actions: AdminActions;
  help: AdminHelp;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [actId, setActId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const helpIds = {
    tryAgain: useId(),
    contactFound: useId(),
    contactAbsent: useId(),
    dontSend: useId(),
  };

  function run(call: () => Promise<ActOutboxActionResult>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await call();
        if (result.error) {
          setError(result.error);
          return;
        }
        if (result.message) toast.success(result.message);
        setActId("");
        router.refresh();
      } catch {
        // A throw is requireAdmin turning the session away -- the page
        // renders this for an admin only, so the session changed under it --
        // or the server failing. Neither comes with a sentence of its own.
        setError("That did not go through — reload the page and try again.");
      }
    });
  }

  async function confirmThen(words: AdminHelp["dontSend"]["confirm"], call: () => Promise<ActOutboxActionResult>) {
    const confirmed = await confirm({
      title: words.title,
      description: words.description,
      confirmLabel: words.confirmLabel,
      tone: "danger",
    });
    if (confirmed) run(call);
  }

  return (
    <div className="flex flex-col gap-4">
      {actions.tryAgain ? (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="w-full"
            disabled={pending}
            aria-describedby={helpIds.tryAgain}
            onClick={() => run(() => retryActWrite(documentId))}
          >
            {help.tryAgain.label}
          </Button>
          <p id={helpIds.tryAgain} className="text-xs text-slate-500">
            {help.tryAgain.help}
          </p>
        </div>
      ) : null}

      {actions.contactFound ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => linkHeldContact(documentId, actId));
          }}
        >
          <p className="text-sm font-medium text-brand-dark">{help.contactFound.label}</p>
          <p id={helpIds.contactFound} className="text-xs text-slate-500">
            {help.contactFound.help}
          </p>
          <label htmlFor={fieldId} className="sr-only">
            {help.contactFound.field}
          </label>
          <input
            id={fieldId}
            value={actId}
            onChange={(event) => setActId(event.target.value)}
            placeholder={help.contactFound.field}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={helpIds.contactFound}
            className={`${fieldInputClass} font-mono text-sm`}
          />
          <Button type="submit" variant="outline" size="touch" className="w-full" disabled={pending || actId.trim() === ""}>
            {help.contactFound.submit}
          </Button>
        </form>
      ) : null}

      {actions.contactAbsent ? (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="destructive"
            size="touch"
            className="w-full"
            disabled={pending}
            aria-describedby={helpIds.contactAbsent}
            onClick={() => confirmThen(help.contactAbsent.confirm, () => releaseHeldContact(documentId))}
          >
            {help.contactAbsent.label}
          </Button>
          <p id={helpIds.contactAbsent} className="text-xs text-slate-500">
            {help.contactAbsent.help}
          </p>
        </div>
      ) : null}

      {actions.dontSend ? (
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="destructive"
            size="touch"
            className="w-full whitespace-normal"
            disabled={pending}
            aria-describedby={helpIds.dontSend}
            onClick={() => confirmThen(help.dontSend.confirm, () => stopActWrite(documentId))}
          >
            {help.dontSend.label}
          </Button>
          <p id={helpIds.dontSend} className="text-xs text-slate-500">
            {help.dontSend.help}
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
