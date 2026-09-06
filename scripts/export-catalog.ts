import "dotenv/config";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { buildCatalogWorkbook, defaultExportPath } from "../src/lib/catalog-xlsx/export";

/**
 * Export the live catalogue to an .xlsx for the director to review
 * (README, Products, Options, Prices). Read-only against the database.
 *
 *   npm run catalog:export
 *   npm run catalog:export -- --out RAW/review.xlsx
 *
 * Default output: RAW/catalog-export-<YYYY-MM-DD>.xlsx. The sheet layout and
 * editing rules are in docs/reference/catalog-import-export.md; the builder
 * itself (snapshot -> workbook) is src/lib/catalog-xlsx/export.ts and the
 * snapshot reader is src/lib/queries/catalog-xlsx.ts -- both shared with the
 * in-app export at Settings -> Import / Export, which is the same workbook.
 */
function parseArgs(argv: string[]): { out: string } {
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      out = argv[++i];
      if (!out) throw new Error("--out needs a path");
    } else if (a.startsWith("--out=")) {
      out = a.slice("--out=".length);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return { out: out ?? defaultExportPath() };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  // Imported lazily so dotenv above runs before src/lib/db reads DATABASE_URL.
  const { db } = await import("../src/lib/db");
  const { loadCatalogSnapshot } = await import("../src/lib/queries/catalog-xlsx");
  let snapshot;
  try {
    snapshot = await loadCatalogSnapshot();
  } finally {
    await db.$disconnect();
  }
  const wb = buildCatalogWorkbook(snapshot);
  mkdirSync(path.dirname(out), { recursive: true });
  XLSX.writeFile(wb, out);
  const prices = snapshot.products.reduce((n, p) => n + Object.keys(p.prices).length, 0) +
    snapshot.options.reduce((n, o) => n + Object.keys(o.prices).length, 0);
  console.log(`wrote ${out}: ${snapshot.products.length} products, ${snapshot.options.length} options, ${prices} prices`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
