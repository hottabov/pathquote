import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CalendarClock, Play, RefreshCw, RotateCw, Send } from "lucide-react";
import { requireActSyncPage } from "@/lib/authz";
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
 * Settings -> ACT! sync. Everything a reader needs in order to trust the
 * nightly contact pull, in the order they ask about it: when did it last run,
 * what did it do, is anything wrong, and can I run it now -- and, in a card
 * of its own after the last run, the quotes queued for ACT! as they stand,
 * which no run's record can say (describeOutbox in src/lib/act/sync-view.ts).
 *
 * Written for the director and now read by the managers an admin has granted
 * it to as well, which is the one thing to know before rewording anything
 * here: the questions are the same either way, but "ask your developer" is
 * advice a manager follows through PathQuote Support -- a row down this same
 * nav -- rather than by picking up the phone. Every sentence was re-read
 * against both audiences and kept; the reasoning is recorded at the top of
 * src/lib/act/sync-view.ts, which owns the words. Nobody without the grant
 * reads any of it, so there is no third audience to write for: a distributor
 * with no ACT! access never reaches this page at all.
 *
 * No sentence about the sync is written in this file and no condition here
 * picks one. `describeActSyncStatus` (src/lib/act/sync-view.ts) turns one read
 * of the status into the view below and is tested over every state the three
 * reads can produce -- never run, a clean night, a name collision, failed
 * contacts, a run that was killed, a run going on right now, a record this
 * version cannot read, no stored position at all, and a stored position with no
 * record, which is the state this release itself lands in -- and, for the
 * queue, nothing waiting, quotes waiting with sending on or off, and quotes
 * held back, listed or past the list. What is left here is layout: which card
 * a part goes in, and how a tone looks.
 *
 * `requireActSyncPage`, not `requireAdminPage` and no longer the bare
 * `requireSession` this was between 2026-10-10 and the per-user grant: the
 * section is neither admin-only nor open to everyone. A non-admin reaches it
 * only with `User.actSyncVisible` ticked (`canSeeActSync`, src/lib/roles.ts);
 * an ADMIN or DEVELOPER reaches it by role. See the `adminOnly` and ACT! sync
 * comments in src/lib/settings-nav.ts for why a granted manager gets this one
 * and not the admin sections around it.
 *
 * This guard, not the nav, is what makes the grant a permission. The nav row
 * is withheld from an ungated user, but a href is not a lock and a URL can be
 * typed; `requireActSyncPage` answers that with `notFound()`, so the route is
 * indistinguishable from one that does not exist. It also still refuses an
 * unauthenticated request, which the proxy in front of the app is not the
 * app's own answer to (see requireSession).
 */
export default async function ActSyncPage() {
  const session = await requireActSyncPage();

  // The reader, because the queue card counts only the quotes they can open
  // (getActSyncStatus in src/lib/queries/act-sync.ts says why).
  const status = await getActSyncStatus(session.user);
  const view = describeActSyncStatus(status, new Date());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="ACT! sync"
        description="PathQuote copies contacts and clients out of ACT! every night, and sends ACT! the quotes queued for it. This page says how the last sync went and which quotes are still to go, and lets you run the sync now if you cannot wait for tonight."
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
              {/* `break-words`, with `min-w-0` so the span is allowed to
                  shrink below its own content: this headline is "Failed:
                  <whatever the driver or ACT! said>", which can be a
                  connection string or a URL with no space in it, and an
                  unbroken token runs out through the border of the box at
                  phone width. */}
                <span className="min-w-0 font-medium break-words">{view.summary.headline}</span>
              </p>
              {view.summary.trigger ? (
                <StatusBadge tone="slate">{view.summary.trigger}</StatusBadge>
              ) : null}
            </div>
            {/* A paragraph, not a clipped line: the detail runs to several
                sentences in the cases that matter most -- more when the
                drain has something to report -- and the sentence that would
                get cut off is the one saying nothing was lost, or that
                sending has stopped until somebody acts. */}
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
        title="Quotes for ACT!"
        icon={<Send className="size-5" />}
        description="The quotes still to be sent to ACT!, as they stand now — not just what the last run did."
      >
        <div className="flex flex-col gap-3">
          <div className={cn("rounded-lg border px-3 py-2 text-sm", SUMMARY_TONE[view.outbox.tone])}>
            <p className="flex min-w-0 items-start gap-2">
              {view.outbox.tone === "ok" ? null : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 font-medium break-words">{view.outbox.headline}</span>
            </p>
            {view.outbox.detail ? <p className="mt-1 max-w-prose">{view.outbox.detail}</p> : null}
          </div>

          {/* Each held quote by number, a link to it, with the reason it is
              held. The reason is a manager's sentence that can run to a few
              lines and quote what ACT! said, so it wraps under the number
              rather than sharing a line with it; `break-words` because ACT!'s
              words can carry an unbroken token. */}
          {view.outbox.held.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {view.outbox.held.map((quote) => (
                <li key={quote.href} className="flex flex-col gap-0.5 text-sm">
                  <Link
                    href={quote.href}
                    className="w-fit font-medium text-brand-dark underline underline-offset-2"
                  >
                    {quote.label}
                  </Link>
                  <span className="max-w-prose break-words text-slate-600">{quote.reason}</span>
                </li>
              ))}
              {view.outbox.more ? (
                <li className="text-sm text-slate-600">{view.outbox.more}</li>
              ) : null}
            </ul>
          ) : null}

          {view.outbox.scope ? (
            <p className="max-w-prose text-xs text-slate-500">{view.outbox.scope}</p>
          ) : null}
        </div>
      </SectionCard>

      {/* An icon, like the two cards either side of it. SectionCard's tile is
          size-9 beside a gap-3, so the one card without an icon has its title
          48px to the left of its neighbours' -- down a single column, that is a
          misalignment you see before you read anything. `Play` rather than the
          button's own RefreshCw, which is already this page's mark for the sync
          itself. */}
      <SectionCard
        title="Sync now"
        icon={<Play className="size-5" />}
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
