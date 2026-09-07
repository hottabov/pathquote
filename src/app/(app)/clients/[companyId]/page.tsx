import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { auth } from "@/auth";
import { requireRegion } from "@/lib/authz";
import { isAdminRole } from "@/lib/roles";
import { getCompanyDetail } from "@/lib/queries/clients";
import { listActiveRegions } from "@/lib/queries/catalog";
import { listIndustries, countCompaniesUsingIndustry } from "@/lib/queries/industries";
import { updateCompany, deleteCompany, createContact, updateContact, deleteContact } from "@/lib/actions/clients";
import { normalizeCountryInput } from "@/lib/countries";
import { CompanyForm } from "@/components/clients/company-form";
import { ContactsSection } from "@/components/clients/contacts-section";
import { DeleteCompanyButton } from "@/components/clients/delete-company-button";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const dynamic = "force-dynamic";

type Params = { companyId: string };

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { companyId } = await params;
  // Metadata runs before the page body — re-check scope here too so a
  // manager browsing to a foreign company never even sees its name in the
  // tab title.
  const session = (await auth())!;
  const company = await getCompanyDetail(session.user, companyId);
  return { title: company ? company.name : "Company" };
}

export default async function CompanyEditorPage({ params }: { params: Promise<Params> }) {
  const { companyId } = await params;
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  // `requireRegion` additionally hands back the region this viewer may write
  // — `null` for an admin, meaning every region.
  const { session, regionId } = await requireRegion();

  const [company, allRegions, industries] = await Promise.all([
    getCompanyDetail(session.user, companyId),
    listActiveRegions(),
    listIndustries(),
  ]);

  // Same rule as /clients/new: offer a manager only their own region, so the
  // field renders as static text rather than a choice `updateCompany` would
  // reject. The enforcement itself is assertRegionWritable in that action.
  //
  // "Offered" is not "displayed": `CompanyRegionField` shows and submits
  // `defaultValues.regionCode` — this company's own region — and uses the
  // offered one only to put a name to it. A manager an admin has since
  // re-homed therefore sees the company's real region and gets
  // FOREIGN_REGION_ERROR in the form's error slot on save, rather than
  // silently dragging the company into their new one.
  const regions = regionId === null ? allRegions : allRegions.filter((r) => r.id === regionId);

  // A foreign company (belongs to another manager) resolves to the same
  // `null` as a nonexistent one — never leak which case it was.
  if (!company) notFound();

  // Only counted once we know the company exists, since it depends on
  // `company.industryId`. Renaming is admin-only (see `renameIndustry`) —
  // the picker uses `canRename` to decide whether to show the pencil at all.
  //
  // The count itself is unscoped by design (see `countCompaniesUsingIndustry`),
  // so it is cross-manager data: don't even issue the query for a manager.
  // `null` — not 0 — because a prop handed to a client component lands in the
  // RSC payload whether or not the component renders it, and the picker turns
  // `null` into a qualitative "this industry is shared" warning.
  const industryUsageCount =
    isAdminRole(session.user.role) && company.industryId
      ? await countCompaniesUsingIndustry(company.industryId)
      : null;
  const canRenameIndustry = isAdminRole(session.user.role);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <PageHeader backHref="/clients" backLabel="Clients" title={company.name} />
        {company.website ? (
          <a
            href={company.website}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-flex w-fit items-center gap-1.5 text-sm text-brand hover:underline"
          >
            {company.website}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      <SectionCard title="Details">
        <CompanyForm
          action={updateCompany.bind(null, company.id)}
          defaultValues={{
            name: company.name,
            street: company.street ?? "",
            city: company.city ?? "",
            state: company.state ?? "",
            postcode: company.postcode ?? "",
            // A pre-migration company may still have free-text country data
            // ("Australia" rather than "AU") — best-effort normalize it to
            // an ISO code so <CountrySelect> shows a real selection instead
            // of the "(unrecognized)" fallback, and so re-saving the form
            // without touching the country field doesn't fail validation.
            country: normalizeCountryInput(company.country) ?? company.country ?? "",
            website: company.website ?? "",
            taxId: company.taxId ?? "",
            notes: company.notes ?? "",
            regionCode: company.regionCode,
            deliverySameAsMain: company.deliverySameAsMain,
            deliveryStreet: company.deliveryStreet ?? "",
            deliveryCity: company.deliveryCity ?? "",
            deliveryState: company.deliveryState ?? "",
            deliveryPostcode: company.deliveryPostcode ?? "",
            deliveryCountry: normalizeCountryInput(company.deliveryCountry) ?? company.deliveryCountry ?? "",
            deliveryContactName: company.deliveryContactName ?? "",
            deliveryPhone: company.deliveryPhone ?? "",
            deliveryNotes: company.deliveryNotes ?? "",
          }}
          regions={regions.map((r) => ({ code: r.code, name: r.name }))}
          submitLabel="Save changes"
          industryPicker={{
            companyId: company.id,
            industries: industries.map((i) => ({ id: i.id, name: i.name })),
            selectedId: company.industryId,
            usageCount: industryUsageCount,
            canRename: canRenameIndustry,
          }}
        />
      </SectionCard>

      <SectionCard title="Contacts">
        <ContactsSection
          companyId={company.id}
          contacts={company.contacts}
          defaultCountry={normalizeCountryInput(company.country) ?? undefined}
          actions={{ createContact, updateContact, deleteContact }}
        />
      </SectionCard>

      <SectionCard
        tone="danger"
        title="Danger zone"
        description="Deleting a company removes its contacts too. Companies with quotes can't be deleted."
      >
        <DeleteCompanyButton action={deleteCompany.bind(null, company.id)} companyName={company.name} />
      </SectionCard>
    </div>
  );
}
