import { SectionCard, EmptyState } from "@/components/ui-kit";
import { AddItemPicker } from "@/components/builder/add-item-picker";
import { ItemsList } from "@/components/builder/items-list";
import { PackageSearch } from "lucide-react";
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
    <SectionCard title="Items">
      {items.length === 0 ? (
        <EmptyState icon={PackageSearch} title="No items yet" description="Add one below to get started." />
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
        <div className="mt-4">
          <AddItemPicker documentId={documentId} catalog={catalog} />
        </div>
      )}
    </SectionCard>
  );
}
