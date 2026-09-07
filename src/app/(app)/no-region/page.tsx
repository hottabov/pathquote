import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Region not assigned" };
export const dynamic = "force-dynamic";

/**
 * Where `requireRegion` (src/lib/authz.ts) sends a manager with no region.
 * Deliberately a dead end with no retry button: nothing the user can do
 * from here changes the outcome, and offering an action that cannot work is
 * worse than saying so plainly. Account and PathQuote Support stay
 * reachable from the nav, which is how they reach someone who can fix it.
 */
export default function NoRegionPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Region not assigned"
        description="Your account is not attached to a region yet."
      />

      <SectionCard title="What this means">
        <p className="text-sm text-slate-600">
          Quotes, clients and catalogue prices all belong to a region, so
          none of them can be shown until an administrator assigns yours.
          Your account and password are unaffected.
        </p>
        <p className="mt-4 text-sm text-slate-600">
          Ask an administrator to set your region, or send them a message
          from{" "}
          <Link
            href="/settings/support"
            className="font-medium text-brand-dark underline underline-offset-4"
          >
            PathQuote Support
          </Link>
          .
        </p>
      </SectionCard>
    </div>
  );
}
