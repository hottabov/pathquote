import type { Metadata } from "next";
import { AlertTriangle, CalendarClock, RefreshCw, RotateCw } from "lucide-react";
import { requireAdminPage } from "@/lib/authz";
import { getActSyncStatus } from "@/lib/queries/act-sync";
import { runActSyncNow } from "@/lib/actions/act-sync";
import { describeActSyncStatus, type ActSyncView } from "@/lib/act/sync-view";
import { ActSyncPanel } from "@/components/settings/act-sync-panel";
import { buttonVariants } from "@/components/ui/button";
import { PageHeader, SectionCard, StatusBadge } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "ACT! sync" };

// Whether a sync is running right now, and what the last one did, are true for
// about as long as it takes to read them. A cached render of this page is a
// page that answers the question wrongly.
export const dynamic = "force-dynamic";

/**
 * The three tones `describeRun` returns, as the treatment the rest of Settings
 * already gives them.
 *
 * Amber and slate are the summary box in CatalogVisibilityEditor and
 * ContactsVisibilityEditor, character for character, so a warning here looks
 * like a warning two sections over. Those boxes have only two states; this one
 * needs a third, and rose is the app's existing shade for something that wants
 * fixing (StatusBadge's `rose`, PRICE_REQUIRED and DECLINED).
 */
const SUMMARY_TONE: Record<ActSyncView["summary"]["tone"], string> = {
  ok: "border-slate-200 bg-slate-50 text-slate-700",
  warn: "border-amber-300 bg-amber-50 text-amber-800",
  error: "border-rose-300 bg-rose-50 text-rose-800",
};

/**
 * Settings -> ACT! sync. Everything the director needs in order to trust the
 * nightly contact pull, in the order he asks about it: when did it last run,
 * what did it do, is anything wrong, and can I run it now.
 *
 * No sentence about the sync is written in this file and no condition here
 * picks one. `describeActSyncStatus` (src/lib/act/sync-view.ts) turns one read
 * of the status into the view below and is tested over every state the pair of
 * reads can produce -- never run, a clean night, a name collision, failed
 * contacts, a run that was killed, a run going on right now, a record this
 * version cannot read, and no stored position at all. What is left here is
 * layout: which card a part goes in, and how a tone looks.
 *
 * `requireAdminPage` rather than a plain session check: a manager must not be
 * able to tell this route from one that does not exist (see its doc comment).
 */
export default async function ActSyncPage() {
  await requireAdminPage();

  const status = await getActSyncStatus();
  const view = describeActSyncStatus(status, new Date());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="ACT! sync"
        description="PathQuote copies contacts and clients out of ACT! every night. This page says how the last one went, and lets you run it now if you cannot wait for tonight."
      />

      <SectionCard
        title="Last sync"
        icon={<RefreshCw className="size-5" />}
        description="What the most recent run did, and whether it needs anybody's attention."
      >
        <div className="flex flex-col gap-4">
          {view.when ? (
            <div className="flex flex-col gap-0.5">
              <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Started</p>
              {/* Both, because they answer different questions: the relative
                  phrase says whether this is stale at a glance, the absolute
                  one says whether it was before or after a change he made. */}
              <p className="text-base font-semibold text-brand-dark">{view.when.relative}</p>
              <p className="text-sm text-slate-600">{view.when.absolute}</p>
            </div>
          ) : null}

          <div className={cn("rounded-lg border px-3 py-2 text-sm", SUMMARY_TONE[view.summary.tone])}>
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
              <p className="flex min-w-0 items-start gap-2">
                {view.summary.tone === "ok" ? null : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                )}
                <span className="font-medium">{view.summary.headline}</span>
              </p>
              {view.summary.trigger ? (
                <StatusBadge tone="slate">{view.summary.trigger}</StatusBadge>
              ) : null}
            </div>
            {/* A paragraph, not a clipped line: the detail runs to three
                sentences in the cases that matter most, and the sentence that
                gets cut off is always the one saying nothing was lost. */}
            {view.summary.detail ? (
              <p className="mt-1 max-w-prose">{view.summary.detail}</p>
            ) : null}
          </div>

          {/* The wording above tells the reader to reload while a sync is
              going, because nothing on this page polls -- so the control it
              asks for is here rather than left to whoever remembers where
              their browser keeps it. A plain anchor, not a Link: this has to
              be a fresh request for the server to answer, which is the whole
              point of pressing it. See `reload` in src/lib/act/sync-view.ts. */}
          {view.reload ? (
            <a
              href="/settings/act-sync"
              className={cn(
                buttonVariants({ variant: "ghost" }),
                "h-11 w-full px-3 text-brand-dark underline underline-offset-2 sm:w-fit"
              )}
            >
              <RotateCw className="size-4" data-icon="inline-start" aria-hidden="true" />
              Reload this page
            </a>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title="Sync now"
        description="Fetches the changes made in ACT! since the last sync, without waiting for tonight."
      >
        {view.runNow.kind === "offer" ? (
          <ActSyncPanel hint={view.runNow.hint} action={runActSyncNow} />
        ) : (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="font-medium">{view.runNow.headline}</span>
            </p>
            <p className="mt-1 max-w-prose">{view.runNow.detail}</p>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="The nightly sync"
        icon={<CalendarClock className="size-5" />}
        description="When it runs on its own, and how far through ACT! it has read."
      >
        <dl className="flex flex-col gap-4">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">Runs</dt>
            <dd className="text-sm font-medium text-brand-dark">{view.schedule}</dd>
            <dd className="max-w-prose text-sm text-slate-600">
              It runs on the server whether or not anybody is signed in, and nobody has to start
              it.
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">
              Caught up to
            </dt>
            <dd className="text-sm font-medium text-brand-dark">{view.caughtUpTo.headline}</dd>
            <dd className="max-w-prose text-sm text-slate-600">{view.caughtUpTo.detail}</dd>
          </div>
        </dl>
      </SectionCard>
    </div>
  );
}
