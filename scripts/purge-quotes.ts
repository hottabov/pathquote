/**
 * Delete every quote, everywhere it leaves a trace.
 *
 * Used to clear demo and test data off a machine while the tool is still
 * being built. It removes all `Document` rows — which cascades to
 * `DocumentItem`, `DocumentLine`, `DocumentExclusion`, `SigningRequest` and
 * `Signature` — resets the per-region quote numbering, and deletes the files
 * those rows owned: the archived signed PDFs (`Document.signedPdfName`) and
 * the frozen signature images (`Signature.imageUrl`).
 *
 * The files matter as much as the rows. A signing link is dead the moment
 * its `SigningRequest` is gone (the route looks up `tokenHash` and 404s), but
 * the archived PDF it used to serve stays on disk forever otherwise, and the
 * catalogue's own images share the same uuid filename shape — so orphans are
 * indistinguishable from product photos after the fact. They are collected
 * here, before the rows go.
 *
 * NOT touched: the catalogue, users, regions, settings, companies and
 * contacts. Clients are people you met, not quotes you drafted.
 *
 * Usage:
 *   npx tsx scripts/purge-quotes.ts            # dry run, prints what it would do
 *   npx tsx scripts/purge-quotes.ts --yes      # actually delete
 *
 * Afterwards, make production match by re-running
 * scripts/replace-prod-with-local.sh (docs/runbook.md §4b) — that is the
 * intended way to purge the VPS too, rather than running this against a
 * remote database.
 */
import "dotenv/config";
import { unlink } from "node:fs/promises";
import { db } from "../src/lib/db";
import { resolveSignedPdfPath, resolveUploadPath } from "../src/lib/uploads";

const APPLY = process.argv.includes("--yes");

/** `Signature.imageUrl` is stored as the app serves it ("/api/files/<name>"),
 * not as a bare filename. Everything after the last slash is the name
 * `resolveUploadPath` validates; anything that fails that check is left on
 * disk rather than guessed at. */
function fileNameFromUrl(url: string): string | null {
  const name = url.split("/").pop();
  return name && name.length > 0 ? name : null;
}

async function main() {
  const documents = await db.document.findMany({
    select: {
      id: true,
      number: true,
      status: true,
      signedPdfName: true,
      signatures: { select: { imageUrl: true } },
      signingRequests: { select: { id: true } },
    },
  });

  if (documents.length === 0) {
    console.log("No quotes. Nothing to do.");
    return;
  }

  const paths: string[] = [];
  for (const doc of documents) {
    if (doc.signedPdfName) {
      const p = resolveSignedPdfPath(doc.signedPdfName);
      if (p) paths.push(p);
    }
    for (const sig of doc.signatures) {
      const name = fileNameFromUrl(sig.imageUrl);
      const p = name ? resolveUploadPath(name) : null;
      if (p) paths.push(p);
    }
  }

  const links = documents.reduce((n, d) => n + d.signingRequests.length, 0);
  const sequences = await db.numberSequence.count();

  console.log(`Quotes:           ${documents.length}`);
  console.log(`Signing links:    ${links}`);
  console.log(`Files to delete:  ${paths.length} (signed PDFs + signature images)`);
  console.log(`Number sequences: ${sequences} (reset to 0)`);
  for (const doc of documents) {
    console.log(`  - ${doc.number ?? "(draft)"} ${doc.status} ${doc.id}`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --yes to delete.");
    return;
  }

  // Rows first: a file with no row is litter, a row pointing at a missing
  // file is a 500 on a page someone is looking at.
  const deleted = await db.document.deleteMany({});
  await db.numberSequence.deleteMany({});
  console.log(`\nDeleted ${deleted.count} quotes and every row that hung off them.`);

  let removed = 0;
  for (const p of paths) {
    try {
      await unlink(p);
      removed++;
    } catch (err) {
      // ENOENT is the normal case for a machine restored from a dump taken
      // before the file was written, or after a previous partial purge.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  console.log(`Deleted ${removed} files (${paths.length - removed} were already gone).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
