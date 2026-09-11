import { describe, it, expect } from "vitest";
import {
  isHtmlContent,
  sanitizeRichText,
  renderStoredRichText,
  toEditorHtml,
  sanitizeIfHtml,
  toPlainTextPreview,
  isBlankRichText,
} from "../src/lib/rich-text";

// Pure module — no @/lib/db import, so this never needs DATABASE_URL set
// (same reasoning as tests/markdown.test.ts).

describe("isHtmlContent", () => {
  it("is false for legacy markdown", () => {
    expect(isHtmlContent("## Heading\n\nSome **bold** text.")).toBe(false);
    expect(isHtmlContent("- one\n- two")).toBe(false);
    expect(isHtmlContent("Plain text, no markup at all.")).toBe(false);
  });

  it("is false for an empty/whitespace-only value", () => {
    expect(isHtmlContent("")).toBe(false);
    expect(isHtmlContent("   \n  ")).toBe(false);
  });

  it("is true for Tiptap-shaped HTML starting with a block tag", () => {
    expect(isHtmlContent("<p>Hello <strong>world</strong></p>")).toBe(true);
    expect(isHtmlContent("<h2>Title</h2><p>Body</p>")).toBe(true);
    expect(isHtmlContent("<ul><li>one</li><li>two</li></ul>")).toBe(true);
  });

  it("is true when a recognised tag appears without the value starting with '<'", () => {
    expect(isHtmlContent("  <p>leading whitespace</p>")).toBe(true);
  });
});

describe("toEditorHtml", () => {
  it("passes already-HTML content through unchanged", () => {
    const html = "<p>Hello <strong>world</strong></p>";
    expect(toEditorHtml(html)).toBe(html);
  });

  it("renders legacy markdown to HTML", () => {
    expect(toEditorHtml("**bold** text")).toBe("<p><strong>bold</strong> text</p>");
  });
});

describe("sanitizeRichText", () => {
  it("strips <script> tags and their content", () => {
    const out = sanitizeRichText("<p>Hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>Hi</p>");
  });

  it("strips <iframe> tags and their content", () => {
    const out = sanitizeRichText('<p>Hi</p><iframe src="https://evil.example"></iframe>');
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<p>Hi</p>");
  });

  it("strips on* event-handler attributes but keeps the element and its text", () => {
    const out = sanitizeRichText('<p onclick="alert(1)">Click me</p>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain("Click me");
  });

  it("strips style attributes", () => {
    const out = sanitizeRichText('<p style="color:red">Styled</p>');
    expect(out).not.toMatch(/style=/i);
    expect(out).toContain("Styled");
  });

  it("keeps every allowed tag", () => {
    const html =
      "<h2>H2</h2><h3>H3</h3><p><strong>b</strong> <b>b2</b> <em>i</em> <i>i2</i> <u>u</u> <s>s</s></p>" +
      "<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>quote</blockquote><p>line<br>break</p>";
    const out = sanitizeRichText(html);
    for (const tag of ["h2", "h3", "strong", "b", "em", "i", "u", "s", "ul", "li", "ol", "blockquote", "br"]) {
      expect(out).toContain(`<${tag}`);
    }
  });

  it("strips a javascript: href but keeps the link's text", () => {
    const out = sanitizeRichText('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain("click");
  });

  it("strips a data: href", () => {
    const out = sanitizeRichText('<a href="data:text/html,<script>alert(1)</script>">click</a>');
    expect(out).not.toMatch(/data:/i);
    expect(out).toContain("click");
  });

  it("keeps an http(s) href", () => {
    const out = sanitizeRichText('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it("keeps a mailto href", () => {
    const out = sanitizeRichText('<a href="mailto:test@example.com">email</a>');
    expect(out).toContain('href="mailto:test@example.com"');
  });

  it("drops a heading level not in the allowlist (h1), keeping its text", () => {
    const out = sanitizeRichText("<h1>Title</h1>");
    expect(out).not.toContain("<h1");
    expect(out).toContain("Title");
  });
});

describe("renderStoredRichText", () => {
  it("sanitizes already-HTML content (the isHtmlContent branch)", () => {
    const out = renderStoredRichText('<p onclick="alert(1)">Hi</p><script>alert(2)</script>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>Hi</p>");
  });

  it("renders legacy markdown (the non-HTML branch), same as renderMarkdown", () => {
    const out = renderStoredRichText("## Title\n\nSome **bold** text.");
    expect(out).toBe("<h2>Title</h2>\n<p>Some <strong>bold</strong> text.</p>");
  });

  it("HTML-escapes raw markdown text that merely contains a stray '<' (still classified as markdown)", () => {
    // No recognised tag anywhere in this string, so isHtmlContent is false
    // and it goes through renderMarkdown's own escaping.
    const out = renderStoredRichText("Use a < b to compare");
    expect(out).toContain("&lt; b");
  });
});

describe("sanitizeIfHtml", () => {
  it("sanitizes HTML content, stripping a script tag", () => {
    const out = sanitizeIfHtml("<p>Hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>Hi</p>");
  });

  it("returns plain text/legacy markdown unchanged (not run through renderMarkdown)", () => {
    // Unlike renderStoredRichText, this is a write-boundary helper: legacy
    // content is stored exactly as typed, same as before the RichTextEditor
    // existed — only actual editor-produced HTML gets sanitized.
    expect(sanitizeIfHtml("Ships with mounting bracket")).toBe("Ships with mounting bracket");
    expect(sanitizeIfHtml("**bold** markdown")).toBe("**bold** markdown");
  });

  it("returns an empty string unchanged", () => {
    expect(sanitizeIfHtml("")).toBe("");
  });
});

// Commit 2: catalogue list rows show a one-line description preview
// (Product.description / Option.shortDescription), not the full rendered
// rich text a detail page shows.
describe("toPlainTextPreview", () => {
  it("returns null for null, empty, or whitespace-only input", () => {
    expect(toPlainTextPreview(null)).toBeNull();
    expect(toPlainTextPreview("")).toBeNull();
    expect(toPlainTextPreview("   ")).toBeNull();
  });

  it("strips tags from HTML content, leaving plain text", () => {
    expect(toPlainTextPreview("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
  });

  it("strips markup from legacy markdown content too", () => {
    expect(toPlainTextPreview("## Title\n\nSome **bold** text.")).toBe("Title Some bold text.");
  });

  it("collapses internal whitespace/newlines to single spaces (a plain multi-line textarea value)", () => {
    expect(toPlainTextPreview("Line one\nLine two\n\nLine three")).toBe("Line one Line two Line three");
  });

  it("decodes common HTML entities after stripping tags", () => {
    expect(toPlainTextPreview("<p>Nuts &amp; bolts &mdash; not decoded, kept as-is</p>")).toContain("Nuts & bolts");
  });

  it("never leaves any tag markup in the result", () => {
    const out = toPlainTextPreview("<h2>Spec</h2><ul><li>one</li><li>two</li></ul>");
    expect(out).not.toMatch(/[<>]/);
    expect(out).toBe("Spec one two");
  });
});

// `isBlankRichText` is what keeps an untouched Notes field from printing an
// empty "Notes" section on a customer-facing quote — the editor saves markup
// for a field nobody typed into, and that markup is truthy.
describe("isBlankRichText", () => {
  it("treats null/empty/whitespace as blank", () => {
    expect(isBlankRichText(null)).toBe(true);
    expect(isBlankRichText("")).toBe(true);
    expect(isBlankRichText("   \n  ")).toBe(true);
  });

  it("treats the editor's empty-document markup as blank", () => {
    expect(isBlankRichText("<p></p>")).toBe(true);
    expect(isBlankRichText("<p><br></p>")).toBe(true);
    expect(isBlankRichText("<p>   </p>")).toBe(true);
  });

  it("treats nested/repeated empty blocks as blank", () => {
    expect(isBlankRichText("<p></p><p></p>")).toBe(true);
    expect(isBlankRichText("<ul><li></li></ul>")).toBe(true);
    expect(isBlankRichText("<blockquote><p><br></p></blockquote>")).toBe(true);
  });

  it("is not blank as soon as there is any visible text", () => {
    expect(isBlankRichText("<p>Deposit due on order.</p>")).toBe(false);
    expect(isBlankRichText("<p><strong>x</strong></p>")).toBe(false);
    expect(isBlankRichText("Legacy markdown note")).toBe(false);
  });

  it("is not blank for text that only appears inside a stripped tag", () => {
    // DOMPurify drops the tag but keeps its words — those words are content.
    expect(isBlankRichText("<div>kept text</div>")).toBe(false);
  });
});
