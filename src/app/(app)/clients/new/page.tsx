import type { Metadata } from "next";
import { createCompany } from "@/lib/actions/clients";
import { listIndustries } from "@/lib/queries/industries";
import { CompanyForm } from "@/components/clients/company-form";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const metadata: Metadata = { title: "New company" };
export const dynamic = "force-dynamic";

// No `requireRegion` here any more. A company carries no region — it is a
// client of the business, not of one office — so there is nothing on this
// screen a region could gate. A manager without a region configured is still
// stopped at the screens where region genuinely decides something (prices,
// and the document builder), which is where that check belongs.
export default async function NewCompanyPage() {
  const industries = await listIndustries();

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
          submitLabel="Create company"
          industryPicker={{
            // Aliases as names only — search keys, never options of their own.
            industries: industries.map((i) => ({
              id: i.id,
              name: i.name,
              aliases: i.aliases.map((alias) => ({ name: alias.name })),
            })),
            selectedId: null,
            usageCount: null,
            canRename: false,
          }}
        />
      </SectionCard>
    </div>
  );
}
