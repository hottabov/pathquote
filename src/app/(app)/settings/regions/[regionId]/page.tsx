import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { getRegionAdmin } from "@/lib/queries/regions";
import { updateRegion, updateRegionLogo } from "@/lib/actions/regions";
import { RegionForm } from "@/components/regions/region-form";
import { ImageUpload } from "@/components/catalog/image-upload";
import { PageHeader, SectionCard, StatusBadge } from "@/components/ui-kit";

export const dynamic = "force-dynamic";

type Params = { regionId: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { regionId } = await params;
  const region = await getRegionAdmin(regionId);
  return { title: region ? `${region.name} (${region.code})` : "Region" };
}

export default async function EditRegionPage({ params }: { params: Promise<Params> }) {
  const { regionId } = await params;
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) notFound();

  const region = await getRegionAdmin(regionId);
  if (!region) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/settings/regions"
        backLabel="Regions"
        title={region.name}
        description={region.code}
      />

      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={region.active ? "green" : "slate"}>{region.active ? "Active" : "Inactive"}</StatusBadge>
      </div>

      <p className="rounded-lg border border-brand-accent-ink/30 bg-brand-accent-ink/5 px-3 py-2 text-sm text-brand-accent-ink">
        Currency, tax and entity details apply to documents created after the change; finalized documents keep
        their frozen snapshot.
      </p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <SectionCard title="Details" className="lg:col-span-2">
          <RegionForm
            action={updateRegion.bind(null, region.id)}
            defaultValues={{
              code: region.code,
              name: region.name,
              currency: region.currency,
              currencySymbol: region.currencySymbol ?? "",
              taxName: region.taxName,
              taxRate: region.taxRate,
              entityName: region.entityName,
              entityLegalId: region.entityLegalId ?? "",
              entityAddress: region.entityAddress ?? "",
              footerText: region.footerText ?? "",
              bankDetails: region.bankDetails,
              maxDiscountPct: region.maxDiscountPct ?? "",
              maxMarkupPct: region.maxMarkupPct ?? "",
              active: region.active,
            }}
            submitLabel="Save changes"
            codeEditable={false}
          />
        </SectionCard>

        <SectionCard title="Logo" description="Shown on documents issued from this region.">
          <ImageUpload
            currentUrl={region.logoUrl}
            alt={`${region.name} logo`}
            onSave={updateRegionLogo.bind(null, region.id)}
            previewHeightPx={120}
          />
        </SectionCard>
      </div>
    </div>
  );
}
