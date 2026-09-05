"use client";

import { forwardRef, useEffect, useImperativeHandle } from "react";
import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Bold, Italic, Heading2, Heading3, List, ListOrdered, Link as LinkIcon, Link2Off, RemoveFormatting } from "lucide-react";
import { cn } from "@/lib/utils";
import { RICH_TEXT_PROSE_CLASS } from "./rich-text-prose";

type ToolbarButtonProps = {
  label: string;
  icon: typeof Bold;
  onAction: () => void;
  active?: boolean;
  disabled?: boolean;
};

/** One 44px toolbar icon button — `onMouseDown` calls `preventDefault()` so
 * clicking it never steals focus away from the editing surface (same trick
 * the old `MarkdownToolbar` used for the textarea it drove). `active` (from
 * `editor.isActive(...)`) toggles a brand-colored pressed state, distinct
 * from the plain hover state, so the toolbar visibly reflects the mark/node
 * the caret currently sits in. */
function ToolbarButton({ label, icon: Icon, onAction, active, disabled }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAction}
      className={cn(
        "focus-ring flex size-11 shrink-0 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-50",
        active ? "bg-brand text-white hover:bg-brand/90" : "text-slate-500 hover:bg-white hover:text-brand-dark"
      )}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

function EditorToolbar({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  // `useEditorState` re-renders this toolbar on every transaction that
  // changes the selected slice (marks/node/link-attrs at the caret) without
  // re-rendering on every keystroke's full document change — the pattern
  // Tiptap v3's React bindings replace manual `onTransaction`-driven
  // `forceUpdate` with.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      heading2: editor.isActive("heading", { level: 2 }),
      heading3: editor.isActive("heading", { level: 3 }),
      bulletList: editor.isActive("bulletList"),
      orderedList: editor.isActive("orderedList"),
      link: editor.isActive("link"),
    }),
  });

  function setLink() {
    const previousUrl = (editor.getAttributes("link").href as string | undefined) ?? "";
    // No text-prompt dialog exists in this app's ui-kit (only the boolean
    // `useConfirm`) — a plain `window.prompt` is the standard
    // Tiptap-recommended fallback for a one-field "URL" input.
    const url = window.prompt("Link URL", previousUrl || "https://");
    if (url === null) return; // cancelled
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  }

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap gap-0.5 rounded-t-lg border border-b-0 border-slate-200 bg-slate-50 p-1"
    >
      <ToolbarButton
        label="Bold"
        icon={Bold}
        active={state.bold}
        disabled={disabled}
        onAction={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        label="Italic"
        icon={Italic}
        active={state.italic}
        disabled={disabled}
        onAction={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        label="Heading 2"
        icon={Heading2}
        active={state.heading2}
        disabled={disabled}
        onAction={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      />
      <ToolbarButton
        label="Heading 3"
        icon={Heading3}
        active={state.heading3}
        disabled={disabled}
        onAction={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      />
      <ToolbarButton
        label="Bullet list"
        icon={List}
        active={state.bulletList}
        disabled={disabled}
        onAction={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        label="Numbered list"
        icon={ListOrdered}
        active={state.orderedList}
        disabled={disabled}
        onAction={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton label="Add or edit link" icon={LinkIcon} active={state.link} disabled={disabled} onAction={setLink} />
      <ToolbarButton
        label="Remove link"
        icon={Link2Off}
        disabled={disabled || !state.link}
        onAction={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
      />
      <ToolbarButton
        label="Clear formatting"
        icon={RemoveFormatting}
        disabled={disabled}
        onAction={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
      />
    </div>
  );
}

export type RichTextEditorHandle = {
  /** Inserts plain text at the current cursor position (replacing any
   * selection), same as typing would — used by `ContentBlockForm`'s
   * placeholder-chip row (clicking a `{{token}}` chip) via
   * `editor.commands.insertContent`. A no-op while the editor hasn't
   * mounted yet. */
  insertContent: (text: string) => void;
};

/**
 * WYSIWYG replacement for the old markdown textarea + `MarkdownToolbar` +
 * separate preview pane (see notes-section.tsx / content-block-form.tsx):
 * editing shows formatted text immediately, no markdown syntax visible and
 * no separate preview needed. `value`/`onChange` carry Tiptap's HTML output
 * directly — the caller owns converting a stored value to HTML before first
 * mount (`toEditorHtml`, for a legacy markdown row) and sanitizing on save
 * (`sanitizeRichText`, done server-side in the write actions so this
 * component itself stays a plain controlled input).
 *
 * `StarterKit`'s heading is restricted to levels 2/3 (no h1 — that tier is
 * reserved for `.pq-section-title` in the sheets; no h4-6 — never used
 * anywhere in this app's content) and its bundled `blockquote`/`code`/
 * `codeBlock`/`horizontalRule`/`strike`/`underline`/`link` are all disabled:
 * this editor's toolbar has no button for any of them, so leaving them
 * enabled would let a stray keyboard shortcut (e.g. `Ctrl+Shift+X` for
 * strike) produce a mark the toolbar can't toggle back off or show as
 * active. `link` specifically is re-added as its own top-level extension
 * (same `@tiptap/extension-link` package StarterKit itself bundles) so
 * `openOnClick: false` can be set — the editor must never navigate away
 * when an admin single-clicks a link while writing.
 *
 * Import it through `./rich-text-editor-lazy`, not from here: this module is
 * the root of the Tiptap/ProseMirror dependency tree, and a static import of
 * it puts all of that in the importing route's entry chunk.
 *
 * Exposes an imperative `RichTextEditorHandle` (via `ref`) rather than a
 * bigger prop surface, since `insertContent` is a one-off need of a single
 * caller (`ContentBlockForm`'s placeholder chips) — every other caller can
 * ignore the ref entirely.
 */
export const RichTextEditor = forwardRef<
  RichTextEditorHandle,
  {
    value: string;
    onChange: (html: string) => void;
    placeholder?: string;
    disabled?: boolean;
  }
>(function RichTextEditor({ value, onChange, placeholder, disabled }, ref) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: false,
      }),
      Link.configure({ openOnClick: false }),
    ],
    content: value,
    editable: !disabled,
    // Next.js SSR: defer the first render to the client so hydration never
    // has to reconcile server-rendered editor markup against ProseMirror's
    // own DOM management (the Tiptap-recommended setting for the App
    // Router — see https://tiptap.dev/docs/guides/nextjs).
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn("min-h-[200px] px-3 py-2 text-sm text-brand-dark focus:outline-none", RICH_TEXT_PROSE_CLASS),
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  // Reactive `editor.isEmpty` (for the placeholder overlay below) via
  // `useEditorState`'s external-store subscription rather than a
  // `useState` mirrored by `setState` calls in `onCreate`/`onUpdate`/the
  // content-resync effect — the same "watch the editor, don't shadow it"
  // pattern `EditorToolbar` uses for its active-mark flags.
  const isEmpty = useEditorState({
    editor,
    selector: ({ editor }) => editor?.isEmpty ?? value.trim().length === 0,
  });

  // Keeps the editable state in sync when `disabled` changes after mount
  // (e.g. a save in flight) — `editable` in the options above only applies
  // at construction time.
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Re-syncs the editor's content when `value` changes for a reason other
  // than the editor's own typing (e.g. the caller loaded a different
  // document/block) — guarded by the equality check so a change that
  // originated from `onUpdate` above never gets echoed back in and reset
  // the caret/undo-history. This only ever touches the editor (an external
  // system), never React state directly — `isEmpty` above picks up the
  // resulting doc change on its own via the store subscription.
  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  useImperativeHandle(
    ref,
    () => ({
      insertContent: (text: string) => {
        editor?.chain().focus().insertContent(text).run();
      },
    }),
    [editor]
  );

  return (
    <div className="flex flex-col">
      {editor ? <EditorToolbar editor={editor} disabled={disabled} /> : null}
      <div
        className={cn(
          "focus-ring relative rounded-b-lg border border-slate-200 bg-white",
          disabled && "cursor-not-allowed bg-slate-50 opacity-60"
        )}
      >
        {placeholder && isEmpty ? (
          <div className="pointer-events-none absolute top-2 left-3 text-sm text-slate-500" aria-hidden="true">
            {placeholder}
          </div>
        ) : null}
        <EditorContent editor={editor} />
      </div>
    </div>
  );
});
