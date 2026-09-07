import { describe, it, expect } from "vitest";
import {
  canSendToClient,
  canRevoke,
  canUnfinalize,
  canComplete,
  canDecline,
  statusAfterView,
  NO_AUTHOR_SIGNATURE,
  NOT_FINAL,
  NO_CONTACT_EMAIL,
  ALREADY_IN_FLIGHT,
  SIGNED_IS_FINAL,
} from "../src/lib/signing/state";

const sendable = {
  documentStatus: "FINAL" as const,
  signingStatus: "NOT_SENT" as const,
  hasAuthorSignature: true,
  contactEmail: "client@example.com",
};

describe("canSendToClient", () => {
  it("allows a FINAL, author-signed document with a contact email", () => {
    expect(canSendToClient(sendable)).toEqual({ ok: true });
  });

  it("refuses a DRAFT document", () => {
    expect(canSendToClient({ ...sendable, documentStatus: "DRAFT" })).toEqual({
      ok: false,
      reason: NOT_FINAL,
    });
  });

  it("refuses when the author has not signed", () => {
    expect(canSendToClient({ ...sendable, hasAuthorSignature: false })).toEqual({
      ok: false,
      reason: NO_AUTHOR_SIGNATURE,
    });
  });

  it("refuses when the contact has no email", () => {
    expect(canSendToClient({ ...sendable, contactEmail: null })).toEqual({
      ok: false,
      reason: NO_CONTACT_EMAIL,
    });
    expect(canSendToClient({ ...sendable, contactEmail: "   " })).toEqual({
      ok: false,
      reason: NO_CONTACT_EMAIL,
    });
  });

  it("refuses when a link is already outstanding", () => {
    for (const signingStatus of ["SENT", "VIEWED"] as const) {
      expect(canSendToClient({ ...sendable, signingStatus })).toEqual({
        ok: false,
        reason: ALREADY_IN_FLIGHT,
      });
    }
  });

  it("refuses a signed document", () => {
    expect(canSendToClient({ ...sendable, signingStatus: "SIGNED" })).toEqual({
      ok: false,
      reason: SIGNED_IS_FINAL,
    });
  });

  it("allows resending after a decline", () => {
    expect(canSendToClient({ ...sendable, signingStatus: "DECLINED" })).toEqual({ ok: true });
  });
});

describe("canRevoke", () => {
  it("is allowed only while a link is outstanding", () => {
    expect(canRevoke("SENT")).toBe(true);
    expect(canRevoke("VIEWED")).toBe(true);
    expect(canRevoke("NOT_SENT")).toBe(false);
    expect(canRevoke("SIGNED")).toBe(false);
    expect(canRevoke("DECLINED")).toBe(false);
  });
});

describe("canUnfinalize", () => {
  it("refuses a signed document and says why", () => {
    expect(canUnfinalize("SIGNED")).toEqual({ ok: false, reason: SIGNED_IS_FINAL });
  });

  it("allows every other state", () => {
    for (const status of ["NOT_SENT", "SENT", "VIEWED", "DECLINED"] as const) {
      expect(canUnfinalize(status)).toEqual({ ok: true });
    }
  });
});

describe("canComplete", () => {
  it("requires an outstanding link and a client signature", () => {
    expect(canComplete("VIEWED", true)).toBe(true);
    expect(canComplete("SENT", true)).toBe(true);
    expect(canComplete("VIEWED", false)).toBe(false);
    expect(canComplete("SIGNED", true)).toBe(false);
    expect(canComplete("DECLINED", true)).toBe(false);
    expect(canComplete("NOT_SENT", true)).toBe(false);
  });
});

describe("canDecline", () => {
  it("stays available after the client has drawn a signature", () => {
    expect(canDecline("VIEWED")).toBe(true);
    expect(canDecline("SENT")).toBe(true);
  });

  it("is unavailable once completed or already declined", () => {
    expect(canDecline("SIGNED")).toBe(false);
    expect(canDecline("DECLINED")).toBe(false);
    expect(canDecline("NOT_SENT")).toBe(false);
  });
});

describe("statusAfterView", () => {
  it("promotes SENT to VIEWED", () => {
    expect(statusAfterView("SENT")).toBe("VIEWED");
  });

  it("leaves every other status untouched", () => {
    for (const status of ["VIEWED", "SIGNED", "DECLINED", "NOT_SENT"] as const) {
      expect(statusAfterView(status)).toBe(status);
    }
  });
});
