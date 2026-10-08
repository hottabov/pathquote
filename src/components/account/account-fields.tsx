import { cn } from "@/lib/utils";
import { pickDerivativeWidth } from "@/lib/image-derivative-width";

/** Label/value row used by the Account page's read-only details.
 *
 * The label column is 10rem by default, which suits the Company and Bank
 * details cards -- "Legal address", "Legal ID", a bank's own row labels. A
 * list whose labels are all short can narrow it by setting
 * `--detail-label-width` on the enclosing <dl>: the identity card beside the
 * avatar has only Email, Phone and Region to name, and the default column
 * spent a third of that card's width on them while the email wrapped mid-
 * address beside it. Set on the list rather than passed per row so one
 * decision covers the whole list and the rows stay in one column. */
export function DetailRow({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[var(--detail-label-width,10rem)_minmax(0,1fr)] sm:gap-4",
        className
      )}
    >
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium text-brand-dark">{children}</dd>
    </div>
  );
}

/** Placeholder for an empty field. */
export function NotSet() {
  return (
    <span className="inline-flex w-fit items-center rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200 ring-inset">
      Not set
    </span>
  );
}

/** Shows `value` (trimmed), or `NotSet` when it is blank. Multi-line values
 * keep their line breaks. */
export function Value({ value }: { value: string | null | undefined }) {
  const text = value?.trim();
  return text ? <span className="whitespace-pre-line">{text}</span> : <NotSet />;
}

const LOGO_BOX_WIDTH = 128;

/** Region logo at screen size. Raster uploads use the `/api/files` `?w=`
 * derivative (src/lib/image-derivative-width.ts); SVG has none. */
export function EntityLogo({ src, alt }: { src: string; alt: string }) {
  const isVector = src.endsWith(".svg");
  const w1 = pickDerivativeWidth(LOGO_BOX_WIDTH);
  const w2 = pickDerivativeWidth(LOGO_BOX_WIDTH * 2);
  return (
    // Plain <img>: session-authed upload URL, same reasoning as Avatar.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={isVector ? src : `${src}?w=${w2}`}
      srcSet={isVector ? undefined : `${src}?w=${w1} 1x, ${src}?w=${w2} 2x`}
      alt={alt}
      className="h-10 w-auto max-w-[8rem] object-contain object-left"
    />
  );
}
