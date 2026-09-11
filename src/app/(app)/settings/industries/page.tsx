import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Factory } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listIndustriesWithCounts } from "@/lib/queries/industries";
import { PageHeader, SectionCard, EmptyState } from "@/components/ui-kit";
import { IndustryAdminList } from "@/components/settings/industry-admin-list";

export const metadata: Metadata = { title: "Industries" };
export const dynamic = "force-dynamic";

/**
 * The industry list, which until now existed only as a typeahead inside one
 * company's card: to rename a row you had to find a company using it, and there
 * was no way at all to see the whole list, drop one nobody uses, or fold a
 * duplicate into the row it should have been.
 *
 * ADMIN-only, and notFound() rather than a redirect for the usual reason — a
 * manager on a stale bookmark isn't told the page exists. The company counts
 * this page is built around are unscoped (see `listIndustriesWithCounts`), so
 * that guard is what keeps cross-manager numbers off a manager's screen.
 */
export default async function IndustriesPage() {
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) notFound();

  const industries = await listIndustriesWithCounts();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Industries"
        description="The shared list every client card picks from. Renaming one changes it on every company that uses it, and on the production forms that print it. Aliases record the other spellings — ACT!'s wording, or a typo — that should find the same row."
      />

      {/* The empty state sits ABOVE the editor rather than replacing it, unlike
          every other list in the app: the only way to add the first industry
          from this screen is the editor's own "Add" field, so swapping it out
          for a message would leave an admin told the list is empty and given
          nothing to do about it. */}
      <SectionCard>
        {industries.length === 0 ? (
          <EmptyState
            icon={Factory}
            title="No industries yet"
            description="Add the first one below, or let a manager create one from a client's card."
          />
        ) : null}
        <IndustryAdminList industries={industries} />
      </SectionCard>
    </div>
  );
}
