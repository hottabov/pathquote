import Link from "next/link";
import type { Metadata } from "next";
import { ChevronRight, Package, Puzzle } from "lucide-react";
import { auth } from "@/auth";
import { listSeriesWithCounts, countOptions, type SeriesWithCounts } from "@/lib/queries/catalog";
import { catalogVisibilityUserId, filterHiddenSeries } from "@/lib/catalog-visibility";
import { getHiddenCatalogIds } from "@/lib/queries/catalog-visibility";
import { PageHeader } from "@/components/ui-kit";
import { pickDerivativeWidth } from "@/lib/image-derivative-width";

/** CSS width of a series card's image box — `size-28` (112px) below the
 * `sm` breakpoint, `size-32` (128px) at and above it. The larger of the two
 * is what the `?w=` derivative is sized against, so the small-screen case is
 * covered by the same file rather than a second request. */
const CARD_IMAGE_BOX_PX = 128;

export const metadata: Metadata = { title: "Catalog" };
export const dynamic = "force-dynamic";

export default async function CatalogPage() {
  const [series, optionsCount, session] = await Promise.all([
    listSeriesWithCounts(),
    countOptions(),
    auth(),
  ]);
  // A hidden series is absent from browsing too, not just the item picker —
  // this page isn't ADMIN-gated (a MANAGER browses it every day), so
  // filtering only the picker would leave a hidden series one click away.
  // See `catalogVisibilityUserId` for why an ADMIN always sees every
  // series regardless.
  const hiddenCatalogIds = await getHiddenCatalogIds(catalogVisibilityUserId(session?.user));
  const visibleSeries = filterHiddenSeries(series, hiddenCatalogIds);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Catalog" description="Browse product series and global options." />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {visibleSeries.map((s) => (
          <SeriesCard key={s.id} series={s} />
        ))}

        {/* Distinct accent border sets the global "Options" entry apart from
            per-series cards — it isn't a series, it's a separate catalog. An
            icon block fills the image slot (options have no photo of their
            own) so it keeps the same horizontal rhythm as the series cards. */}
        <Link
          href="/catalog/options"
          className="focus-ring flex min-h-12 items-center gap-4 rounded-xl border-2 border-brand-accent-ink bg-white p-4 transition-colors hover:bg-slate-50 active:bg-slate-100"
        >
          <span
            className="flex size-28 shrink-0 items-center justify-center rounded-lg border border-brand-accent-ink/30 bg-brand-accent-ink/5 sm:size-32"
            aria-hidden="true"
          >
            <Puzzle className="size-8 text-brand-accent-ink" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="font-medium text-brand-dark">Options</span>
            <span className="text-sm text-slate-500">
              {optionsCount} global {optionsCount === 1 ? "option" : "options"}
            </span>
          </span>
          <ChevronRight className="size-5 shrink-0 text-brand-accent-ink/50" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

function SeriesCard({ series: s }: { series: SeriesWithCounts }) {
  return (
    <Link
      href={`/catalog/${s.id}`}
      className="focus-ring flex min-h-12 items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-brand-accent-ink hover:bg-slate-50 active:bg-slate-100"
    >
      <span className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 sm:size-32">
        {s.imageUrl ? (
          <SeriesCardImage src={s.imageUrl} />
        ) : (
          <Package className="size-8 text-slate-300" aria-hidden="true" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-medium text-brand-dark">{s.name}</span>
        <span className="font-mono text-xs text-slate-500">{s.code}</span>
        <span className="text-sm text-slate-500">
          {s.productCount} {s.productCount === 1 ? "product" : "products"}
        </span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-slate-300" aria-hidden="true" />
    </Link>
  );
}

/**
 * The photo on a series card, drawn in a 112/128 CSS px box.
 *
 * Same reasoning as `CatalogThumb` (src/components/catalog/catalog-thumb.tsx)
 * and `Avatar`: the stored `imageUrl` is the *print-resolution* original the
 * quotation sheet/PDF renders — a ~1-2MB 1280px PNG — and this page shows one
 * per series, so linking the originals means megabytes over a phone
 * connection for images displayed 10× smaller. `/api/files`'s `?w=` parameter
 * (src/lib/image-derivatives.ts) serves a WebP derivative of a few KB instead,
 * and, unlike the original, it is cached `immutable` for a year.
 *
 * SVG has no derivative — already vector and a few KB — so it is linked
 * as-is. Plain `<img>` rather than `next/image` because these URLs sit behind
 * session auth and Next's optimiser fetches them cookie-less (401).
 */
function SeriesCardImage({ src }: { src: string }) {
  if (src.endsWith(".svg")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" decoding="async" className="size-full object-contain p-2" />;
  }

  const width1x = pickDerivativeWidth(CARD_IMAGE_BOX_PX);
  const width2x = pickDerivativeWidth(CARD_IMAGE_BOX_PX * 2);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${src}?w=${width2x}`}
      srcSet={`${src}?w=${width1x} 1x, ${src}?w=${width2x} 2x`}
      alt=""
      loading="lazy"
      decoding="async"
      className="size-full object-contain p-2"
    />
  );
}
