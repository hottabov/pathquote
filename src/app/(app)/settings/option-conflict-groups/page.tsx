import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Ban, Plus } from "lucide-react";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { listConflictGroups, type ConflictGroupListItem } from "@/lib/queries/conflict-groups";
import {
  PageHeader,
  TableShell,
  RowCell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  EmptyState,
} from "@/components/ui-kit";
import { buttonVariants } from "@/components/ui/button";
import { CatalogueSubnav } from "@/components/settings/catalogue-subnav";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Option conflict groups" };
export const dynamic = "force-dynamic";

// notFound() rather than a redirect: a Manager hitting a stale bookmark
// shouldn't be told the page exists at all.
export default async function ConflictGroupsPage() {
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) notFound();

  const groups = await listConflictGroups();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Option conflict groups"
        description="Sets of options that can't be selected together on the same item — e.g. a set of knife tools where only one can be fitted. Two options conflict whenever they share a group."
        actions={
          <Link
            href="/settings/option-conflict-groups/new"
            className={cn(buttonVariants(), "h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto")}
          >
            <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
            New group
          </Link>
        }
      />

      <CatalogueSubnav active="option-conflict-groups" />

      {groups.length === 0 ? (
        <EmptyState
          icon={Ban}
          title="No conflict groups yet"
          description="Create one to block a set of options from being selected together on the same item."
        />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <th scope="col" className="px-4 py-3">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    Members
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <GroupRow key={g.id} group={g} />
                ))}
              </tbody>
            </table>
          }
          cards={groups.map((g) => (
            <GroupCard key={g.id} group={g} />
          ))}
        />
      )}
    </div>
  );
}

function GroupRow({ group: g }: { group: ConflictGroupListItem }) {
  const href = `/settings/option-conflict-groups/${g.id}`;
  return (
    <tr className={tableRowClassName}>
      <RowCell href={href} primary={`Open ${g.name}`}>
        <span className="text-sm font-medium text-brand-dark">{g.name}</span>
      </RowCell>
      <RowCell href={href} align="right">
        <span className={cn("text-sm", g.memberCount > 0 ? "text-slate-600" : "text-slate-400")}>
          {g.memberCount}
        </span>
      </RowCell>
    </tr>
  );
}

function GroupCard({ group: g }: { group: ConflictGroupListItem }) {
  return (
    <Link
      href={`/settings/option-conflict-groups/${g.id}`}
      className="focus-ring flex min-h-12 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 transition-colors active:bg-slate-100"
    >
      <p className="truncate text-sm font-medium text-brand-dark">{g.name}</p>
      <span className="shrink-0 text-sm text-slate-500">
        {g.memberCount} {g.memberCount === 1 ? "option" : "options"}
      </span>
    </Link>
  );
}
