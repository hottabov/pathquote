"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import type { AccountMgrOption, ActUserOption } from "@/lib/act/user-link";

/**
 * The controls of the ACT! section on Settings → Users → <user>: which ACT!
 * user this person is, and their Acc Mgr value. Every option comes from ACT!,
 * read on the server (ActUserLinkSection); the save re-reads both lists and
 * checks the pair again (setUserActLink), so nothing here is the safeguard.
 *
 * Suggestions are hints with a "Choose it" button, never a preselection: the
 * admin decides, then presses Save.
 *
 * Values live in state and the FormData is built in `handleSubmit`, rather
 * than handing React the action, for the reason EditUserForm gives: React 19
 * resets a `<form action>` after it settles, which would put both selects back
 * to their DOM default while the state still said otherwise.
 */
export function ActUserLinkForm({
  action,
  actUserOptions,
  accountMgrOptions,
  storedActUserId,
  storedAccountMgr,
  suggestedActUser,
  disabledReason,
}: {
  action: (formData: FormData) => Promise<{ error?: string }>;
  actUserOptions: ActUserOption[];
  accountMgrOptions: AccountMgrOption[];
  storedActUserId: string | null;
  storedAccountMgr: string | null;
  /** Shown only when nothing is stored: the one ACT! user named like this user. */
  suggestedActUser: { id: string; label: string; suggestedAccountMgr: string | null } | null;
  /** Set when ACT! could not be read: the selects and Save are disabled. */
  disabledReason: string | null;
}) {
  const [actUserId, setActUserId] = useState(storedActUserId ?? "");
  const [accountMgr, setAccountMgr] = useState(storedAccountMgr ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const disabled = disabledReason !== null || pending;

  const showActUserHint = !disabledReason && storedActUserId === null && actUserId === "" && suggestedActUser !== null;

  // The Acc Mgr hint follows whichever ACT! user is chosen, or the suggested
  // one while none is.
  const chosen = actUserOptions.find((option) => option.value === actUserId);
  const accountMgrHint = chosen ? chosen.suggestedAccountMgr : (suggestedActUser?.suggestedAccountMgr ?? null);
  const showAccountMgrHint = !disabledReason && storedAccountMgr === null && accountMgr === "" && accountMgrHint !== null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabledReason) return;
    const formData = new FormData();
    formData.set("actUserId", actUserId);
    formData.set("accountMgr", accountMgr);
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success("ACT! link saved");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <FieldRow
            label="ACT! user"
            htmlFor="act-link-user"
            hint="Inactive ACT! users can be chosen: distributors are Inactive users with no email."
          >
            <select
              id="act-link-user"
              value={actUserId}
              onChange={(e) => setActUserId(e.target.value)}
              disabled={disabled}
              className={fieldInputClass}
            >
              <option value="">— not linked —</option>
              {actUserOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FieldRow>
          {showActUserHint && suggestedActUser ? (
            <Suggestion
              text={suggestedActUser.label}
              onChoose={() => setActUserId(suggestedActUser.id)}
              disabled={disabled}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <FieldRow
            label="Acc Mgr"
            htmlFor="act-link-account-mgr"
            hint="A distributor must be added to the Rep list in ACT! by an ACT! administrator before they can be chosen here."
          >
            <select
              id="act-link-account-mgr"
              value={accountMgr}
              onChange={(e) => setAccountMgr(e.target.value)}
              disabled={disabled}
              className={fieldInputClass}
            >
              <option value="">— none —</option>
              {accountMgrOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FieldRow>
          {showAccountMgrHint && accountMgrHint ? (
            <Suggestion text={accountMgrHint} onChoose={() => setAccountMgr(accountMgrHint)} disabled={disabled} />
          ) : null}
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={disabled} className="h-11 w-full sm:w-auto sm:self-start">
        {pending ? "Saving…" : "Save ACT! link"}
      </Button>
    </form>
  );
}

/** "Suggested: <name>" under a select, with a button that only chooses it --
 *  saving is still the admin's Save. */
function Suggestion({ text, onChoose, disabled }: { text: string; onChoose: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-slate-200 px-3 py-2 text-sm text-slate-600">
      <span className="min-w-0">
        Suggested: <span className="font-medium text-brand-dark">{text}</span>
        <span className="block text-xs text-slate-500">Matched by name. Nothing is saved until you choose it and press Save.</span>
      </span>
      <Button type="button" variant="outline" onClick={onChoose} disabled={disabled} className="h-11">
        Choose it
      </Button>
    </div>
  );
}
