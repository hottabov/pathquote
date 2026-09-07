/**
 * Shown while the builder's data is in flight. This route is the one worth
 * giving a skeleton to: it is `force-dynamic`, it reads the document, the
 * client and catalogue pickers, the app settings and every item's compatible
 * options, and until the slowest of those lands Next would otherwise hold the
 * previous page on screen with no sign that anything is happening.
 *
 * The blocks mirror the real layout's two-column grid — left column of
 * sections, sticky summary on the right, collapsing to one column below `lg`
 * — so the page doesn't visibly rearrange itself when the content replaces
 * this.
 */
export default function DocumentBuilderLoading() {
  return (
    <div className="flex flex-col gap-6 pb-4" aria-busy="true" aria-label="Loading quote">
      <div className="flex flex-col gap-2">
        <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
        <div className="h-7 w-64 animate-pulse rounded bg-slate-200" />
        <div className="h-4 w-40 animate-pulse rounded bg-slate-100" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {[0, 1, 2].map((i) => (
            <SkeletonCard key={i} rows={i === 1 ? 4 : 2} />
          ))}
        </div>
        <div className="lg:col-span-1">
          <SkeletonCard rows={5} />
        </div>
      </div>
    </div>
  );
}

function SkeletonCard({ rows }: { rows: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="h-5 w-32 animate-pulse rounded bg-slate-200" />
      <div className="mt-4 flex flex-col gap-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    </div>
  );
}
