import { describe, it, expect } from "vitest";
import { buildSupportMessageEmail } from "@/lib/email/support-message";
import { resolveSupportRecipients, NO_DEVELOPER_ERROR } from "@/lib/support";

const BASE = {
  subject: "Prices showing wrong currency",
  body: "The X-Calibre series is showing AUD prices for a US company.",
  authorEmail: "jane@pathfindercut.com",
  authorName: "Jane Smith",
  authorRole: "MANAGER",
  regionName: "United States",
  appVersion: "0.1.0",
  submittedAt: new Date("2026-09-03T10:00:00.000Z"),
};

describe("buildSupportMessageEmail", () => {
  it("subjects the email with the product name and the sender's subject", () => {
    const { subject } = buildSupportMessageEmail(BASE);
    expect(subject).toContain("PathQuote Support");
    expect(subject).toContain("Prices showing wrong currency");
  });

  it("puts the sender's message in the plain-text body verbatim", () => {
    const { text } = buildSupportMessageEmail(BASE);
    expect(text).toContain(BASE.body);
  });

  it("includes who sent it, their role, region, and app version as context", () => {
    const { text } = buildSupportMessageEmail(BASE);
    expect(text).toContain("jane@pathfindercut.com");
    expect(text).toContain("MANAGER");
    expect(text).toContain("United States");
    expect(text).toContain("0.1.0");
  });

  it("falls back to 'Not set' for a missing region rather than blank", () => {
    const { text } = buildSupportMessageEmail({ ...BASE, regionName: null });
    expect(text).toContain("Not set");
  });

  it("escapes the body and subject in the HTML version", () => {
    const { html } = buildSupportMessageEmail({
      ...BASE,
      subject: "<script>alert(1)</script>",
      body: "3 < 5 & 5 > 3",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("3 &lt; 5 &amp; 5 &gt; 3");
  });

  it("preserves line breaks in the HTML body", () => {
    const { html } = buildSupportMessageEmail({ ...BASE, body: "line one\nline two" });
    expect(html).toContain("line one<br />line two");
  });

  it("passes a caller-provided Reply-To straight through", () => {
    const { replyTo } = buildSupportMessageEmail({ ...BASE, replyTo: "jane@pathfindercut.com" });
    expect(replyTo).toBe("jane@pathfindercut.com");
  });

  it("has no Reply-To when the caller didn't provide one", () => {
    expect(buildSupportMessageEmail(BASE).replyTo).toBeUndefined();
  });
});


// --- was tests/support.test.ts: resolveSupportRecipients (src/lib/support.ts) ------------------

describe("resolveSupportRecipients", () => {
  it("refuses plainly when no one holds the Developer role, rather than silently succeeding", () => {
    const result = resolveSupportRecipients([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(NO_DEVELOPER_ERROR);
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns every developer's email when at least one exists", () => {
    const result = resolveSupportRecipients([
      { email: "dev1@pathfindercut.com", name: "Dev One" },
      { email: "dev2@pathfindercut.com" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to).toEqual(["dev1@pathfindercut.com", "dev2@pathfindercut.com"]);
    }
  });

  it("treats a developer with a blank email as absent", () => {
    const result = resolveSupportRecipients([{ email: "   " }]);
    expect(result.ok).toBe(false);
  });

  it("never returns ok:true with an empty recipient list", () => {
    // Guards the exact failure mode the brief called out: a caller must
    // never be able to mistake "sent to nobody" for a real success.
    const result = resolveSupportRecipients([{ email: "" }, { email: "   " }]);
    expect(result.ok).toBe(false);
  });
});
