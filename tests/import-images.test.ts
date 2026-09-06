import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  formatMd5AsUuid,
  md5UuidFilename,
  distinctImageFiles,
  SERIES_IMAGES,
  PRODUCT_IMAGES,
  ICON_OPTION_TARGETS,
  ICON_PRODUCT_TARGETS,
  UNMAPPED_ICONS,
  distinctIconCodes,
  iconFilename,
  allIconOptionCodes,
  findDuplicateOptionTargets,
} from "../scripts/import-images-lib";
import catalogData from "../prisma/seed-data/catalog.json";
import type { Catalog } from "../prisma/seed-lib";

const OPTION_ICONS_DIR = path.resolve(__dirname, "..", "prisma", "seed-data", "option-icons");
const BRAND_DIR = path.resolve(__dirname, "..", "prisma", "seed-data", "brand");

// Same shape scripts/import-product-images.ts relies on: src/lib/uploads.ts's
// (unexported) UPLOAD_FILENAME_PATTERN. Duplicated here rather than imported
// since it isn't exported -- kept in sync manually, same as that module's own
// IMAGE_URL_PATTERN comment describes for its sibling.
const UPLOAD_FILENAME_PATTERN = /^[a-f0-9-]{36}\.(jpg|png|webp|svg)$/;

describe("formatMd5AsUuid", () => {
  it("inserts dashes at the 8-4-4-4-12 boundaries", () => {
    const hex = "0123456789abcdeffedcba9876543210";
    // 32 hex chars in, 36-char uuid-shaped string out.
    expect(formatMd5AsUuid(hex.slice(0, 32))).toBe("01234567-89ab-cdef-fedc-ba9876543210");
  });

  it("produces a 36-character string from a 32-character digest", () => {
    const hex = "d41d8cd98f00b204e9800998ecf8427e"; // md5("")
    const uuid = formatMd5AsUuid(hex);
    expect(uuid).toHaveLength(36);
    expect(uuid).toBe("d41d8cd9-8f00-b204-e980-0998ecf8427e");
  });
});

describe("md5UuidFilename", () => {
  it("matches the upload-serving filename pattern (uuid + .png)", () => {
    const filename = md5UuidFilename(Buffer.from("hello world"));
    expect(filename).toMatch(UPLOAD_FILENAME_PATTERN);
    expect(filename.endsWith(".png")).toBe(true);
  });

  it("is deterministic: same bytes always produce the same filename", () => {
    const buf = Buffer.from("the quick brown fox");
    expect(md5UuidFilename(buf)).toBe(md5UuidFilename(Buffer.from(buf))); // fresh copy, same bytes
  });

  it("produces different filenames for different content", () => {
    expect(md5UuidFilename(Buffer.from("a"))).not.toBe(md5UuidFilename(Buffer.from("b")));
  });

  it("matches manually computing md5 and formatting it", () => {
    const buf = Buffer.from("PathQuote product image");
    const expectedHex = createHash("md5").update(buf).digest("hex");
    expect(md5UuidFilename(buf)).toBe(`${formatMd5AsUuid(expectedHex)}.png`);
  });

  it("uses the given extension instead of the .png default", () => {
    const buf = Buffer.from("<svg></svg>");
    const filename = md5UuidFilename(buf, "svg");
    expect(filename).toMatch(UPLOAD_FILENAME_PATTERN);
    expect(filename.endsWith(".svg")).toBe(true);
  });
});

describe("distinctImageFiles", () => {
  it("returns every image filename referenced by SERIES_IMAGES or PRODUCT_IMAGES, deduplicated", () => {
    const files = distinctImageFiles();
    const expectedSet = new Set([...Object.values(SERIES_IMAGES), ...Object.values(PRODUCT_IMAGES)]);
    expect(new Set(files)).toEqual(expectedSet);
    // pathworks.png is shared by 8 PRODUCT_IMAGES codes -- must appear once.
    expect(files.filter((f) => f === "pathworks.png")).toHaveLength(1);
  });

  it("is sorted", () => {
    const files = distinctImageFiles();
    expect(files).toEqual([...files].sort());
  });
});

describe("ICON_OPTION_TARGETS / ICON_PRODUCT_TARGETS", () => {
  it("has no duplicate option-code targets across icons", () => {
    // Every option should get its icon from exactly one code -- a code
    // reachable via two icons is a mapping bug, not something the import
    // script should silently pick a winner for.
    expect(findDuplicateOptionTargets()).toEqual([]);
  });

  it("has no duplicate product-code targets across icons", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const codes of Object.values(ICON_PRODUCT_TARGETS)) {
      for (const code of codes) {
        if (seen.has(code)) dupes.push(code);
        else seen.add(code);
      }
    }
    expect(dupes).toEqual([]);
  });

  it("references only icon files that actually exist under prisma/seed-data/option-icons/", () => {
    for (const iconCode of distinctIconCodes()) {
      const filePath = path.join(OPTION_ICONS_DIR, iconFilename(iconCode));
      expect(existsSync(filePath), `missing icon file: ${filePath}`).toBe(true);
    }
  });

  // JTP used to sit in UNMAPPED_ICONS (no catalog option existed for it yet).
  // The "JTP" ("JetPen") option in catalog.json gives it somewhere to map to now.
  it("maps JTP to the new JTP option, and no longer lists it as unmapped", () => {
    expect(ICON_OPTION_TARGETS.JTP).toEqual(["JTP"]);
    expect(UNMAPPED_ICONS).not.toContain("JTP");
    expect(Object.keys(ICON_PRODUCT_TARGETS)).not.toContain("JTP");
  });

  it("every icon file on disk is accounted for by either a target map or UNMAPPED_ICONS", () => {
    // Guards against a 22nd icon silently added to the folder without also
    // updating the maps (or explicitly marking it unmapped).
    const mappedCodes = new Set([
      ...Object.keys(ICON_OPTION_TARGETS),
      ...Object.keys(ICON_PRODUCT_TARGETS),
      ...UNMAPPED_ICONS,
    ]);
    const filesOnDisk = existsSync(OPTION_ICONS_DIR)
      ? readdirSync(OPTION_ICONS_DIR).filter((f: string) => f.endsWith(".svg"))
      : [];
    for (const file of filesOnDisk) {
      const code = file.replace(/\.svg$/, "").toUpperCase();
      expect(mappedCodes.has(code), `icon file "${file}" is neither mapped nor in UNMAPPED_ICONS`).toBe(true);
    }
  });

  it("no PNG icon files remain under prisma/seed-data/option-icons/ (SVG-only now)", () => {
    const filesOnDisk = existsSync(OPTION_ICONS_DIR) ? readdirSync(OPTION_ICONS_DIR) : [];
    expect(filesOnDisk.filter((f: string) => f.endsWith(".png"))).toEqual([]);
  });
});

describe("distinctIconCodes", () => {
  it("returns every icon code referenced by ICON_OPTION_TARGETS or ICON_PRODUCT_TARGETS, deduplicated", () => {
    const codes = distinctIconCodes();
    const expectedSet = new Set([...Object.keys(ICON_OPTION_TARGETS), ...Object.keys(ICON_PRODUCT_TARGETS)]);
    expect(new Set(codes)).toEqual(expectedSet);
    // PRA and PTW each feed both an option target and a product target --
    // must still appear once.
    expect(codes.filter((c) => c === "PRA")).toHaveLength(1);
    expect(codes.filter((c) => c === "PTW")).toHaveLength(1);
  });

  it("is sorted", () => {
    const codes = distinctIconCodes();
    expect(codes).toEqual([...codes].sort());
  });

  it("includes JTP (now mapped, see ICON_OPTION_TARGETS)", () => {
    expect(distinctIconCodes()).toContain("JTP");
  });
});

describe("iconFilename", () => {
  it("lowercases the icon code and appends .svg", () => {
    expect(iconFilename("ABR")).toBe("abr.svg");
    expect(iconFilename("PTW")).toBe("ptw.svg");
  });
});

describe("allIconOptionCodes", () => {
  it("flattens every option code across ICON_OPTION_TARGETS", () => {
    const codes = allIconOptionCodes();
    expect(codes).toContain("ABR-M");
    expect(codes).toContain("MTS-M");
    // Software is never an option in catalogue v2: PRA-L and PTW are gone.
    expect(codes).not.toContain("PRA-L");
    expect(codes).not.toContain("PTW");
    expect(codes.length).toBe(Object.values(ICON_OPTION_TARGETS).flat().length);
  });
});

describe("region brand logo source file", () => {
  it("exists under prisma/seed-data/brand/pf-logo.svg", () => {
    expect(existsSync(path.join(BRAND_DIR, "pf-logo.svg"))).toBe(true);
  });

  it("no PNG brand logo remains under prisma/seed-data/brand/ (SVG-only now)", () => {
    expect(existsSync(path.join(BRAND_DIR, "pf-logo.png"))).toBe(false);
  });
});

describe("image maps <-> catalog.json", () => {
  // The import script matches rows by their current code, so a map key is
  // valid only when catalog.json lists it as a code; a key matching nothing
  // would be silently skipped at import time.
  const catalog = catalogData as Catalog;
  const productCodes = new Set(catalog.series.flatMap((s) => s.products.map((p) => p.code)));
  const optionCodes = new Set(catalog.options.map((o) => o.code));

  it("every PRODUCT_IMAGES / ICON_PRODUCT_TARGETS code is a current product code", () => {
    for (const code of [...Object.keys(PRODUCT_IMAGES), ...Object.values(ICON_PRODUCT_TARGETS).flat()]) {
      expect(productCodes.has(code), code).toBe(true);
    }
  });

  it("every ICON_OPTION_TARGETS code is a current option code", () => {
    for (const code of allIconOptionCodes()) expect(optionCodes.has(code), code).toBe(true);
  });

  it("every SERIES_IMAGES key is a series in catalog.json", () => {
    const series = new Set(catalog.series.map((s) => s.seriesCode));
    for (const code of Object.keys(SERIES_IMAGES)) expect(series.has(code), code).toBe(true);
  });
});
