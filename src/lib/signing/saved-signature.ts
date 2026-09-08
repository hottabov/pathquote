import { readFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { IMAGE_URL_PATTERN, resolveUploadPath } from "@/lib/uploads";

/**
 * Everything `signQuoteAsAuthor` (src/lib/actions/signing.ts) needs to turn
 * a manager's saved profile signature into bytes it can copy into a fresh
 * upload -- and nothing that would let that column leak into the column it
 * writes.
 *
 * This module exists because a source-text guard over that action
 * (tests/signature-freeze.test.ts, in its first version) was defeated in one
 * edit: assign `user.signatureUrl` to an intermediate variable, then write
 * that variable into `imageUrl`. Tightening the regex is a losing game
 * against an unbounded number of ways to spell the same assignment, so the
 * fix is structural instead: the action no longer selects, reads, or names
 * this column at all. Every function here returns bytes or a reason,
 * never a URL or anything derived from one, so there is nothing
 * URL-shaped left in the action for a future edit to assign into `imageUrl`.
 */

/**
 * Reads the bytes stored behind an already-fetched `User.signatureUrl`
 * value.
 *
 * Validated against `IMAGE_URL_PATTERN` (src/lib/uploads.ts) instead of a
 * bare `.replace("/api/files/", "")` on the stored value: a `.replace` that
 * finds no match is a silent no-op, so a corrupted or hand-edited column
 * would turn into a filename-shaped string built from whatever was actually
 * stored, rather than being rejected outright. Matching first means a
 * malformed value is refused here, with a reason that says so, before
 * anything reaches the filesystem. The pattern is fully anchored (`^...$`),
 * so a successful match's own text is the whole validated string, and
 * slicing the known `/api/files/` prefix off *that* -- rather than off the
 * original, unvalidated value -- is what "extracted from the match" means
 * below.
 *
 * The return type is written out in full below, rather than through a
 * shared alias, because tests/signature-freeze.test.ts checks this exact
 * text: the whole point of this function is that it hands back bytes or a
 * reason and nothing URL-shaped, and that is a claim about its declared
 * shape, not its runtime behaviour.
 */
export async function readSavedSignatureBytes(
  signatureUrl: string
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  const match = signatureUrl.match(IMAGE_URL_PATTERN);
  if (!match) return { ok: false, reason: "Your saved signature could not be read." };
  const filename = match[0].slice("/api/files/".length);

  const path = resolveUploadPath(filename);
  if (!path) return { ok: false, reason: "Your saved signature could not be read." };

  // A stored upload reference can outlive its file -- deleted, the volume
  // wiped, `UPLOADS_DIR` repointed -- exactly the case src/lib/pdf.ts
  // already handles with this same `.catch(() => null)` rather than letting
  // `readFile` throw out of a request.
  const bytes = await readFile(path).catch(() => null);
  if (bytes === null) return { ok: false, reason: "Your saved signature file is missing." };

  return { ok: true, bytes };
}

/**
 * The entry point `signQuoteAsAuthor` actually calls: looks up `userId`'s
 * saved signature and returns its bytes in one step, so that action never
 * has a reason to select the `signatureUrl` column -- or even name it --
 * itself. Kept in this module rather than inlined at the call site so the
 * lookup and the byte-read stay next to each other and next to this file's
 * header comment on why that separation matters.
 */
export async function readMySavedSignatureBytes(
  userId: string
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { signatureUrl: true } });
  if (!user?.signatureUrl) return { ok: false, reason: "You have no saved signature yet." };
  return readSavedSignatureBytes(user.signatureUrl);
}
