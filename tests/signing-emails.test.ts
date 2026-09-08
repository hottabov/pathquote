import { describe, it, expect } from "vitest";
import {
  buildSigningInviteEmail,
  buildCompletionEmailForClient,
  buildCompletionEmailForAuthor,
  buildRevokedEmail,
} from "@/lib/email/signing";

const invite = {
  url: "https://q.example.com/sign/Tok3n-With_Specials",
  quoteNumber: "Q-AU-2026-001",
  total: "A$248,500.00",
  authorName: "Jane Manager",
  entityName: "Pathfinder Australia Pty Ltd",
  expiresOn: "7 October 2026",
  replyTo: "jane@example.com",
};

describe("buildSigningInviteEmail", () => {
  it("names the quote in the subject", () => {
    expect(buildSigningInviteEmail(invite).subject).toContain("Q-AU-2026-001");
  });

  it("passes the reply-to through untouched", () => {
    expect(buildSigningInviteEmail(invite).replyTo).toBe("jane@example.com");
  });

  it("puts the URL in the href but never in the visible link text", () => {
    const { html } = buildSigningInviteEmail(invite);
    expect(html).toContain(`href="${invite.url}"`);
    expect(html).not.toContain(">https://q.example.com/sign/Tok3n-With_Specials<");
  });

  it("includes the URL in the plain-text part, where there is no href", () => {
    expect(buildSigningInviteEmail(invite).text).toContain(invite.url);
  });

  it("escapes HTML in every interpolated field", () => {
    const { html } = buildSigningInviteEmail({
      ...invite,
      authorName: 'Ann <script>alert("x")</script> Smith',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an ampersand in the URL's href", () => {
    const { html } = buildSigningInviteEmail({
      ...invite,
      url: "https://q.example.com/sign/a&b",
    });
    expect(html).toContain('href="https://q.example.com/sign/a&amp;b"');
  });

  it("states when the link expires", () => {
    expect(buildSigningInviteEmail(invite).text).toContain("7 October 2026");
  });
});

describe("buildCompletionEmailForClient", () => {
  it("names the quote and says a copy is attached", () => {
    const mail = buildCompletionEmailForClient({
      quoteNumber: "Q-AU-2026-001",
      entityName: "Pathfinder Australia Pty Ltd",
      authorName: "Jane Manager",
      replyTo: "jane@example.com",
    });
    expect(mail.subject).toContain("Q-AU-2026-001");
    expect(mail.text.toLowerCase()).toContain("attached");
  });
});

describe("buildCompletionEmailForAuthor", () => {
  it("links into the app rather than attaching anything", () => {
    const mail = buildCompletionEmailForAuthor({
      quoteNumber: "Q-AU-2026-001",
      clientName: "Bob Buyer",
      companyName: "Acme Pty Ltd",
      documentUrl: "https://q.example.com/documents/abc",
      replyTo: null,
    });
    expect(mail.html).toContain('href="https://q.example.com/documents/abc"');
    expect(mail.replyTo).toBeUndefined();
  });
});

describe("buildRevokedEmail", () => {
  it("explains the link is dead without implying fault", () => {
    const mail = buildRevokedEmail({
      quoteNumber: "Q-AU-2026-001",
      authorName: "Jane Manager",
      replyTo: "jane@example.com",
    });
    expect(mail.subject).toContain("Q-AU-2026-001");
    expect(mail.text).toContain("Jane Manager");
  });
});
