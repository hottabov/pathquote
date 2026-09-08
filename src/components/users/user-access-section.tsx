"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useConfirm, useToast } from "@/components/ui-kit/client";
import { deleteUser, reassignUserCompanies, setUserActive } from "@/lib/actions/users";
import type { UserFootprint } from "@/lib/queries/users";
import { cn } from "@/lib/utils";

export type HandoverCandidate = { id: string; email: string; name: string | null };

/**
 * Everything an admin does to an account rather than to its details: revoke or
 * restore access, hand its clients to someone else, and — only for an account
 * that left nothing behind — delete it.
 *
 * The order on screen is the order of the actual decision when someone leaves.
 * Hand the clients over first, because a company is visible to a manager only
 * if they own it: leave them with the departed account and no other manager can
 * see those clients at all, while everything still looks correct to the admin
 * checking. Then deactivate, which is the real answer to a departure — the
 * quotes they wrote keep their name on them and stay where they are. Delete is
 * the narrow case at the bottom: the address typed wrong, the account that
 * never got used.
 *
 * Every rule here is enforced server-side (`canModifyUser`, and `deleteUser`'s
 * own re-read of the footprint). What this component knows is used only to
 * explain and to disable a button that was never going to work — never as the
 * check itself.
 */
export function UserAccessSection({
  userId,
  userLabel,
  active,
  isSelf,
  isLastActiveAdmin,
  footprint,
  handoverCandidates,
}: {
  userId: string;
  /** Name if they have one, else email — whatever the rest of the page calls
   * them, so a confirmation names the same person the heading does. */
  userLabel: string;
  active: boolean;
  isSelf: boolean;
  isLastActiveAdmin: boolean;
  footprint: UserFootprint;
  handoverCandidates: HandoverCandidate[];
}) {
  const confirm = useConfirm();
  const toast = useToast();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoverToId, setHandoverToId] = useState("");

  async function run(action: () => Promise<{ error?: string }>): Promise<boolean> {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (result.error) {
      setError(result.error);
      return false;
    }
    return true;
  }

  // Both guards are the server's; repeated here only to explain the disabled
  // button rather than let an admin click into a refusal.
  const accessLocked = isSelf || (active && isLastActiveAdmin);
  const accessLockedReason = isSelf
    ? "You can't deactivate your own account."
    : "This is the last active admin — another admin must exist first.";

  const deletable =
    footprint.companies === 0 &&
    footprint.documents === 0 &&
    footprint.supportMessages === 0 &&
    footprint.catalogImports === 0;

  async function toggleAccess() {
    const ok = await confirm(
      active
        ? {
            title: `Deactivate ${userLabel}?`,
            description:
              footprint.companies > 0
                ? `They'll be signed out and can't sign in again. Their ${footprint.companies} ${footprint.companies === 1 ? "client stays" : "clients stay"} with this account — hand them over first if another manager needs them.`
                : "They'll be signed out and can't sign in again. Everything they've written stays exactly where it is.",
            confirmLabel: "Deactivate",
            tone: "danger",
          }
        : {
            title: `Reactivate ${userLabel}?`,
            description: "They'll be able to sign in again.",
            confirmLabel: "Reactivate",
          }
    );
    if (!ok) return;
    if (await run(() => setUserActive(userId, !active))) {
      toast.success(active ? `${userLabel} deactivated.` : `${userLabel} reactivated.`);
    }
  }

  async function handOver() {
    const target = handoverCandidates.find((c) => c.id === handoverToId);
    if (!target) return;
    const targetLabel = target.name ?? target.email;
    const ok = await confirm({
      title: `Move ${footprint.companies} ${footprint.companies === 1 ? "client" : "clients"} to ${targetLabel}?`,
      description: `${targetLabel} becomes the owner and sees them from then on; ${userLabel} no longer does. Quotes are not moved — each one keeps the author who wrote it.`,
      confirmLabel: "Hand over",
    });
    if (!ok) return;
    if (await run(() => reassignUserCompanies(userId, target.id))) {
      toast.success(`Clients moved to ${targetLabel}.`);
      setHandoverToId("");
    }
  }

  async function remove() {
    const ok = await confirm({
      title: `Delete ${userLabel}?`,
      description:
        "This account has no clients, quotes or history, so nothing is lost with it. It can't be undone.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    // No toast: `deleteUser` redirects to the users list on success, so this
    // component is gone before one could be read.
    await run(() => deleteUser(userId));
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-slate-600">
          {active
            ? "This account can sign in. Deactivating signs them out and blocks any further sign-in; nothing they've written is removed or changed."
            : "This account is deactivated — it can't sign in. Everything it owns and wrote is still here."}
        </p>
        <Button
          type="button"
          onClick={() => void toggleAccess()}
          disabled={pending || (active && accessLocked)}
          title={active && accessLocked ? accessLockedReason : undefined}
          className={cn(
            "h-11 w-full sm:w-auto sm:self-start",
            active ? "bg-destructive text-white hover:bg-destructive/90" : "bg-brand text-white hover:bg-brand/90"
          )}
        >
          {active ? "Deactivate account" : "Reactivate account"}
        </Button>
        {active && accessLocked ? (
          <p className="text-sm text-slate-500">{accessLockedReason}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-200 pt-6">
        <h3 className="text-sm font-semibold text-brand-dark">Clients</h3>
        {footprint.companies === 0 ? (
          <p className="text-sm text-slate-500">This account owns no clients.</p>
        ) : (
          <>
            <p className="text-sm text-slate-600">
              Owns {footprint.companies} {footprint.companies === 1 ? "client" : "clients"}. A client is
              only visible to the manager who owns it, so hand them to whoever takes over — otherwise
              they stay reachable to admins alone.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <label htmlFor="handover-target" className="shrink-0 text-sm text-slate-600">
                Hand over to
              </label>
              <select
                id="handover-target"
                value={handoverToId}
                onChange={(e) => setHandoverToId(e.target.value)}
                disabled={pending || handoverCandidates.length === 0}
                className={cn(fieldInputClass, "min-w-0 flex-1")}
              >
                <option value="">
                  {handoverCandidates.length === 0 ? "No other active users" : "Select a user…"}
                </option>
                {handoverCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name ? `${candidate.name} (${candidate.email})` : candidate.email}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                onClick={() => void handOver()}
                disabled={pending || !handoverToId}
                className="h-11 shrink-0 bg-brand text-white hover:bg-brand/90"
              >
                Hand over
              </Button>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-200 pt-6">
        <h3 className="text-sm font-semibold text-brand-dark">Delete</h3>
        <p className="text-sm text-slate-600">
          {deletable
            ? "This account has no clients, quotes or history behind it, so it can be removed outright."
            : "Accounts with clients, quotes or history can't be deleted — a signed quote names the person who wrote it, and that name has to keep resolving. Deactivate instead."}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void remove()}
          disabled={pending || !deletable || isSelf}
          title={isSelf ? "You can't delete your own account." : undefined}
          className="h-11 w-full border-destructive/40 text-destructive hover:bg-destructive/5 sm:w-auto sm:self-start"
        >
          Delete account
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
