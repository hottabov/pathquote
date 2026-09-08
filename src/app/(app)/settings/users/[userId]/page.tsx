import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { getUser } from "@/lib/queries/users";
import { listActiveRegions } from "@/lib/queries/catalog";
import { countActiveAdmins, getUserFootprint, listHandoverCandidates } from "@/lib/queries/users";
import { getCatalogVisibilityTree } from "@/lib/queries/catalog-visibility-admin";
import { updateUser, setUserPassword, setUserAvatar } from "@/lib/actions/users";
import { setCatalogVisibility } from "@/lib/actions/catalog-visibility";
import { EditUserForm } from "@/components/users/edit-user-form";
import { UserAccessSection } from "@/components/users/user-access-section";
import { SetPasswordForm } from "@/components/users/set-password-form";
import { CatalogVisibilityEditor } from "@/components/settings/catalog-visibility-editor";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE, Avatar } from "@/components/ui-kit";
import { ImageUpload } from "@/components/catalog/image-upload";
import { isAdminRole } from "@/lib/roles";

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
  const [visibilitySeries, footprint, handoverCandidates] = await Promise.all([
    getCatalogVisibilityTree(user.id),
    getUserFootprint(user.id),
    listHandoverCandidates(user.id),
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
        <StatusBadge tone={STATUS_TONE[user.role]}>{user.role}</StatusBadge>
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
        description="Checking hides a series or product from this user's own catalogue everywhere they'd meet it — the item picker, catalogue browsing, and adding it to a quote. Another user is unaffected. A quote that already has a now-hidden item keeps it, unchanged."
      >
        <CatalogVisibilityEditor userId={user.id} series={visibilitySeries} action={setCatalogVisibility} />
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
