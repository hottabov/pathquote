import { formatMoney } from "@/lib/format";
import type { CatalogPrice } from "@/lib/queries/catalog";
import { StatusBadge } from "@/components/ui-kit";
import { cn } from "@/lib/utils";

/**
 * Renders a formatted price (right-aligned tabular figures, per the design
 * direction's numeric-column convention), or an amber "price required"
 * badge when the item has no price row for the region or the price is
 * flagged for review.
 */
export function PriceDisplay({ price, className }: { price?: CatalogPrice; className?: string }) {
  if (!price || price.needsReview) {
    return (
      <StatusBadge tone="amber" className={cn("whitespace-nowrap", className)}>
        Price required
      </StatusBadge>
    );
  }

  return (
    <span className={cn("text-sm font-medium tabular-nums text-brand-dark", className)}>
      {formatMoney(price.amount, price.currency, price.currencySymbol)}
    </span>
  );
}

export function InactiveBadge() {
  return <StatusBadge tone="slate">Inactive</StatusBadge>;
}

export function CompatBadges({ seriesCodes }: { seriesCodes: string[] }) {
  if (seriesCodes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {seriesCodes.map((code) => (
        <StatusBadge key={code} tone="slate">
          {code}
        </StatusBadge>
      ))}
    </div>
  );
}
