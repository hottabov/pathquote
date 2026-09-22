import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { LogOut } from "lucide-react";
import { logout } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { AppNav } from "@/components/app-nav";
import { cn } from "@/lib/utils";
import { isAdminRole, roleLabel } from "@/lib/roles";

type AppShellProps = {
  user: {
    email?: string | null;
    role: string;
  };
  children: ReactNode;
};

/**
 * Server component: the responsive app chrome around every (app) page.
 *
 * - lg+: persistent 240px brand-dark sidebar (wordmark, nav, user block).
 * - md: same sidebar collapsed to a 64px icon rail (labels via `title`).
 * - <md: simplified white top bar (wordmark + role/logout) plus a fixed
 *   bottom nav with safe-area padding.
 *
 * The nav itself is rendered by the client `AppNav` component (twice — once
 * per variant) so it can highlight the active route via usePathname().
 */
export function AppShell({ user, children }: AppShellProps) {
  const isAdmin = isAdminRole(user.role);
  const roleTone = STATUS_TONE[user.role] ?? "slate";

  return (
    <div className="flex min-h-dvh flex-col bg-slate-50 md:flex-row">
      {/* Desktop / tablet sidebar */}
      <aside className="sticky top-0 z-30 hidden h-dvh w-16 shrink-0 flex-col bg-brand-dark md:flex lg:w-60">
        <div className="flex h-16 shrink-0 items-center justify-center border-b border-white/10 px-2 lg:justify-start lg:px-5">
          <Link
            href="/"
            className="focus-ring-dark flex items-center gap-2.5 rounded-sm text-lg font-semibold tracking-tight text-white"
          >
            <Image
              src="/pathquote-logo.png"
              alt=""
              aria-hidden="true"
              width={512}
              height={512}
              priority
              className="size-9 shrink-0 rounded-lg object-cover"
            />
            <span className="hidden lg:inline">
              Path<span className="text-brand-accent">Quote</span>
            </span>
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto py-3">
          <AppNav variant="sidebar" />
        </div>

        <div className="shrink-0 border-t border-white/10 p-3">
          <div className="hidden truncate px-2 pb-2 text-sm text-white/70 lg:block" title={user.email ?? undefined}>
            {user.email}
          </div>
          <div className="flex items-center justify-center gap-2 lg:justify-between">
            <StatusBadge
              tone={roleTone}
              className={cn(
                "hidden lg:inline-flex",
                isAdmin ? "border-transparent" : "border-white/30 text-white"
              )}
            >
              {roleLabel(user.role)}
            </StatusBadge>
            <form action={logout}>
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                aria-label="Log out"
                title="Log out"
                className="size-11 text-white/80 hover:bg-white/10 hover:text-white focus-visible:ring-brand-accent focus-visible:ring-offset-2 focus-visible:ring-offset-brand-dark"
              >
                <LogOut className="size-4" />
              </Button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <Link
            href="/"
            className="focus-ring flex items-center gap-2 rounded-sm text-lg font-semibold text-brand"
          >
            <Image
              src="/pathquote-logo.png"
              alt=""
              aria-hidden="true"
              width={512}
              height={512}
              className="size-8 shrink-0 rounded-lg object-cover"
            />
            PathQuote
          </Link>
          <div className="flex items-center gap-2">
            <StatusBadge tone={roleTone}>{roleLabel(user.role)}</StatusBadge>
            <form action={logout}>
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                aria-label="Log out"
                className="size-11"
              >
                <LogOut className="size-4" />
              </Button>
            </form>
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-24 md:px-6 md:pb-6 lg:px-8">
          {children}
        </main>
      </div>

      {/* Mobile bottom nav — AppNav renders the actual `<nav>` landmark */}
      <div className="pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white md:hidden">
        <AppNav variant="bottom" />
      </div>
    </div>
  );
}
