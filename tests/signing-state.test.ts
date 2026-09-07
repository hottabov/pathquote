import { describe, it, expect } from "vitest";
import {
  canSendToClient,
  canRevoke,
  canUnfinalize,
  canComplete,
  canDecline,
  canAuthorSign,
  statusAfterView,
  signatureRolesClearedBy,
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

  it.each(["SENT", "VIEWED"] as const)(
    "refuses when a link is already outstanding (%s)",
    (signingStatus) => {
      expect(canSendToClient({ ...sendable, signingStatus })).toEqual({
        ok: false,
        reason: ALREADY_IN_FLIGHT,
      });
    }
  );

  it("refuses a signed document", () => {
    expect(canSendToClient({ ...sendable, signingStatus: "SIGNED" })).toEqual({
      ok: false,
      reason: SIGNED_IS_FINAL,
    });
  });

  it("allows resending after a decline", () => {
    expect(canSendToClient({ ...sendable, signingStatus: "DECLINED" })).toEqual({ ok: true });
  });

  it("reports the first problem in priority order, not an arbitrary one", () => {
    // Everything is wrong at once: SIGNED must win over all of it.
    expect(
      canSendToClient({
        documentStatus: "DRAFT",
        signingStatus: "SIGNED",
        hasAuthorSignature: false,
        contactEmail: null,
      })
    ).toEqual({ ok: false, reason: SIGNED_IS_FINAL });
  });

  it("prefers NOT_FINAL over a missing signature and a missing email", () => {
    expect(
      canSendToClient({
        documentStatus: "DRAFT",
        signingStatus: "NOT_SENT",
        hasAuthorSignature: false,
        contactEmail: null,
      })
    ).toEqual({ ok: false, reason: NOT_FINAL });
  });

  it("prefers a missing signature over a missing email", () => {
    expect(
      canSendToClient({
        documentStatus: "FINAL",
        signingStatus: "NOT_SENT",
        hasAuthorSignature: false,
        contactEmail: null,
      })
    ).toEqual({ ok: false, reason: NO_AUTHOR_SIGNATURE });
  });

  it("prefers ALREADY_IN_FLIGHT over NOT_FINAL, a missing signature and a missing email", () => {
    // Reachable: canUnfinalize permits unfinalizing a SENT document, so a
    // DRAFT quote with a live client link is a real state, not a contrived
    // one.
    expect(
      canSendToClient({
        documentStatus: "DRAFT",
        signingStatus: "SENT",
        hasAuthorSignature: false,
        contactEmail: null,
      })
    ).toEqual({ ok: false, reason: ALREADY_IN_FLIGHT });
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

  it.each(["NOT_SENT", "SENT", "VIEWED", "DECLINED"] as const)(
    "allows every other state (%s)",
    (status) => {
      expect(canUnfinalize(status)).toEqual({ ok: true });
    }
  );
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

describe("canAuthorSign", () => {
  it("allows a quote that hasn't been sent yet", () => {
    expect(canAuthorSign("NOT_SENT")).toBe(true);
  });

  it("allows re-signing after the client declined", () => {
    expect(canAuthorSign("DECLINED")).toBe(true);
  });

  it.each(["SENT", "VIEWED", "SIGNED"] as const)(
    "refuses while a link is outstanding or already completed (%s)",
    (status) => {
      expect(canAuthorSign(status)).toBe(false);
    }
  );
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

  it.each(["VIEWED", "SIGNED", "DECLINED", "NOT_SENT"] as const)(
    "leaves %s untouched",
    (status) => {
      expect(statusAfterView(status)).toBe(status);
    }
  );
});

describe("signatureRolesClearedBy", () => {
  it("invalidates both signatures on unfinalize, since the text is about to change", () => {
    const roles = signatureRolesClearedBy("unfinalize");
    expect(roles).toEqual(expect.arrayContaining(["AUTHOR", "CLIENT"]));
    expect(roles).toHaveLength(2);
  });

  it("invalidates only the client signature on revoke, since the document stays FINAL", () => {
    const roles = signatureRolesClearedBy("revoke");
    expect(roles).toEqual(expect.arrayContaining(["CLIENT"]));
    expect(roles).toHaveLength(1);
  });

  it("returns a fresh array each call, not a shared mutable singleton", () => {
    const first = signatureRolesClearedBy("unfinalize");
    first.push("AUTHOR");
    const second = signatureRolesClearedBy("unfinalize");
    expect(second).toHaveLength(2);
  });
});
