import type { Metadata } from "next";
import { listActiveRegions } from "@/lib/queries/catalog";
import { requireRegion } from "@/lib/authz";
import { createCompany } from "@/lib/actions/clients";
import { CompanyForm } from "@/components/clients/company-form";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const metadata: Metadata = { title: "New company" };
export const dynamic = "force-dynamic";

export default async function NewCompanyPage() {
  const { regionId } = await requireRegion();
  const allRegions = await listActiveRegions();
  // A manager is offered exactly their own region, so there is nothing to
  // choose and CompanyForm renders the field as static text instead of a
  // select. An admin keeps the full list. The server-side rule lives in
  // createCompany (assertRegionWritable); this only stops offering a choice
  // that would be rejected.
  const regions = regionId === null ? allRegions : allRegions.filter((r) => r.id === regionId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/clients"
        backLabel="Clients"
        title="New company"
        description="Add a client company. You can add contacts once it's created."
      />

      <SectionCard>
        <CompanyForm
          action={createCompany}
          defaultValues={{
            name: "",
            street: "",
            city: "",
            state: "",
            postcode: "",
            country: "",
            website: "",
            taxId: "",
            notes: "",
            regionCode: regions[0]?.code ?? "",
            deliverySameAsMain: true,
            deliveryStreet: "",
            deliveryCity: "",
            deliveryState: "",
            deliveryPostcode: "",
            deliveryCountry: "",
            deliveryContactName: "",
            deliveryPhone: "",
            deliveryNotes: "",
          }}
          regions={regions.map((r) => ({ code: r.code, name: r.name }))}
          submitLabel="Create company"
        />
      </SectionCard>
    </div>
  );
}
