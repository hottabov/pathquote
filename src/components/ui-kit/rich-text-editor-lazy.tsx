"use client";

import type { ComponentProps } from "react";
import dynamic from "next/dynamic";
import type { RichTextEditor as RichTextEditorComponent } from "./rich-text-editor";
import { RICH_TEXT_PROSE_CLASS } from "./rich-text-prose";
import { cn } from "@/lib/utils";

/** Mirrors the class `RichTextEditor` hands ProseMirror via `editorProps`, so
 * the skeleton's editing surface reserves exactly the height the real one
 * will occupy once it mounts. */
const EDITOR_SURFACE_CLASS = cn("min-h-[200px] px-3 py-2 text-sm text-brand-dark", RICH_TEXT_PROSE_CLASS);

/**
 * The placeholder shown while the editor chunk is in flight. It reproduces
 * the real editor's box model exactly — a 44px toolbar row inside the same
 * `p-1`/border strip, then a `min-h-[200px] px-3 py-2` surface inside the
 * same rounded border — so the swap-in is a repaint rather than a reflow of
 * everything below it (the builder's Notes card sits above a sticky footer
 * and a long items list; a few pixels of shift there is very visible).
 *
 * It carries no toolbar buttons and no placeholder text: `next/dynamic`'s
 * `loading` component is rendered without the host's props, so it has nothing
 * to render them from, and a skeleton that mimics buttons an admin cannot yet
 * click would be worse than an empty strip.
 */
function RichTextEditorSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true" aria-live="polite" aria-label="Loading editor">
      <div className="flex flex-wrap gap-0.5 rounded-t-lg border border-b-0 border-slate-200 bg-slate-50 p-1">
        <div className="size-11" aria-hidden="true" />
      </div>
      <div className="relative rounded-b-lg border border-slate-200 bg-white">
        <div className={EDITOR_SURFACE_CLASS} aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * `RichTextEditor`, loaded on demand — the import every caller should use.
 *
 * Tiptap/ProseMirror is by a wide margin the heaviest dependency any of this
 * app's forms pulls in, and the three screens that host an editor (the
 * document builder's Notes section, the product form, the content-block form)
 * are otherwise ordinary forms. Importing it statically put all of it in
 * those routes' entry chunks, the builder's most of all — the heaviest page
 * in the app, where the editor sits in a collapsed-by-default card most
 * sessions never open.
 *
 * `ssr: false` because the editor already refuses to render on the server
 * (`immediatelyRender: false`, the Tiptap-recommended App Router setting), so
 * prerendering it produced nothing but the wrapper markup anyway; skipping it
 * keeps ProseMirror out of the server bundle for these routes too.
 *
 * Props and the imperative `RichTextEditorHandle` ref pass straight through:
 * `next/dynamic` spreads everything it receives — `ref` included, since React
 * 19 hands function components their ref as an ordinary prop — into the lazy
 * component.
 */
export const RichTextEditor = dynamic<ComponentProps<typeof RichTextEditorComponent>>(
  () => import("./rich-text-editor").then((m) => m.RichTextEditor),
  { ssr: false, loading: RichTextEditorSkeleton }
);

export type { RichTextEditorHandle } from "./rich-text-editor";
