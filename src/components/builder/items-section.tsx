import { EmptyState } from "@/components/ui-kit";
import { AddItemPicker } from "@/components/builder/add-item-picker";
import { ItemsList } from "@/components/builder/items-list";
import { Package, PackageSearch } from "lucide-react";
import type { BuilderItem, CompatibleOption, ItemPickerSeries } from "@/lib/queries/documents";

/**
 * The builder's "Items" section: one card per DocumentItem (product
 * snapshot, its option chips/editor, its discount field and its computed
 * total) plus the "Add item" picker. `compatibleOptionsByItemKey` is
 * preloaded once per distinct (productId, seriesId) pair on the page (see
 * getDocumentForBuilder + listCompatibleOptions) and looked up per item by
 * its `productId` (falling back to `series:<seriesId>` in the defensive
 * case of an item with no resolvable product — see `BuilderItem`) rather
 * than re-fetched per card.
 */
export function ItemsSection({
  documentId,
  items,
  currency,
  currencySymbol,
  catalog,
  compatibleOptionsByItemKey,
  showOptionIcons = true,
  screenSideImages,
  readOnly = false,
}: {
  documentId: string;
  items: BuilderItem[];
  currency: string;
  currencySymbol: string | null;
  catalog: ItemPickerSeries[];
  compatibleOptionsByItemKey: Record<string, CompatibleOption[]>;
  /** "ui.showOptionIcons" app setting, read server-side by the builder page
   * and threaded down to `ItemOptionsEditor` — see its own doc comment. */
  showOptionIcons?: boolean;
  /** See `ItemsList`'s own doc comment on the prop of the same name. */
  screenSideImages: Record<string, string>;
  readOnly?: boolean;
}) {
  return (
    // Deliberately NOT a SectionCard. Each machine is its own card on the
    // page background now, which removes a level of nesting (a card inside a
    // card) and, more to the point, gives one machine a visible edge: with
    // three of them expanded inside one wrapper, separated by a 12px gap and
    // sharing a background, it took a moment to work out where one ended.
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <Package className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
        <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">Machines</h2>
        {items.length > 0 ? (
          <span className="text-xs text-slate-400">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        ) : null}
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title="No machines yet"
          description="Add one below to start building this quote."
        />
      ) : (
        <ItemsList
          documentId={documentId}
          items={items}
          currency={currency}
          currencySymbol={currencySymbol}
          compatibleOptionsByItemKey={compatibleOptionsByItemKey}
          showOptionIcons={showOptionIcons}
          screenSideImages={screenSideImages}
          readOnly={readOnly}
        />
      )}

      {!readOnly && (
        <div className="mt-1">
          <AddItemPicker documentId={documentId} catalog={catalog} />
        </div>
      )}
    </section>
  );
}
