// Minimal, pure markdown -> HTML renderer for trusted admin content, never
// for anything an end user typed. Deliberately NOT a general-purpose markdown
// parser: it only understands the handful of constructs the legal text was
// originally authored in and that `renderStoredRichText` still has to read
// back — paragraphs, **bold**, *italic*, #/##/### headings, "- "
// bullet lists (one level of nesting via a 2+ space indent), and line breaks
// within a paragraph. No `@/lib/db` or `next/*` imports, same reasoning as
// src/lib/sheet-data.ts: a plain `vitest run` of this file must never need
// `DATABASE_URL` set.
//
// Every input is HTML-escaped up front — before any markdown transform runs
// — so a block body can never inject raw HTML/script tags into the rendered
// quotation sheet, even though the content is admin-authored ("trusted-ish",
// not literally untrusted user input) this stays defensive rather than
// assuming admins never paste something they shouldn't.

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline transforms applied within a single line/paragraph, post-escaping:
 * `**bold**` before `*italic*` so a bold span's own asterisks are consumed
 * first and never misread as two stray italic markers. */
function renderInline(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
}

type ListNode = { text: string; children: ListNode[] };

/** Builds a (possibly one-level-nested) `<ul>` from a contiguous run of
 * "- item" / "  - nested item" lines, using each line's leading whitespace
 * length to decide nesting — any indent greater than the current list's own
 * item indent opens a nested `<ul>` inside the last item at that level. */
function renderList(lines: string[]): string {
  const root: ListNode[] = [];
  const stack: { indent: number; nodes: ListNode[] }[] = [{ indent: -1, nodes: root }];

  for (const line of lines) {
    const match = /^(\s*)-\s+(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const node: ListNode = { text: match[2], children: [] };

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    stack[stack.length - 1].nodes.push(node);
    stack.push({ indent, nodes: node.children });
  }

  function renderNodes(nodes: ListNode[]): string {
    if (nodes.length === 0) return "";
    const items = nodes.map((n) => `<li>${renderInline(n.text)}${renderNodes(n.children)}</li>`).join("");
    return `<ul>${items}</ul>`;
  }

  return renderNodes(root);
}

const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/;
const LIST_ITEM_PATTERN = /^\s*-\s+/;

/**
 * Renders `md` to a small, safe HTML fragment: blocks are split on one-or-
 * more blank lines, then each block is classified as a heading (single line
 * starting with `#`/`##`/`###`), a list (every line starts with `- `, at any
 * indent), or a paragraph (remaining lines joined with `<br>`). Everything is
 * HTML-escaped before any of these transforms run.
 */
export function renderMarkdown(md: string): string {
  const escaped = escapeHtml(md).replace(/\r\n/g, "\n");
  const blocks = escaped
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const rendered = blocks.map((block) => {
    const lines = block.split("\n");

    if (lines.length === 1) {
      const headingMatch = HEADING_PATTERN.exec(lines[0]);
      if (headingMatch) {
        const level = headingMatch[1].length;
        return `<h${level}>${renderInline(headingMatch[2])}</h${level}>`;
      }
    }

    if (lines.every((l) => LIST_ITEM_PATTERN.test(l))) {
      return renderList(lines);
    }

    return `<p>${lines.map(renderInline).join("<br>")}</p>`;
  });

  return rendered.join("\n");
}
