import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Plus, UserRound } from "lucide-react";
import { auth } from "@/auth";
import { listUsers, type UserListItem } from "@/lib/queries/users";
import { buttonVariants } from "@/components/ui/button";
import {
  PageHeader,
  TableShell,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
  RowCell,
  StatusBadge,
  STATUS_TONE,
  EmptyState,
  Avatar,
} from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { isAdminRole } from "@/lib/roles";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  // notFound() rather than a redirect: a Manager hitting a stale bookmark
  // shouldn't be told the page exists at all.
  const session = await auth();
  if (!isAdminRole(session?.user?.role)) notFound();

  const users = await listUsers();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Everyone with access to PathQuote."
        actions={
          <Link
            href="/settings/users/new"
            className={cn(buttonVariants(), "h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto")}
          >
            <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
            Add user
          </Link>
        }
      />

      {users.length === 0 ? (
        <EmptyState icon={UserRound} title="No users yet" description="Add your first teammate above." />
      ) : (
        <TableShell
          table={
            <table className={tableClassName}>
              <thead>
                <tr className={tableHeadRowClassName}>
                  <th scope="col" className="px-4 py-3">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Email
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Role
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Region
                  </th>
                  <th scope="col" className="px-4 py-3">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow key={u.id} user={u} />
                ))}
              </tbody>
            </table>
          }
          cards={users.map((u) => (
            <UserCard key={u.id} user={u} />
          ))}
        />
      )}
    </div>
  );
}

function UserRow({ user: u }: { user: UserListItem }) {
  const href = `/settings/users/${u.id}`;
  return (
    // One `Link` per cell (`RowCell`), the same pattern the documents and
    // clients lists use. The previous single overlay link stretched across
    // the row from inside the first cell, so the later cells painted on top
    // of it and the email text — which needed its own `relative` to stay
    // legible — sat above the link too: the one part of the row a person
    // naturally clicks was the one part that did nothing.
    <tr className={tableRowClassName}>
      <RowCell href={href} primary={`Open ${u.name ?? u.email}`}>
        <span className="flex items-center gap-3">
          <Avatar name={u.name} email={u.email} image={u.image} size={32} />
          <span className="font-medium text-brand-dark">{u.name ?? u.email}</span>
        </span>
        {u.magicLinkOnly ? <span className="mt-0.5 block text-xs text-slate-500">Magic link only</span> : null}
      </RowCell>
      <RowCell href={href}>
        {/* Blank rather than the email repeated when the name column already fell
            back to it — one identity per row, never the same string twice. */}
        <span className="text-sm text-slate-600">{u.name ? u.email : "—"}</span>
      </RowCell>
      <RowCell href={href}>
        <StatusBadge tone={STATUS_TONE[u.role]}>{u.role}</StatusBadge>
      </RowCell>
      <RowCell href={href}>
        <span className="text-sm text-slate-600">{u.regionCode ?? "—"}</span>
      </RowCell>
      <RowCell href={href}>
        <StatusBadge tone={u.active ? "green" : "slate"}>{u.active ? "Active" : "Inactive"}</StatusBadge>
      </RowCell>
    </tr>
  );
}

function UserCard({ user: u }: { user: UserListItem }) {
  return (
    <div className="relative flex min-h-12 flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 transition-colors active:bg-slate-100">
      <Link
        href={`/settings/users/${u.id}`}
        className="focus-ring absolute inset-0 rounded-xl focus-visible:z-10"
      >
        <span className="sr-only">Open {u.name ?? u.email}</span>
      </Link>
      <div className="flex items-start justify-between gap-3">
        <div className="relative flex min-w-0 items-center gap-3">
          <Avatar name={u.name} email={u.email} image={u.image} size={36} />
          <div className="min-w-0">
            <p className="truncate font-medium text-brand-dark">{u.name ?? u.email}</p>
            <p className="truncate text-sm text-slate-500">{u.name ? u.email : "No name set"}</p>
          </div>
        </div>
        <StatusBadge tone={u.active ? "green" : "slate"} className="relative shrink-0">
          {u.active ? "Active" : "Inactive"}
        </StatusBadge>
      </div>
      <div className="relative flex items-center justify-between gap-3 text-sm text-slate-500">
        <div className="flex items-center gap-2">
          <StatusBadge tone={STATUS_TONE[u.role]}>{u.role}</StatusBadge>
          <span>{u.regionCode ?? "No region"}</span>
        </div>
        {u.magicLinkOnly ? <span className="shrink-0 text-xs">Magic link only</span> : null}
      </div>
    </div>
  );
}
