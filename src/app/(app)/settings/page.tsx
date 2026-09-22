import type { Metadata } from "next";
import { auth } from "@/auth";
import { getRegionDocumentEntity } from "@/lib/queries/regions";
import { getUser } from "@/lib/queries/users";
import { setUserAvatar, changeOwnPassword, saveMySignature, clearMySignature } from "@/lib/actions/users";
import { roleLabel } from "@/lib/roles";
import { AvatarEditor } from "@/components/users/avatar-editor";
import { SignatureEditor } from "@/components/users/signature-editor";
import { ChangeOwnPasswordForm } from "@/components/users/change-own-password-form";
import { DetailRow, EntityLogo, NotSet, Value } from "@/components/account/account-fields";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

/**
 * The Account section: the signed-in user's own details, read-only, plus
 * the three things they change themselves — photo, signature, password.
 * Name and phone are edited by an admin at /settings/users/[userId]; the
 * company and bank details at /settings/regions/[regionId].
 */
export default async function AccountSettingsPage() {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;
  const me = await getUser(session.user.id);
  // Region comes from the fresh user row, not the session JWT, so an admin's
  // region change shows immediately.
  const entity = await getRegionDocumentEntity(me?.regionId ?? session.user.regionId);
  const email = me?.email ?? session.user.email ?? "";
  const name = me?.name?.trim() || null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Account" />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12 xl:items-start">
        <div className="flex flex-col gap-6 xl:col-span-8">
          <SectionCard>
            <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
              <AvatarEditor
                name={name}
                email={email}
                image={me?.image ?? null}
                size={88}
                onSave={setUserAvatar.bind(null, session.user.id)}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-brand-dark">{name ?? <NotSet />}</h2>
                  <StatusBadge tone={STATUS_TONE[session.user.role]}>{roleLabel(session.user.role)}</StatusBadge>
                </div>
                <dl className="divide-y divide-slate-100">
                  <DetailRow label="Email">{email}</DetailRow>
                  <DetailRow label="Phone">
                    <Value value={me?.phone} />
                  </DetailRow>
                  <DetailRow label="Region">
                    {entity ? `${entity.name} (${entity.code})` : <NotSet />}
                  </DetailRow>
                </dl>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Company">
            {entity ? (
              <dl className="divide-y divide-slate-100">
                {entity.logoUrl ? (
                  <DetailRow label="Logo">
                    <EntityLogo src={entity.logoUrl} alt={entity.entityName} />
                  </DetailRow>
                ) : null}
                <DetailRow label="Legal name">{entity.entityName}</DetailRow>
                <DetailRow label="Legal ID">
                  <Value value={entity.entityLegalId} />
                </DetailRow>
                <DetailRow label="Legal address">
                  <Value value={entity.entityAddress} />
                </DetailRow>
                <DetailRow label="Currency">{entity.currency}</DetailRow>
                <DetailRow label="Tax">
                  {entity.taxName} {Number(entity.taxRate)}%
                </DetailRow>
              </dl>
            ) : (
              <NotSet />
            )}
          </SectionCard>

          <SectionCard title="Bank details">
            {entity && (entity.bankDetails.length > 0 || entity.footerText) ? (
              <dl className="divide-y divide-slate-100">
                {entity.bankDetails.map((row) => (
                  <DetailRow key={row.label} label={row.label}>
                    <span className="tabular-nums">{row.value}</span>
                  </DetailRow>
                ))}
                {entity.footerText ? (
                  <DetailRow label="Footer">
                    <span className="whitespace-pre-line font-normal text-slate-600">{entity.footerText}</span>
                  </DetailRow>
                ) : null}
              </dl>
            ) : (
              <NotSet />
            )}
          </SectionCard>
        </div>

        <div className="flex flex-col gap-6 xl:col-span-4">
          <SectionCard title="Signature">
            <SignatureEditor
              signatureUrl={me?.signatureUrl ?? null}
              onSave={saveMySignature}
              onClear={clearMySignature}
            />
          </SectionCard>

          <SectionCard title="Password">
            <ChangeOwnPasswordForm action={changeOwnPassword} />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
