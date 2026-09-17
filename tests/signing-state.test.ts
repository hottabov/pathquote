import { describe, it, expect } from "vitest";
import {
  canSendToClient,
  canRevoke,
  canUnfinalize,
  canComplete,
  canDecline,
  canAuthorSign,
  canAccept,
  canDeleteDocument,
  statusAfterView,
  signatureRolesClearedBy,
  signingStatusLabel,
  NOT_FINAL,
  NO_CONTACT_EMAIL,
  ALREADY_IN_FLIGHT,
  SIGNED_IS_FINAL,
  SIGNED_QUOTE_NOT_DELETABLE,
  NOT_CLIENT_SIGNED,
  NO_MANAGER_SIGNATURE,
} from "../src/lib/signing/state";

const sendable = {
  documentStatus: "FINAL" as const,
  signingStatus: "NOT_SENT" as const,
  contactEmail: "client@example.com",
};

describe("canSendToClient", () => {
  it("allows a FINAL document with a contact email, with no manager signature required (§6.1)", () => {
    expect(canSendToClient(sendable)).toEqual({ ok: true });
  });

  it("refuses a DRAFT document", () => {
    expect(canSendToClient({ ...sendable, documentStatus: "DRAFT" })).toEqual({
      ok: false,
      reason: NOT_FINAL,
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
        contactEmail: null,
      })
    ).toEqual({ ok: false, reason: SIGNED_IS_FINAL });
  });

  it("prefers NOT_FINAL over a missing email", () => {
    expect(
      canSendToClient({
        documentStatus: "DRAFT",
        signingStatus: "NOT_SENT",
        contactEmail: null,
      })
    ).toEqual({ ok: false, reason: NOT_FINAL });
  });

  it("prefers ALREADY_IN_FLIGHT over NOT_FINAL and a missing email", () => {
    // Reachable: canUnfinalize permits unfinalizing a SENT document, so a
    // DRAFT quote with a live client link is a real state, not a contrived
    // one.
    expect(
      canSendToClient({
        documentStatus: "DRAFT",
        signingStatus: "SENT",
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
  it("lets the manager sign a FINAL quote in any order relative to the client", () => {
    // Unconditional now: the two parties sign independently, in any order.
    expect(canAuthorSign()).toBe(true);
  });
});

describe("canAccept", () => {
  it("allows accepting a client-signed quote once the manager has also signed", () => {
    expect(canAccept({ signingStatus: "SIGNED", hasAuthorSignature: true })).toEqual({ ok: true });
  });

  it("refuses until the client has signed", () => {
    for (const signingStatus of ["NOT_SENT", "SENT", "VIEWED", "DECLINED"] as const) {
      expect(canAccept({ signingStatus, hasAuthorSignature: true })).toEqual({
        ok: false,
        reason: NOT_CLIENT_SIGNED,
      });
    }
  });

  it("refuses a client-signed quote the manager hasn't signed, and says why", () => {
    expect(canAccept({ signingStatus: "SIGNED", hasAuthorSignature: false })).toEqual({
      ok: false,
      reason: NO_MANAGER_SIGNATURE,
    });
  });

  it("reports the missing client signature before the missing manager one", () => {
    expect(canAccept({ signingStatus: "NOT_SENT", hasAuthorSignature: false })).toEqual({
      ok: false,
      reason: NOT_CLIENT_SIGNED,
    });
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

describe("canDeleteDocument", () => {
  it.each(["MANAGER", "ADMIN"] as const)(
    "refuses a signed document for %s and says why",
    (role) => {
      expect(canDeleteDocument("SIGNED", role)).toEqual({
        ok: false,
        reason: SIGNED_QUOTE_NOT_DELETABLE,
      });
    }
  );

  it("allows a signed document for DEVELOPER -- the one right DEVELOPER has that ADMIN does not", () => {
    expect(canDeleteDocument("SIGNED", "DEVELOPER")).toEqual({ ok: true });
  });

  it("refuses a signed document for a missing or unrecognised role", () => {
    expect(canDeleteDocument("SIGNED", null)).toEqual({
      ok: false,
      reason: SIGNED_QUOTE_NOT_DELETABLE,
    });
    expect(canDeleteDocument("SIGNED", undefined)).toEqual({
      ok: false,
      reason: SIGNED_QUOTE_NOT_DELETABLE,
    });
    expect(canDeleteDocument("SIGNED", "SOMETHING_ELSE")).toEqual({
      ok: false,
      reason: SIGNED_QUOTE_NOT_DELETABLE,
    });
  });

  it.each(["NOT_SENT", "SENT", "VIEWED", "DECLINED"] as const)(
    "allows every other state (%s) for MANAGER, including a sent-and-ignored or declined quote",
    (status) => {
      expect(canDeleteDocument(status, "MANAGER")).toEqual({ ok: true });
    }
  );

  it.each(["NOT_SENT", "SENT", "VIEWED", "DECLINED"] as const)(
    "allows every other state (%s) for ADMIN",
    (status) => {
      expect(canDeleteDocument(status, "ADMIN")).toEqual({ ok: true });
    }
  );

  it.each(["NOT_SENT", "SENT", "VIEWED", "DECLINED"] as const)(
    "allows every other state (%s) for DEVELOPER",
    (status) => {
      expect(canDeleteDocument(status, "DEVELOPER")).toEqual({ ok: true });
    }
  );
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

describe("signingStatusLabel", () => {
  it("has no label for NOT_SENT -- the ordinary, unlabelled case", () => {
    expect(signingStatusLabel("NOT_SENT")).toBeNull();
  });

  it.each([
    ["SENT", "Sent"],
    ["VIEWED", "Viewed"],
    ["SIGNED", "Signed"],
    ["DECLINED", "Declined"],
  ] as const)("labels %s as %s", (status, label) => {
    expect(signingStatusLabel(status)).toBe(label);
  });
});
