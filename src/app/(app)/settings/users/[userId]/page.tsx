import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getUser } from "@/lib/queries/users";
import { listActiveRegions } from "@/lib/queries/catalog";
import { countActiveAdmins, getUserFootprint, listHandoverCandidates } from "@/lib/queries/users";
import { getCatalogVisibilityTree } from "@/lib/queries/catalog-visibility-admin";
import { getContactsVisibility } from "@/lib/queries/contacts-visibility-admin";
import {
  updateUser,
  setUserPassword,
  setUserAvatar,
  setUserActSyncVisible,
  setUserCommissionTiers,
} from "@/lib/actions/users";
import { setCatalogVisibility } from "@/lib/actions/catalog-visibility";
import { setContactsVisibility } from "@/lib/actions/contacts-visibility";
import { UserFlagToggle } from "@/components/users/user-flag-toggle";
import { CommissionTiersForm } from "@/components/users/commission-tiers-form";
import { EditUserForm } from "@/components/users/edit-user-form";
import { UserAccessSection } from "@/components/users/user-access-section";
import { SetPasswordForm } from "@/components/users/set-password-form";
import { CatalogVisibilityEditor } from "@/components/settings/catalog-visibility-editor";
import { ContactsVisibilityEditor } from "@/components/settings/contacts-visibility-editor";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE, Avatar } from "@/components/ui-kit";
import { ImageUpload } from "@/components/catalog/image-upload";
import { isAdminRole, isRegionalManagerRole, roleLabel } from "@/lib/roles";

export const dynamic = "force-dynamic";

type Params = { userId: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { userId } = await params;
  const user = await getUser(userId);
  return { title: user ? (user.name ?? user.email) : "User" };
}

export default async function EditUserPage({ params }: { params: Promise<Params> }) {
  const { userId } = await params;
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;
  if (!isAdminRole(session.user.role)) notFound();

  const [user, regions, activeAdminCount] = await Promise.all([
    getUser(userId),
    listActiveRegions(),
    countActiveAdmins(),
  ]);
  if (!user) notFound();

  // Only fetched once we know the user exists. The whole-catalogue tree (see
  // getCatalogVisibilityTree's own comment) is the more expensive of this
  // page's reads, so there's no point running it in the Promise.all above only
  // to throw it away on a 404; the other two are simply about this user.
  //
  // An admin's country grant would change nothing (they see every client by
  // role), and the editor's per-country count is a scan of the client table,
  // so it is skipped for them rather than fetched and thrown away.
  //
  // The ACT! sync card below is the same shape of question with no fetch
  // behind it -- `actSyncVisible` is already on `user` -- so it reuses this
  // flag rather than asking the role again.
  const userIsAdmin = isAdminRole(user.role);
  const [visibilitySeries, footprint, handoverCandidates, contactsVisibility] = await Promise.all([
    getCatalogVisibilityTree(user.id),
    getUserFootprint(user.id),
    listHandoverCandidates(user.id),
    userIsAdmin ? null : getContactsVisibility(user.id),
  ]);

  const isSelf = session.user.id === user.id;
  const isLastActiveAdmin = isAdminRole(user.role) && user.active && activeAdminCount <= 1;

  return (
    <div className="flex flex-col gap-6">
      {/* Name leads, email reads as the subtitle. A user without a name still
          needs an identity in the heading, so the email moves up and the
          subtitle drops rather than repeating it. */}
      <PageHeader
        backHref="/settings/users"
        backLabel="Users"
        title={
          <span className="inline-flex items-center gap-3">
            <Avatar name={user.name} email={user.email} image={user.image} size={40} />
            {user.name ?? user.email}
          </span>
        }
        description={user.name ? user.email : undefined}
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={STATUS_TONE[user.role]}>{roleLabel(user.role)}</StatusBadge>
        <StatusBadge tone={user.active ? "green" : "slate"}>{user.active ? "Active" : "Inactive"}</StatusBadge>
        {user.magicLinkOnly ? <StatusBadge tone="brand-outline">Magic link only</StatusBadge> : null}
        {isSelf ? <StatusBadge tone="slate">This is you</StatusBadge> : null}
      </div>

      <SectionCard
        title="Avatar"
        description="Shown next to this user's name across the app, and on quotes they prepare."
      >
        <ImageUpload
          currentUrl={user.image}
          alt={user.name ?? user.email}
          onSave={setUserAvatar.bind(null, user.id)}
          purpose="avatar"
          previewHeightPx={112}
        />
      </SectionCard>

      <SectionCard title="Details">
        <EditUserForm
          action={updateUser.bind(null, user.id)}
          defaultValues={{
            name: user.name ?? "",
            phone: user.phone ?? "",
            role: user.role,
            regionCode: user.regionCode ?? "",
          }}
          regions={regions.map((r) => ({ code: r.code, name: r.name }))}
          isSelf={isSelf}
          isLastActiveAdmin={isLastActiveAdmin}
        />
      </SectionCard>

      <SectionCard
        title="Catalogue visibility"
        description="Ticked series and products are shown to this user, and everything is ticked by default. Unticking one hides it from their own catalogue everywhere they'd meet it — the item picker, catalogue browsing, and adding it to a quote. Unticking a series hides every product in it, whatever those products' own ticks say. Another user is unaffected. A quote that already has a now-hidden item keeps it, unchanged."
      >
        <CatalogVisibilityEditor userId={user.id} series={visibilitySeries} action={setCatalogVisibility} />
      </SectionCard>

      {/* Works like the card above: a tick grants. The editor restates the
          effect of the current selection in a live summary. */}
      <SectionCard
        title="Contacts visibility"
        description={
          userIsAdmin
            ? "Which countries' clients this user can see."
            : isRegionalManagerRole(user.role)
              ? "Ticking a country SHOWS that country's clients to this user; a tick grants, as in Catalogue visibility above. A country adds to the clients their region owns; it never replaces them, and nothing ticked leaves just those. It lets them view and edit that country's clients, never delete one they don't own."
              : "Ticking a country SHOWS that country's clients to this user; a tick grants, as in Catalogue visibility above. Nothing ticked means they see only the clients they own. A country lets them view and edit its clients, never delete one they don't own."
        }
      >
        {contactsVisibility ? (
          <ContactsVisibilityEditor
            userId={user.id}
            visibility={contactsVisibility}
            regional={isRegionalManagerRole(user.role)}
            action={setContactsVisibility}
          />
        ) : (
          <p className="text-sm text-slate-500">
            This user&rsquo;s role ({roleLabel(user.role)}) already sees every client in every country. A
            country grant would change nothing, so there is nothing to set here.
          </p>
        )}
      </SectionCard>

      {/* Shown with an explanation rather than hidden or disabled on an
          ADMIN's or DEVELOPER's own page, matching how Contacts visibility
          above handles the same situation for an admin's country grant. Hiding
          the card would leave an admin wondering where the setting went and
          looking for it on the wrong screen; a dimmed checkbox would read as
          "somebody has locked this" rather than "this question does not apply
          to this user". The sentence says which it is, and that nobody can
          lose the section for themselves.

          Demoting an admin to MANAGER therefore makes a checkbox appear where
          this sentence was: `updateUser` revalidates this route, so the card
          is a control on the next render rather than needing a reload. The
          value it shows is whatever the column already held -- true for anyone
          who predates z64_act_sync_visible -- so an admin demoting a user
          should look at it rather than assume. */}
      <SectionCard
        title="ACT! sync"
        description="Whether Settings offers this user the ACT! sync section — the nightly ACT! pull's status, and the button that runs it now."
      >
        {userIsAdmin ? (
          <p className="text-sm text-slate-500">
            This user&rsquo;s role ({roleLabel(user.role)}) already has the ACT! sync section, and
            always will. There is nothing to set here, and no way to take the section away from an
            admin or a developer &mdash; including yourself.
          </p>
        ) : (
          <UserFlagToggle
            id="act-sync-visible"
            userId={user.id}
            visible={user.actSyncVisible}
            action={setUserActSyncVisible}
            label="Show the ACT! sync section to this user"
            hint="Leave it off for anyone who does not work in ACT! — they get no ACT! sync row in Settings, the page itself is not reachable, and the Sync now button cannot be pressed. Their contacts still reach ACT! when they finalise a quote."
            shownToast="ACT! sync section shown."
            hiddenToast="ACT! sync section hidden."
          />
        )}
      </SectionCard>

      {/* Every user's own table, admins included: commission is read off a
          quote's author, so an admin who writes quotes needs one too. Empty
          is a real answer -- no commission, no line in the builder -- and
          the right one for a distributor. */}
      <SectionCard
        title="Commission"
        description="The commission this user earns on their own quotes, by the quote's discount. Only admins and developers can change it."
      >
        <CommissionTiersForm
          action={setUserCommissionTiers.bind(null, user.id)}
          defaultValue={user.commissionTiers}
        />
      </SectionCard>

      <SectionCard
        title="Access"
        description="Whether this account can sign in, who its clients belong to, and — for an account with no history — removing it."
      >
        <UserAccessSection
          userId={user.id}
          userLabel={user.name ?? user.email}
          active={user.active}
          isSelf={isSelf}
          isLastActiveAdmin={isLastActiveAdmin}
          footprint={footprint}
          handoverCandidates={handoverCandidates}
        />
      </SectionCard>

      <SectionCard
        title="Password"
        description={
          user.magicLinkOnly
            ? "This user currently signs in via magic link only. Setting a password also lets them sign in with it."
            : "Replaces the user's current password."
        }
      >
        <SetPasswordForm action={setUserPassword.bind(null, user.id)} />
      </SectionCard>
    </div>
  );
}
