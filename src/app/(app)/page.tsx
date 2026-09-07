import Link from "next/link";
import type { Metadata } from "next";
import type { LucideIcon } from "lucide-react";
import { FileText, Plus } from "lucide-react";
import { auth } from "@/auth";
import { NAV_ITEMS } from "@/lib/nav-items";
import { countsForDashboard, type DashboardCounts } from "@/lib/queries/dashboard";
import { listDocuments, type DocumentListItem } from "@/lib/queries/documents";
import { getUser } from "@/lib/queries/users";
import { createDraft } from "@/lib/actions/documents";
import { formatMoney, relativeDate } from "@/lib/format";
import { firstNameFrom } from "@/lib/avatar";
import { isAdminRole } from "@/lib/roles";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE, EmptyState, Avatar } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const RECENT_LIMIT = 5;

/** Nav-item hrefs that have a live count on the dashboard — catalog/settings
 * don't, so their cards render without a number. */
const COUNT_BY_HREF: Record<string, keyof DashboardCounts> = {
  "/quotes": "documents",
  "/clients": "clients",
};

export default async function DashboardPage() {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;

  const [counts, documents, me] = await Promise.all([
    countsForDashboard(session.user),
    listDocuments(session.user, {}),
    // Read fresh from the database rather than off the session — the JWT
    // only revalidates every few minutes (see src/auth.ts), so a session
    // issued before the user set their name or photo still carries neither.
    // That is exactly what produced "Hi, hottabov" for a user whose name
    // was already "Vadym Leonov": the session was simply older than the
    // name. Session values remain the fallback for the window before the
    // row loads.
    getUser(session.user.id),
  ]);
  const recentDocuments = documents.slice(0, RECENT_LIMIT);
  const displayName = me?.name ?? session.user.name;
  const firstName = firstNameFrom(displayName, session.user.email ?? "");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-3">
            {/* Read-only here — the editable control now lives in
                Settings > Account. */}
            <Avatar name={displayName ?? null} email={session.user.email ?? ""} image={me?.image ?? null} size={40} />
            {`Hi, ${firstName}`}
          </span>
        }
        description={
          isAdminRole(session.user.role)
            ? "An overview of every quote across the business."
            : "An overview of your quotes and clients."
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:max-w-xs">
        <form action={createDraft}>
          <Button type="submit" className="h-12 w-full bg-brand text-base text-white hover:bg-brand/90">
            <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
            New quote
          </Button>
        </form>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {NAV_ITEMS.map((item) => (
          <NavCard
            key={item.href}
            href={item.href}
            label={item.label}
            description={item.description}
            icon={item.icon}
            count={COUNT_BY_HREF[item.href] ? counts[COUNT_BY_HREF[item.href]] : undefined}
          />
        ))}
      </div>

      <SectionCard
        title="Recent quotes"
        description="Your last 5 quotes"
        actions={
          <Link href="/quotes" className="focus-ring rounded-md text-sm font-medium text-brand hover:underline">
            View all
          </Link>
        }
      >
        {recentDocuments.length === 0 ? (
          <EmptyState icon={FileText} title="No quotes yet" description="Create your first quote above." />
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {recentDocuments.map((document) => (
              <RecentDocumentRow key={document.id} document={document} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function NavCard({
  href,
  label,
  description,
  icon: Icon,
  count,
}: {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  count?: number;
}) {
  return (
    <Link
      href={href}
      className="focus-ring flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-brand-accent-ink hover:bg-slate-50 active:bg-slate-100"
    >
      <div className="flex items-center justify-between">
        <span className="flex size-10 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        {typeof count === "number" ? (
          <span className="text-2xl font-semibold text-brand-dark">{count}</span>
        ) : null}
      </div>
      <div>
        <p className="font-medium text-brand-dark">{label}</p>
        <p className="text-sm text-slate-500">{description}</p>
      </div>
    </Link>
  );
}

function RecentDocumentRow({ document }: { document: DocumentListItem }) {
  return (
    <li>
      <Link
        href={`/quotes/${document.id}`}
        className="focus-ring flex min-h-14 items-center justify-between gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-slate-50"
      >
        <div className="flex min-w-0 items-center gap-3">
          <FileText className="size-4 shrink-0 text-brand" aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-brand-dark">
              {document.companyName ?? "No client"}
            </p>
            <p className="text-xs text-slate-500">
              {document.number ?? "Quote draft"} · {relativeDate(document.updatedAt)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge tone={STATUS_TONE[document.status]}>
            {document.status === "DRAFT" ? "Draft" : "Final"}
          </StatusBadge>
          <span className="text-sm font-medium text-brand-dark">
            {formatMoney(document.total, document.currency)}
          </span>
        </div>
      </Link>
    </li>
  );
}
