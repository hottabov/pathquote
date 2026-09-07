import type { Metadata } from "next";
import { auth } from "@/auth";
import { getRegionById } from "@/lib/queries/catalog";
import { getUser } from "@/lib/queries/users";
import { setUserAvatar, changeOwnPassword, saveMySignature, clearMySignature } from "@/lib/actions/users";
import { AvatarEditor } from "@/components/users/avatar-editor";
import { SignatureEditor } from "@/components/users/signature-editor";
import { ChangeOwnPasswordForm } from "@/components/users/change-own-password-form";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

/**
 * The Account section — the one place a user manages themselves: their
 * photo, their password, and a read-only view of the email, role and region
 * an admin controls. Open to every signed-in user (see SettingsNav).
 *
 * The photo control lives here rather than on the dashboard greeting, where
 * it used to sit back when Settings was admin-only. One control, one place.
 * An ADMIN changing *someone else's* photo still does it from
 * /settings/users/[userId] — a different audience and a different action.
 */
export default async function AccountSettingsPage() {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;
  const [region, me] = await Promise.all([
    getRegionById(session.user.regionId),
    getUser(session.user.id),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Account" description="Your account details." />

      <SectionCard title="Photo" description="Shown on your quotes and in the app.">
        <AvatarEditor
          name={me?.name ?? null}
          email={session.user.email ?? ""}
          image={me?.image ?? null}
          size={64}
          onSave={setUserAvatar.bind(null, session.user.id)}
        />
      </SectionCard>

      <SectionCard
        title="Signature"
        description="Drawn once here, then applied to quotes you sign. Redrawing it never changes a signature already on an issued quote."
      >
        <SignatureEditor
          signatureUrl={me?.signatureUrl ?? null}
          onSave={saveMySignature}
          onClear={clearMySignature}
        />
      </SectionCard>

      <SectionCard title="Account">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-slate-500">Email</dt>
            <dd className="text-sm font-medium text-brand-dark">{session.user.email}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-slate-500">Role</dt>
            <dd>
              <StatusBadge tone={STATUS_TONE[session.user.role]}>{session.user.role}</StatusBadge>
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-slate-500">Region</dt>
            <dd className="text-sm font-medium text-brand-dark">
              {region ? `${region.name} (${region.code})` : "Not set"}
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard
        title="Password"
        description="At least 10 characters. You stay signed in after changing it."
      >
        <ChangeOwnPasswordForm action={changeOwnPassword} />
      </SectionCard>
    </div>
  );
}
