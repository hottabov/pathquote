/**
 * Why this exists: the client-facing quotation email has to (1) never leak a
 * literal `{{token}}` and never leave "prepared for ." when a value is
 * missing (spec §7.2), (2) always ship a plain-text alternative so it clears
 * spam filters, and (3) render a table-based CTA rather than a padded <a>
 * (Outlook drops the padding). These are all pure and checkable here; the
 * Gmail/Outlook/iOS render pass in §7.4 is the manual step this can't cover.
 */
import { describe, it, expect } from "vitest";
import {
  fillTokens,
  pickQuoteSendTemplate,
  renderQuoteSendDraft,
  buildQuoteSendEmail,
  DEFAULT_FIRST_SEND_SUBJECT,
  DEFAULT_RESEND_SUBJECT,
  type QuoteSendVars,
  type QuoteSendContext,
} from "@/lib/email/quote-send";

const vars: QuoteSendVars = {
  clientFirstName: "Pat",
  clientLastName: "Client",
  clientCompany: "Acme Pty Ltd",
  quoteNumber: "Q-AU-2026-001",
  quoteLabel: "Q-AU-2026-001-R1",
  quoteRevision: "1",
  quoteTotal: "$11,220.00",
  quoteCurrency: "AUD",
  quoteValidUntil: "30 Oct 2026",
  managerFirstName: "Sam",
  managerFullName: "Sam Seller",
  managerTitle: "Sales Manager",
  managerPhone: "+61 400 111 222",
  managerEmail: "sam@pathfinder.example",
  companyName: "Pathfinder",
  companyWebsite: "pathfindercut.com",
  companyAddress: "2 Factory Rd, Melbourne",
  signLink: "https://q.example/sign/abc123",
};

describe("fillTokens", () => {
  it("substitutes known tokens", () => {
    expect(fillTokens("Hi {{clientFirstName}},", vars)).toBe("Hi Pat,");
  });

  it("replaces a missing token with empty string and tidies the debris", () => {
    // The space the emptied token leaves before the period is removed; the
    // period itself stays (distinguishing a dangling one from a real sentence
    // stop isn't worth the risk — the manager previews and edits before send).
    expect(fillTokens("prepared for {{clientCompany}}.", { clientCompany: "" })).toBe("prepared for.");
    expect(fillTokens("Hi {{clientFirstName}},", {})).toBe("Hi,");
  });

  it("collapses doubled spaces left by a removed token", () => {
    expect(fillTokens("a {{x}} b", {})).toBe("a b");
  });

  it("preserves blank lines between paragraphs", () => {
    expect(fillTokens("one\n\ntwo", {})).toBe("one\n\ntwo");
  });

  it("never leaves a literal {{token}} behind", () => {
    expect(fillTokens("x {{unknownThing}} y", vars)).not.toContain("{{");
  });
});

describe("pickQuoteSendTemplate", () => {
  it("uses the first-send subject for revision 0", () => {
    expect(pickQuoteSendTemplate(0).subject).toBe(DEFAULT_FIRST_SEND_SUBJECT);
  });

  it("uses the revised subject for revision > 0", () => {
    expect(pickQuoteSendTemplate(1).subject).toBe(DEFAULT_RESEND_SUBJECT);
    expect(pickQuoteSendTemplate(5).subject).toBe(DEFAULT_RESEND_SUBJECT);
  });

  it("prefers an admin override when supplied", () => {
    const picked = pickQuoteSendTemplate(0, { firstSend: { subject: "Custom {{quoteLabel}}" } });
    expect(picked.subject).toBe("Custom {{quoteLabel}}");
  });
});

describe("renderQuoteSendDraft", () => {
  it("returns finished, token-free subject and body", () => {
    const draft = renderQuoteSendDraft(pickQuoteSendTemplate(0), vars);
    expect(draft.subject).toBe("Pathfinder — Quotation Q-AU-2026-001-R1 for Acme Pty Ltd");
    expect(draft.body).toContain("Hi Pat,");
    expect(draft.body).not.toContain("{{");
  });
});

const ctx: QuoteSendContext = {
  subject: "Pathfinder — Quotation Q-AU-2026-001-R1 for Acme Pty Ltd",
  message: "Hi Pat,\n\nPlease find attached quotation Q-AU-2026-001-R1.\n\nKind regards,",
  summary: {
    label: "Q-AU-2026-001-R1",
    configuration: "M-Series cutter + cutting table",
    total: "$11,220.00",
    validUntil: "30 Oct 2026",
  },
  signature: { fullName: "Sam Seller", title: "Sales Manager", phone: "+61 400 111 222", email: "sam@x.example" },
  company: { name: "Pathfinder", website: "pathfindercut.com", address: "2 Factory Rd" },
  signLink: "https://q.example/sign/abc123",
  logoUrl: null,
};

describe("buildQuoteSendEmail", () => {
  const email = buildQuoteSendEmail(ctx);

  it("passes the subject through unchanged", () => {
    expect(email.subject).toBe(ctx.subject);
  });

  it("renders the sign link inside a table-based button, not a bare padded <a>", () => {
    expect(email.html).toContain(ctx.signLink);
    expect(email.html).toContain("Review &amp; sign quotation");
    // the CTA sits in its own presentation table with a bgcolor cell
    expect(email.html).toMatch(/bgcolor="#111827"[^>]*>\s*<a href="https:\/\/q\.example\/sign\/abc123"/);
  });

  it("inlines the manager's message with its line breaks preserved as paragraphs", () => {
    expect(email.html).toContain("Hi Pat,");
    expect(email.html).toContain("Kind regards,");
  });

  it("includes the summary card and auto-composed signature and footer", () => {
    expect(email.html).toContain("Q-AU-2026-001-R1");
    expect(email.html).toContain("$11,220.00");
    expect(email.html).toContain("Sam Seller");
    expect(email.html).toContain("pathfindercut.com");
  });

  it("uses explicit backgrounds so dark mode can't repaint the card", () => {
    expect(email.html).toContain("background:#ffffff");
  });

  it("escapes HTML in user-supplied content", () => {
    const evil = buildQuoteSendEmail({ ...ctx, message: "Hi <script>alert(1)</script>" });
    expect(evil.html).not.toContain("<script>alert(1)</script>");
    expect(evil.html).toContain("&lt;script&gt;");
  });

  it("ships a plain-text alternative carrying the same essentials", () => {
    expect(email.text).toContain("Review & sign: https://q.example/sign/abc123");
    expect(email.text).toContain("Q-AU-2026-001-R1");
    expect(email.text).toContain("Sam Seller");
    expect(email.text).not.toContain("<");
  });

  it("falls back to the company name when there is no logo", () => {
    expect(email.html).toContain(">Pathfinder</span>");
  });
});
