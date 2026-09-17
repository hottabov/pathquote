/**
 * Why this exists: the "empty revision" guard in the revisions feature hinges
 * entirely on one property — a manager who unfinalizes and re-finalizes a
 * quote WITHOUT changing anything must produce the same `snapshotHash` as the
 * previous revision, so `finalizeDocument` can recognise "nothing changed" and
 * NOT burn a new revision number. That only holds if two things are true and
 * stay true:
 *
 *   1. the hash depends on commercial content ONLY — never on the database's
 *      row-return order, and never on a per-finalize timestamp/number; and
 *   2. the hash DOES change for any real edit (a price, a quantity, an added
 *      option, a reorder, a changed term, a swapped document).
 *
 * These tests pin both. If someone later folds `issueDate`/`finalizedAt`/the
 * display `number` into the snapshot, the "stable across re-finalize" tests
 * below break — which is the point.
 */
import { describe, it, expect } from "vitest";
import {
  stableStringify,
  hashRevisionSnapshot,
  buildRevisionSnapshot,
  buildAndHashRevisionSnapshot,
  documentToRevisionSnapshotInput,
  REVISION_SNAPSHOT_VERSION,
  type RevisionSnapshotInput,
  type RevisionItemInput,
  type RevisionLineInput,
  type DocumentRowForSnapshot,
} from "@/lib/documents/revision-snapshot";

// --- stableStringify ---------------------------------------------------------

describe("stableStringify", () => {
  it("serialises objects identically regardless of key insertion order", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it("sorts keys at every level of nesting", () => {
    const one = stableStringify({ outer: { z: 1, a: 2 }, first: true });
    const two = stableStringify({ first: true, outer: { a: 2, z: 1 } });
    expect(one).toBe(two);
    expect(one).toBe('{"first":true,"outer":{"a":2,"z":1}}');
  });

  it("preserves array order — order is content", () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it("drops undefined properties so absent and explicitly-undefined hash the same", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it("keeps null, which is a real value distinct from absent", () => {
    expect(stableStringify({ a: null })).toBe('{"a":null}');
    expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
  });

  it("handles primitives, booleans and nested arrays of objects", () => {
    expect(stableStringify("x")).toBe('"x"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(false)).toBe("false");
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });
});

// --- hashRevisionSnapshot ----------------------------------------------------

describe("hashRevisionSnapshot", () => {
  it("returns a 64-char lowercase hex sha256", () => {
    const hash = hashRevisionSnapshot({ hello: "world" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic and independent of key order", () => {
    expect(hashRevisionSnapshot({ a: 1, b: 2 })).toBe(hashRevisionSnapshot({ b: 2, a: 1 }));
  });

  it("changes when any value changes", () => {
    expect(hashRevisionSnapshot({ a: 1 })).not.toBe(hashRevisionSnapshot({ a: 2 }));
  });
});

// --- buildRevisionSnapshot ---------------------------------------------------

const line = (over: Partial<RevisionLineInput> = {}): RevisionLineInput => ({
  itemId: "item-1",
  kind: "OPTION",
  refId: "opt-1",
  code: "OPT-1",
  name: "Extra knife",
  description: null,
  qty: 1,
  unitPrice: "100.00",
  listPrice: "120.00",
  attributes: null,
  showImage: false,
  imageUrl: null,
  sortOrder: 0,
  ...over,
});

const item = (over: Partial<RevisionItemInput> = {}): RevisionItemInput => ({
  code: "M-1000",
  name: "M-Series cutter",
  description: "A cutter",
  unitPrice: "10000.00",
  listPrice: "10000.00",
  discountMode: "PERCENT",
  discountValue: null,
  serialNumber: null,
  showImage: true,
  imageUrl: "/api/files/x.png",
  productionSpec: null,
  sortOrder: 0,
  lines: [line()],
  ...over,
});

const base: RevisionSnapshotInput = {
  currency: "AUD",
  currencySymbol: "$",
  taxName: "GST",
  taxRate: "10.00",
  deliveryTerms: "DELIVERED",
  discountMode: "PERCENT",
  discountValue: null,
  subtotal: "10100.00",
  taxAmount: "1010.00",
  total: "11110.00",
  notes: null,
  showItemPrices: true,
  showOptionPrices: false,
  validityDays: 7,
  deliveryWeeks: 10,
  installationDays: 2,
  trainingDays: 1,
  warrantyMonths: 12,
  heroImageUrl: null,
  client: {
    companyName: "Acme Pty Ltd",
    addressLines: ["1 Test St", "Melbourne VIC 3000"],
    website: "https://acme.example",
    contactFirstName: "Pat",
    contactLastName: "Client",
    contactEmail: "pat@acme.example",
    contactPhone: "+61 400 000 000",
    contactPosition: "Owner",
  },
  entity: {
    entityName: "Pathfinder Australia Pty Ltd",
    entityLegalId: "ABN 64 072 458 667",
    entityAddress: "2 Factory Rd",
    bankDetails: { bsb: "000-000", acc: "12345678" },
    logoUrl: "/api/files/logo.png",
    footerText: "Thank you",
    regionCode: "AU",
  },
  items: [item()],
  documentLines: [],
  documents: [
    { key: "terms", title: "Terms", body: "<p>Terms body</p>" },
    { key: "conditions", title: "General Conditions", body: "<p>Conditions</p>" },
  ],
};

const hashOf = (input: RevisionSnapshotInput) => buildAndHashRevisionSnapshot(input).snapshotHash;

describe("buildRevisionSnapshot", () => {
  it("stamps the snapshot version", () => {
    expect(buildRevisionSnapshot(base).version).toBe(REVISION_SNAPSHOT_VERSION);
  });

  it("produces JSON-serialisable output with no Date objects or Prisma types", () => {
    const snapshot = buildRevisionSnapshot(base);
    // Round-trips cleanly — anything non-JSON (Date, Decimal, undefined leaves)
    // would be lost or altered here and the equality would fail.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("carries no per-finalize identity: no issueDate/finalizedAt/number/revision fields", () => {
    const serialised = stableStringify(buildRevisionSnapshot(base));
    for (const forbidden of ["issueDate", "finalizedAt", "\"number\"", "\"revision\"", "createdAt"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe("hash stability (must match across a no-op re-finalize)", () => {
  it("is identical when the database returns items in a different order", () => {
    const a = item({ code: "AAA-1", sortOrder: 0 });
    const b = item({ code: "BBB-2", sortOrder: 1 });
    expect(hashOf({ ...base, items: [a, b] })).toBe(hashOf({ ...base, items: [b, a] }));
  });

  it("is identical when lines within an item come back in a different order", () => {
    const first = line({ refId: "opt-a", code: "A", sortOrder: 0 });
    const second = line({ refId: "opt-b", code: "B", sortOrder: 1 });
    const forward = item({ lines: [first, second] });
    const reversed = item({ lines: [second, first] });
    expect(hashOf({ ...base, items: [forward] })).toBe(hashOf({ ...base, items: [reversed] }));
  });

  it("is identical when documents come back in a different order", () => {
    const reversed = [...base.documents].reverse();
    expect(hashOf({ ...base, documents: reversed })).toBe(hashOf(base));
  });

  it("is identical for two independently-built inputs with the same content", () => {
    // Simulates unfinalize → (no edit) → finalize: a fresh load of the same
    // quote must hash to the same value as the revision already on file.
    const reload: RevisionSnapshotInput = JSON.parse(JSON.stringify(base));
    expect(hashOf(reload)).toBe(hashOf(base));
  });
});

describe("hash sensitivity (must change for any real edit)", () => {
  it("changes when an item's price is edited", () => {
    expect(hashOf({ ...base, items: [item({ unitPrice: "9999.00" })] })).not.toBe(hashOf(base));
  });

  it("changes when an option line is added", () => {
    const withExtra = item({ lines: [line(), line({ refId: "opt-2", code: "OPT-2", sortOrder: 1 })] });
    expect(hashOf({ ...base, items: [withExtra] })).not.toBe(hashOf(base));
  });

  it("changes when a line's quantity changes", () => {
    expect(hashOf({ ...base, items: [item({ lines: [line({ qty: 3 })] })] })).not.toBe(hashOf(base));
  });

  it("changes when items are genuinely reordered (sortOrder swapped)", () => {
    const a = item({ code: "AAA-1", sortOrder: 0 });
    const b = item({ code: "BBB-2", sortOrder: 1 });
    const swapped = [item({ code: "AAA-1", sortOrder: 1 }), item({ code: "BBB-2", sortOrder: 0 })];
    expect(hashOf({ ...base, items: swapped })).not.toBe(hashOf({ ...base, items: [a, b] }));
  });

  it("changes for the document-level discount, delivery terms, notes and price-display toggles", () => {
    expect(hashOf({ ...base, discountValue: "5.00" })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, deliveryTerms: "EX_WORKS" })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, notes: "Rush order" })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, showOptionPrices: true })).not.toBe(hashOf(base));
  });

  it("changes when a standard-terms figure is overridden", () => {
    expect(hashOf({ ...base, deliveryWeeks: 14 })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, warrantyMonths: 24 })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, validityDays: 30 })).not.toBe(hashOf(base));
  });

  it("changes when the client or contact details change", () => {
    expect(hashOf({ ...base, client: { ...base.client, companyName: "Other Co" } })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, client: { ...base.client, contactEmail: "new@acme.example" } })).not.toBe(
      hashOf(base)
    );
  });

  it("changes when the selling entity snapshot changes (e.g. admin edits region bank details)", () => {
    expect(
      hashOf({ ...base, entity: { ...base.entity, bankDetails: { bsb: "111-111", acc: "99999999" } } })
    ).not.toBe(hashOf(base));
  });

  it("changes when a legal document is excluded (dropped from the array) or its body edited", () => {
    expect(hashOf({ ...base, documents: [base.documents[0]] })).not.toBe(hashOf(base));
    const editedBody = [{ ...base.documents[0], body: "<p>New terms</p>" }, base.documents[1]];
    expect(hashOf({ ...base, documents: editedBody })).not.toBe(hashOf(base));
  });
});

// --- documentToRevisionSnapshotInput ----------------------------------------

const docRow: DocumentRowForSnapshot = {
  currency: "AUD",
  currencySymbol: "$",
  taxName: "GST",
  taxRate: "10.00", // a plain string stands in for a Prisma.Decimal
  deliveryTerms: "DELIVERED",
  discountMode: "PERCENT",
  discountValue: null,
  notes: "hello",
  showItemPrices: true,
  showOptionPrices: false,
  deliveryWeeks: 10,
  installationDays: 2,
  trainingDays: 1,
  warrantyMonths: 12,
  heroImageUrl: "/api/files/hero.png",
  company: {
    name: "Acme Pty Ltd",
    street: "1 Test St",
    city: "Melbourne",
    state: "VIC",
    postcode: "3000",
    country: "Australia",
    website: "https://acme.example",
  },
  contact: {
    firstName: "Pat",
    lastName: "Client",
    email: "pat@acme.example",
    phone: "+61 400 000 000",
    position: "Owner",
  },
  items: [
    {
      code: "M-1000",
      name: "M-Series",
      description: null,
      unitPrice: "10000.00",
      listPrice: "10000.00",
      discountMode: "PERCENT",
      discountValue: null,
      serialNumber: null,
      showImage: true,
      imageUrl: null,
      productionSpec: null,
      sortOrder: 0,
      lines: [
        {
          itemId: "i1",
          kind: "OPTION",
          refId: "o1",
          code: "OPT-1",
          name: "Knife",
          description: null,
          qty: 2,
          unitPrice: "100.00",
          listPrice: null,
          attributes: null,
          showImage: false,
          imageUrl: null,
          sortOrder: 0,
        },
      ],
    },
  ],
  lines: [],
};

const entityRow = {
  entityName: "Pathfinder Australia Pty Ltd",
  entityLegalId: "ABN 64 072 458 667",
  entityAddress: "2 Factory Rd",
  bankDetails: { bsb: "000-000" },
  logoUrl: "/api/files/logo.png",
  footerText: "Thanks",
  regionCode: "AU",
};

const docs = [{ key: "terms", title: "Terms", body: "<p>Terms</p>" }];

describe("documentToRevisionSnapshotInput", () => {
  const mapArgs = {
    document: docRow,
    entity: entityRow,
    totals: { subtotal: "10200.00", taxAmount: "1020.00", total: "11220.00" },
    validityDays: 7,
    documents: docs,
  };

  it("stringifies decimals and passes plain fields through", () => {
    const input = documentToRevisionSnapshotInput(mapArgs);
    expect(input.taxRate).toBe("10.00");
    expect(input.total).toBe("11220.00");
    expect(input.items[0].unitPrice).toBe("10000.00");
    expect(input.items[0].lines[0].unitPrice).toBe("100.00");
    expect(input.items[0].lines[0].qty).toBe(2);
    expect(input.notes).toBe("hello");
    expect(input.heroImageUrl).toBe("/api/files/hero.png");
  });

  it("composes client address lines, collapsing city/state/postcode and skipping empties", () => {
    const input = documentToRevisionSnapshotInput(mapArgs);
    expect(input.client.addressLines).toEqual(["1 Test St", "Melbourne VIC 3000", "Australia"]);
    expect(input.client.contactEmail).toBe("pat@acme.example");
  });

  it("handles a null company/contact without throwing", () => {
    const input = documentToRevisionSnapshotInput({
      ...mapArgs,
      document: { ...docRow, company: null, contact: null },
    });
    expect(input.client.addressLines).toEqual([]);
    expect(input.client.companyName).toBeNull();
    expect(input.client.contactFirstName).toBeNull();
  });

  it("produces a stable hash across two independent maps of the same content", () => {
    const a = buildAndHashRevisionSnapshot(documentToRevisionSnapshotInput(mapArgs)).snapshotHash;
    const reload: typeof mapArgs = JSON.parse(JSON.stringify(mapArgs));
    const b = buildAndHashRevisionSnapshot(documentToRevisionSnapshotInput(reload)).snapshotHash;
    expect(a).toBe(b);
  });
});
