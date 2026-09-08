import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { createRegion } from "@/lib/actions/regions";
import { RegionForm } from "@/components/regions/region-form";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const metadata: Metadata = { title: "New region" };
export const dynamic = "force-dynamic";

export default async function NewRegionPage() {
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) notFound();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/settings/regions"
        backLabel="Regions"
        title="New region"
        description="Created active. The code can't be changed after creation."
      />

      <SectionCard>
        <RegionForm
          action={createRegion}
          defaultValues={{
            code: "",
            name: "",
            currency: "",
            currencySymbol: "",
            taxName: "",
            taxRate: "",
            entityName: "",
            entityLegalId: "",
            entityAddress: "",
            footerText: "",
            bankDetails: null,
            maxDiscountPct: "",
            maxMarkupPct: "",
            active: true,
          }}
          submitLabel="Create region"
          codeEditable
        />
      </SectionCard>
    </div>
  );
}
