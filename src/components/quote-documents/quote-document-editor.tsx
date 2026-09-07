"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui-kit";
import { RICH_TEXT_PROSE_CLASS } from "@/components/ui-kit/rich-text-prose";
import { updateQuoteDocument } from "@/lib/actions/quote-documents";
import type { QuoteToken } from "@/lib/quote-variables";
import { cn } from "@/lib/utils";
import { DocumentPreview } from "./document-preview";
import { DocumentRegionPane } from "./document-region-pane";
import { QuoteDocumentForm } from "./quote-document-form";

/** One stored `QuoteDocument` row, flattened for the client. */
export type QuoteDocumentVersion = {
  /** `null` is the global default (`regionId: null`); a code is that
   * region's own version. */
  regionCode: string | null;
  title: string;
  /** The raw stored column — HTML, or a legacy markdown row. Seeds the
   * editor and is posted back for a preview; NEVER rendered as markup by
   * this component. */
  body: string;
  includedByDefault: boolean;
  /** `renderStoredRichText(body)`, sanitized on the server. The only value
   * rendered as HTML here, and only present for a reader who may not edit —
   * an editing admin sees the body through Tiptap instead, which parses
   * against its own schema and needs no such pass. */
  bodyHtml: string | null;
};

export type QuoteDocumentEditorRegion = { code: string; name: string };

/**
 * Region-tabbed view of one whole quote document: a "Default" tab (the
 * `regionId: null` row every quote falls back to) plus one tab per region,
 * a dot on the ones that keep their own version. Succeeds the content-block
 * editor deleted in z37_drop_content_block, whose tab-strip structure this
 * lifts — with the ARIA contract that
 * component declared but never finished, which is why it is a rewrite rather
 * than a copy: it marked up `role="tablist"`/`role="tab"` with no
 * `aria-controls`, no `role="tabpanel"`, and no arrow-key movement, so a
 * screen reader was told "tab 3 of 5" and then given no panel to go to and no
 * way to move between tabs other than Tab-ing through all of them. Here each
 * tab owns its panel by id, only the selected tab is in the tab order, and
 * Left/Right/Home/End move the selection — the pattern the roles promise.
 *
 * `canEdit` is the whole of the permission story on this page. A MANAGER
 * reaches it (they need to know what their own client is signing — the
 * admin-only content screen this replaces never let them), sees every tab and
 * every word, and is shown no control that would fail: no editor, no
 * palette, no Save, no create-version, no delete. The actions themselves are
 * `requireAdmin()` regardless, so this is about not offering a button that
 * cannot work, not about security.
 */
export function QuoteDocumentEditor({
  documentKey,
  versions,
  activeRegions,
  canEdit,
  tokens,
}: {
  documentKey: string;
  versions: QuoteDocumentVersion[];
  activeRegions: QuoteDocumentEditorRegion[];
  canEdit: boolean;
  tokens: QuoteToken[];
}) {
  const [activeTab, setActiveTab] = useState<string | null>(null); // null = Default tab
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const versionByCode = new Map(versions.map((v) => [v.regionCode ?? "", v]));
  const defaultVersion = versionByCode.get("") ?? null;

  // Active regions, plus any region that still holds a version despite having
  // been deactivated since. Such a version keeps printing — nothing filters
  // by `Region.active` at render time — so hiding its tab would leave text a
  // customer receives with no screen anywhere that can edit or delete it.
  const regionTabs: QuoteDocumentEditorRegion[] = [...activeRegions];
  for (const version of versions) {
    if (!version.regionCode) continue;
    if (regionTabs.some((r) => r.code === version.regionCode)) continue;
    regionTabs.push({ code: version.regionCode, name: version.regionCode });
  }

  const tabOrder: (string | null)[] = [null, ...regionTabs.map((r) => r.code)];
  const selectedRegion = activeTab ? regionTabs.find((r) => r.code === activeTab) : undefined;
  const tabId = (code: string | null) => `document-tab-${code ?? "default"}`;
  const panelId = (code: string | null) => `document-panel-${code ?? "default"}`;

  function focusTab(code: string | null) {
    setActiveTab(code);
    tabRefs.current.get(code ?? "")?.focus();
  }

  /** Left/Right wrap around the strip, Home/End jump to its ends — the
   * movement `role="tablist"` promises a screen-reader user, and the reason
   * only the selected tab carries `tabIndex={0}` below. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabOrder.indexOf(activeTab);
    if (current === -1) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusTab(tabOrder[(current + 1) % tabOrder.length]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab(tabOrder[(current - 1 + tabOrder.length) % tabOrder.length]);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTab(tabOrder[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      focusTab(tabOrder[tabOrder.length - 1]);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        role="tablist"
        aria-label="Region"
        onKeyDown={handleKeyDown}
        className="inline-flex w-fit max-w-full flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1"
      >
        {/* No dot on Default: the dot means "this region keeps its own copy",
            which is not a thing the default can be. */}
        <TabChip
          code={null}
          label="Default"
          active={activeTab === null}
          customized={false}
          onSelect={setActiveTab}
          registerRef={(node) => registerTab(tabRefs.current, "", node)}
          tabId={tabId(null)}
          panelId={panelId(null)}
        />
        {regionTabs.map((region) => (
          <TabChip
            key={region.code}
            code={region.code}
            label={region.code}
            active={activeTab === region.code}
            customized={versionByCode.has(region.code)}
            onSelect={setActiveTab}
            registerRef={(node) => registerTab(tabRefs.current, region.code, node)}
            tabId={tabId(region.code)}
            panelId={panelId(region.code)}
          />
        ))}
      </div>

      {/* `tabIndex={0}` so a keyboard user who arrows to a tab can then Tab
          straight into its panel, which is the other half of what the
          tablist roles promise. */}
      <div
        role="tabpanel"
        id={panelId(activeTab)}
        aria-labelledby={tabId(activeTab)}
        tabIndex={0}
        className="focus-ring rounded-lg"
      >
        {activeTab === null ? (
          <DefaultPane
            documentKey={documentKey}
            version={defaultVersion}
            canEdit={canEdit}
            tokens={tokens}
          />
        ) : selectedRegion ? (
          canEdit ? (
            <DocumentRegionPane
              documentKey={documentKey}
              regionCode={selectedRegion.code}
              regionName={selectedRegion.name}
              version={versionByCode.get(selectedRegion.code) ?? null}
              hasDefault={defaultVersion !== null}
              tokens={tokens}
            />
          ) : versionByCode.has(selectedRegion.code) ? (
            <ReadOnlyPane version={versionByCode.get(selectedRegion.code)!} />
          ) : (
            <EmptyState
              icon={FileText}
              title={`No ${selectedRegion.code} version`}
              description={
                defaultVersion
                  ? `${selectedRegion.name} prints the default document shown on the Default tab.`
                  : `This document has no default, so ${selectedRegion.name} does not print it.`
              }
            />
          )
        ) : null}
      </div>
    </div>
  );
}

/** Kept out of the JSX so the ref callback stays void-returning — a
 * `Map.set` returns the map, which React 19 would take for a cleanup
 * function. */
function registerTab(refs: Map<string, HTMLButtonElement>, code: string, node: HTMLButtonElement | null) {
  if (node) refs.set(code, node);
  else refs.delete(code);
}

function DefaultPane({
  documentKey,
  version,
  canEdit,
  tokens,
}: {
  documentKey: string;
  version: QuoteDocumentVersion | null;
  canEdit: boolean;
  tokens: QuoteToken[];
}) {
  if (!version) {
    // A key with region versions but no `regionId: null` row — a region-only
    // document (D5), e.g. an agreement one entity alone offers. Not an error,
    // and not something this page invents a default for: creating one would
    // silently start printing it on every other region's quotes.
    return (
      <EmptyState
        icon={FileText}
        title="No default version"
        description="Only the regions with their own version print this document. Every other region prints nothing for it."
      />
    );
  }

  if (!canEdit) return <ReadOnlyPane version={version} />;

  return (
    <QuoteDocumentForm
      action={updateQuoteDocument.bind(null, documentKey, null)}
      idPrefix="quote-document-default"
      bodyLabel="Default document"
      defaultValues={version}
      tokens={tokens}
    />
  );
}

/** What a MANAGER sees on any tab: the document as stored, with its
 * `{{tokens}}` still visible — they are part of the text, and hiding them
 * would misrepresent what is actually written — plus the same Preview button
 * an admin gets, for reading it the way a customer will. */
function ReadOnlyPane({ version }: { version: QuoteDocumentVersion }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <h2 className="text-base font-semibold text-brand-dark">{version.title}</h2>
        {version.bodyHtml ? (
          <div className={cn("mt-3 max-w-[70ch] text-sm text-slate-700", RICH_TEXT_PROSE_CLASS)}>
            <div dangerouslySetInnerHTML={{ __html: version.bodyHtml }} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">This version is empty.</p>
        )}
      </div>
      <DocumentPreview
        idPrefix={`quote-document-read-${version.regionCode?.toLowerCase() ?? "default"}`}
        getBody={() => version.body}
      />
    </div>
  );
}

function TabChip({
  code,
  label,
  active,
  customized,
  onSelect,
  registerRef,
  tabId,
  panelId,
}: {
  code: string | null;
  label: string;
  active: boolean;
  customized: boolean;
  onSelect: (code: string | null) => void;
  registerRef: (node: HTMLButtonElement | null) => void;
  tabId: string;
  panelId: string;
}) {
  return (
    <button
      ref={registerRef}
      type="button"
      role="tab"
      id={tabId}
      aria-selected={active}
      aria-controls={panelId}
      // Roving tabindex: one stop for the whole strip, arrow keys inside it.
      tabIndex={active ? 0 : -1}
      onClick={() => onSelect(code)}
      className={cn(
        // `min-h-11` rather than padding alone — a 44px target is the floor
        // for a control this app expects to be used on a tablet.
        "focus-ring inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-brand text-white" : "text-slate-500 hover:text-brand-dark"
      )}
    >
      {label}
      {customized ? (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-white" : "bg-brand")}
          aria-hidden="true"
        />
      ) : null}
      {/* The dot is decorative — colour and shape alone carry the fact that
          this region keeps its own copy, which a screen reader cannot see and
          a colour-blind reader may not distinguish. This says it in words. */}
      {customized ? <span className="sr-only"> — has its own version</span> : null}
    </button>
  );
}
