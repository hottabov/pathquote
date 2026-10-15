import { readActLinkLists } from "@/lib/act/user-link-read";
import {
  actUnreachableMessage,
  actUserLabel,
  buildAccountMgrOptions,
  buildActUserOptions,
  describeCurrentLink,
  suggestAccountMgr,
  suggestActUser,
  type AccountMgrOption,
  type ActUserOption,
} from "@/lib/act/user-link";
import { ActUserLinkForm } from "@/components/users/act-user-link-form";

type Props = {
  userName: string | null;
  storedActUserId: string | null;
  storedAccountMgr: string | null;
  action: (formData: FormData) => Promise<{ error?: string }>;
};

/** What is stored, as two lines. Shared by the loaded section and its fallback. */
function CurrentLink({ actUser, accountMgr }: { actUser: string; accountMgr: string }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">Linked ACT! user</dt>
        <dd className="m-0 text-sm text-brand-dark">{actUser}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">Acc Mgr</dt>
        <dd className="m-0 text-sm text-brand-dark">{accountMgr}</dd>
      </div>
    </dl>
  );
}

/**
 * Shown while ACT! is being asked (the section streams in under Suspense, so
 * the rest of the user page never waits on ACT!).
 */
export function ActUserLinkSectionFallback({
  storedActUserId,
  storedAccountMgr,
}: Pick<Props, "storedActUserId" | "storedAccountMgr">) {
  const current = describeCurrentLink({
    storedActUserId,
    storedAccountMgr,
    actUsers: null,
    loginName: process.env.ACT_USER?.trim() || null,
  });
  return (
    <div className="flex flex-col gap-3">
      <CurrentLink actUser={current.actUser} accountMgr={current.accountMgr} />
      <p className="text-sm text-slate-500" aria-live="polite">
        Reading ACT!&rsquo;s users and Rep list…
      </p>
    </div>
  );
}

/**
 * The ACT! section of the user page: the stored link, read against ACT!'s
 * live lists, and the controls to change it. ADMIN/DEVELOPER only -- the page
 * renders it only for them, and setUserActLink checks again.
 *
 * Contained by construction: readActLinkLists never throws and gives up after
 * ~10 s, and when it fails this still renders what is stored, says why ACT!
 * could not be reached, and disables the controls.
 */
export async function ActUserLinkSection({ userName, storedActUserId, storedAccountMgr, action }: Props) {
  const lists = await readActLinkLists();

  if (!lists.ok) {
    const current = describeCurrentLink({ storedActUserId, storedAccountMgr, actUsers: null, loginName: lists.loginName });
    // Only what is stored, so the disabled selects show it.
    const actUserOptions: ActUserOption[] = storedActUserId
      ? [{ value: storedActUserId, label: storedActUserId, suggestedAccountMgr: null, missing: false }]
      : [];
    const accountMgrOptions: AccountMgrOption[] = storedAccountMgr
      ? [{ value: storedAccountMgr, label: storedAccountMgr, missing: false }]
      : [];
    return (
      <div className="flex flex-col gap-4">
        <CurrentLink actUser={current.actUser} accountMgr={current.accountMgr} />
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {actUnreachableMessage(lists.reason)}
        </p>
        <ActUserLinkForm
          action={action}
          actUserOptions={actUserOptions}
          accountMgrOptions={accountMgrOptions}
          storedActUserId={storedActUserId}
          storedAccountMgr={storedAccountMgr}
          suggestedActUser={null}
          disabledReason={lists.reason}
        />
      </div>
    );
  }

  const current = describeCurrentLink({
    storedActUserId,
    storedAccountMgr,
    actUsers: lists.actUsers,
    loginName: lists.loginName,
  });
  const suggestion = storedActUserId === null ? suggestActUser(userName, lists.actUsers) : null;

  return (
    <div className="flex flex-col gap-4">
      <CurrentLink actUser={current.actUser} accountMgr={current.accountMgr} />
      <ActUserLinkForm
        action={action}
        actUserOptions={buildActUserOptions(lists.actUsers, lists.repItems, storedActUserId)}
        accountMgrOptions={buildAccountMgrOptions(lists.repItems, storedAccountMgr)}
        storedActUserId={storedActUserId}
        storedAccountMgr={storedAccountMgr}
        suggestedActUser={
          suggestion
            ? {
                id: suggestion.id,
                label: actUserLabel(suggestion),
                suggestedAccountMgr: suggestAccountMgr(suggestion.displayName, lists.repItems),
              }
            : null
        }
        disabledReason={null}
      />
    </div>
  );
}
